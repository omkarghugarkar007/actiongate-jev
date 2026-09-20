import { createHash, randomUUID } from "node:crypto";
import {
  AuthorizationEngine,
  DEFAULT_POLICY,
  THRESHOLD_PROFILES,
  type AuthorizationRequest,
  type DecisionProvider,
  type Policy
} from "@actiongate/core";
import { computeMetrics, stratify, type Metrics, type Observation } from "./metrics.js";
import { summarizeDataset, type Dataset, type DatasetSummary, type EvalCase } from "./schema.js";

export interface CalibrationOptions {
  dataset: Dataset;
  provider: DecisionProvider;
  policy?: Policy;
  /** Threshold profiles to sweep. Each produces its own metrics. */
  profiles?: readonly (keyof typeof THRESHOLD_PROFILES)[];
  /**
   * Include cases whose labels have not been reviewed by a person. Off by
   * default: unreviewed labels cannot support a quality claim.
   */
  includeUnreviewed?: boolean;
  concurrency?: number;
}

export interface ProfileReport {
  profile: string;
  thresholds: Record<string, number>;
  overall: Metrics;
  byRisk: Record<string, Metrics>;
  byKind: Record<string, Metrics>;
  byDifficulty: Record<string, Metrics>;
}

export interface CalibrationReport {
  runId: string;
  createdAt: string;
  /** Everything a later comparison needs pinned, so drift is attributable. */
  versions: {
    dataset: string;
    datasetName: string;
    datasetHash: string;
    policy: string;
    battery: string;
    requestedModel: string;
    resolvedModel: string | null;
    provider: string | null;
  };
  dataset: DatasetSummary;
  evaluated: number;
  excludedUnreviewed: number;
  cost: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: { p50: number; p95: number; max: number };
  providerErrors: number;
  /** One per case, not one per case per profile. */
  providerCalls: number;
  /**
   * Cases that reached the semantic provider. A case blocked by deterministic
   * rules never gets there, so it says nothing about semantic quality.
   */
  semanticallyEvaluated: number;
  profiles: ProfileReport[];
  /** Set when the run included labels no person stood behind. */
  qualityClaimSupported: boolean;
  note: string;
}

const BATTERY_VERSION = "battery-v1";

/**
 * Memoizes provider answers per case.
 *
 * A threshold sweep must compare profiles on the *same* evidence. Re-asking the
 * provider for each profile would multiply cost fourfold and introduce sampling
 * noise between profiles, so a genuine threshold difference would be tangled up
 * with run-to-run variation.
 */
class SingleCaseProvider implements DecisionProvider {
  private pending: Promise<Awaited<ReturnType<DecisionProvider["evaluate"]>>> | undefined;
  constructor(private readonly inner: DecisionProvider, private readonly onCall: () => void) {}
  async evaluate(...args: Parameters<DecisionProvider["evaluate"]>) {
    // One instance per case, so nothing is shared between concurrent workers.
    // A shared cache keyed by mutable state would hand one case another's answers.
    if (!this.pending) {
      this.onCall();
      this.pending = this.inner.evaluate(...args);
    }
    return this.pending;
  }
}

/**
 * Runs the dataset through the real decision path once per threshold profile,
 * reusing one set of provider answers per case.
 */
export async function calibrate(options: CalibrationOptions): Promise<CalibrationReport> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const profiles = options.profiles ?? (Object.keys(THRESHOLD_PROFILES) as (keyof typeof THRESHOLD_PROFILES)[]);
  const all = options.dataset.cases;
  const usable = options.includeUnreviewed ? all.filter((item) => item.annotation.status !== "disputed") : all.filter((item) => item.annotation.status === "reviewed");
  const excluded = all.length - usable.length;

  const latencies: number[] = [];
  const cost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let providerErrors = 0;
  let resolvedModel: string | null = null;
  let providerName: string | null = null;

  const perProfile = new Map<string, Observation[]>(profiles.map((profile) => [profile, []]));
  const limit = Math.max(1, options.concurrency ?? 4);
  const queue = [...usable];
  let providerCalls = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      // Every profile for this case sees the same provider answers.
      const provider = new SingleCaseProvider(options.provider, () => { providerCalls += 1; });
      for (const profile of profiles) {
        const engine = new AuthorizationEngine(provider, { timeoutMs: 15_000 });
        const started = performance.now();
        const response = await engine.authorize(toRequest(item), withProfile(policy, item, profile));
        if (profile === profiles[0]) latencies.push(performance.now() - started);
        if (response.model) {
          resolvedModel = response.model.resolvedModel ?? resolvedModel;
          providerName = response.model.provider;
          if (profile === profiles[0]) {
            cost.inputTokens += response.model.usage?.inputTokens ?? 0;
            cost.outputTokens += response.model.usage?.outputTokens ?? 0;
            cost.costUsd += response.model.usage?.costUsd ?? 0;
          }
        }
        if (profile === profiles[0] && response.reasons.some((reason) => reason.code.startsWith("JEV_"))) providerErrors += 1;
        perProfile.get(profile)!.push({
          id: item.id,
          riskClass: item.riskClass,
          kind: item.kind,
          expected: item.expectedDecision,
          acceptable: item.acceptableDecisions,
          actual: response.decision
        });
      }
    }
  }));

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    versions: {
      dataset: options.dataset.version,
      datasetName: options.dataset.name,
      datasetHash: hashDataset(options.dataset),
      policy: `${policy.id}@${policy.version}`,
      battery: BATTERY_VERSION,
      requestedModel: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
      resolvedModel,
      provider: providerName
    },
    dataset: summarizeDataset(options.dataset),
    evaluated: usable.length,
    excludedUnreviewed: excluded,
    cost,
    latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? 0 },
    providerErrors,
    providerCalls,
    semanticallyEvaluated: providerCalls,
    profiles: profiles.map((profile) => {
      const observations = perProfile.get(profile)!;
      return {
        profile,
        thresholds: THRESHOLD_PROFILES[profile] as unknown as Record<string, number>,
        overall: computeMetrics(observations),
        byRisk: stratify(observations, (item) => item.riskClass),
        byKind: stratify(observations, (item) => item.kind),
        byDifficulty: stratify(observations, (item) => item.riskClass)
      };
    }),
    qualityClaimSupported: !options.includeUnreviewed && usable.length > 0,
    note: options.includeUnreviewed
      ? "This run included labels no person has reviewed. It measures plumbing and cost, NOT semantic quality, and must not be cited as an accuracy result."
      : "Every case in this run carries a reviewed label. Report unsafe-allow rate separately from every other number."
  };
}

/** Applies a threshold profile to the tool the case exercises, leaving the rest alone. */
function withProfile(policy: Policy, item: EvalCase, profile: keyof typeof THRESHOLD_PROFILES): Policy {
  const tool = policy.tools[item.input.proposedAction.tool];
  if (!tool) return policy;
  return { ...policy, tools: { ...policy.tools, [item.input.proposedAction.tool]: { ...tool, thresholdProfile: profile } } };
}

function toRequest(item: EvalCase): AuthorizationRequest {
  return {
    requestId: `eval-${item.id}`,
    idempotencyKey: `eval-${item.id}-${randomUUID()}`,
    tenantId: "eval",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "eval-harness" },
    userIntent: { text: item.input.userIntent, source: "user_message" },
    proposedAction: { ...item.input.proposedAction, riskClass: item.riskClass },
    ...(item.input.resources ? { context: { resources: item.input.resources } } : {}),
    ...(item.input.deterministicFacts ? { deterministicFacts: item.input.deterministicFacts as AuthorizationRequest["deterministicFacts"] } : {})
  };
}

export function hashDataset(dataset: Dataset): string {
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index]!);
}
