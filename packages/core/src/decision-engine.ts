import { randomUUID } from "node:crypto";
import type { AuthorizationDecision, AuthorizationRequest, AuthorizationResponse, ChoiceAnswer, DecisionProvider, DecisionProviderResponse, NoulAnswer, Reason, RiskClass } from "./contracts.js";
import { runDeterministicRules } from "./deterministic-rules.js";
import { composeFacts, resolveTrustedFacts, type TrustedFactProvider } from "./facts.js";
import type { Policy, ToolPolicy } from "./policy.js";
import { THRESHOLD_PROFILES } from "./policy.js";
import { buildSemanticBattery } from "./semantic-battery.js";
import { buildMinimalState } from "./state-builder.js";

export interface AuthorizationEngineOptions {
  timeoutMs?: number;
  failOpenReadOnly?: boolean;
  /**
   * Server-side providers that resolve deterministic facts the deployment can
   * vouch for. Facts they return override anything the caller claimed, and a
   * tool with `requireTrustedFacts` accepts nothing else.
   */
  factProviders?: readonly TrustedFactProvider[];
}

export class AuthorizationEngine {
  constructor(private readonly provider: DecisionProvider, private readonly options: AuthorizationEngineOptions = {}) {}

  async authorize(req: AuthorizationRequest, policy: Policy): Promise<AuthorizationResponse> {
    const started = performance.now();
    const deterministicStarted = performance.now();
    const tool = policy.tools[req.proposedAction.tool];

    const providers = this.options.factProviders ?? [];
    const { resolved, failures } = providers.length
      ? await resolveTrustedFacts(providers, { request: req, tool })
      : { resolved: [], failures: [] };
    const composedFacts = composeFacts(req.deterministicFacts, resolved);
    const effectiveRequest: AuthorizationRequest = { ...req, deterministicFacts: composedFacts.facts };

    const deterministic = runDeterministicRules(effectiveRequest, tool, { attribution: composedFacts.attribution });
    const deterministicMs = performance.now() - deterministicStarted;
    let effective: AuthorizationDecision;
    let reasons = deterministic.reasons;
    let semantic: Record<string, unknown> | undefined;
    let semanticMs: number | undefined;
    let providerResponse: DecisionProviderResponse | undefined;

    if (deterministic.decision === "BLOCK" || !tool) {
      effective = "BLOCK";
    } else if (deterministic.decision === "REVIEW" && policy.skipSemanticAfterHardReview) {
      effective = "REVIEW";
    } else {
      const semanticStarted = performance.now();
      try {
        providerResponse = await this.provider.evaluate(
          { state: buildMinimalState(effectiveRequest, tool), questions: buildSemanticBattery() },
          { timeoutMs: this.options.timeoutMs ?? 2000 }
        );
        semanticMs = performance.now() - semanticStarted;
        semantic = providerResponse.answers;
        const composed = composeSemanticDecision(providerResponse, tool, policy, req.proposedAction.riskClass);
        effective = deterministic.decision ?? composed.decision;
        reasons = [...reasons, ...composed.reasons];
      } catch (error) {
        semanticMs = performance.now() - semanticStarted;
        effective = failureDecisionForRisk(req.proposedAction.riskClass, this.options.failOpenReadOnly ?? false);
        reasons = [...reasons, { code: providerErrorCode(error), message: "The semantic decision provider was unavailable or returned an invalid response.", source: "SYSTEM" }];
      }
    }

    for (const failure of failures) {
      // A provider that fails contributes no facts, so any rule depending on it
      // has already failed closed above. Record why, so the cause is visible.
      reasons = [...reasons, { code: "FACT_PROVIDER_UNAVAILABLE", message: `Trusted fact provider "${failure.provider}" failed: ${failure.message}`, source: "SYSTEM" }];
    }
    if (reasons.length === 0) reasons = [{ code: "POLICY_SATISFIED", message: "Deterministic and semantic policy checks passed.", source: "SYSTEM" }];
    const mode = req.mode;
    const decision = mode === "shadow" ? "ALLOW" : effective;
    return {
      requestId: req.requestId,
      decisionId: randomUUID(),
      decision,
      mode,
      ...(mode === "shadow" ? { wouldHaveDecision: effective } : {}),
      riskClass: tool?.riskClass ?? req.proposedAction.riskClass,
      reasons,
      signals: { deterministic: deterministic.signals, ...(semantic ? { semantic } : {}) },
      ...(providerResponse ? { model: {
        provider: providerResponse.provider,
        requestedModel: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
        resolvedModel: providerResponse.model,
        ...(providerResponse.usage ? { usage: providerResponse.usage } : {})
      } } : {}),
      timing: { totalMs: performance.now() - started, deterministicMs, ...(semanticMs != null ? { semanticMs } : {}) },
      policy: { id: policy.id, version: policy.version },
      createdAt: new Date().toISOString()
    };
  }
}

function composeSemanticDecision(response: DecisionProviderResponse, tool: ToolPolicy, policy: Policy, risk: RiskClass): { decision: AuthorizationDecision; reasons: Reason[] } {
  const t = THRESHOLD_PROFILES[tool.thresholdProfile];
  const noul = (key: string): number => {
    const answer = response.answers[key];
    if (!answer || answer.type !== "noul") throw new Error(`JEV_MISSING_ANSWER:${key}`);
    return (answer as NoulAnswer).noul;
  };
  const choice = response.answers.alignment;
  if (!choice || choice.type !== "choice") throw new Error("JEV_MISSING_ANSWER:alignment");
  const alignment = choice as ChoiceAnswer;
  const reasons: Reason[] = [];
  const block = (code: string, message: string) => reasons.push({ code, message, source: "JEV" });
  if (noul("unnecessary_sensitive_exposure") >= t.sensitiveExposureBlockAt) block("SEMANTIC_SENSITIVE_EXPOSURE", "The action appears to expose sensitive data unnecessarily.");
  if (noul("violates_semantic_policy") >= t.policyViolationBlockAt) block("SEMANTIC_POLICY_CONFLICT", "The action appears to conflict with a semantic policy statement.");
  if (noul("materially_expands_scope") >= t.scopeExpansionBlockAt) block("SEMANTIC_SCOPE_EXPANSION", "The action appears to expand materially beyond the supplied user intent.");
  if (reasons.length) return { decision: "BLOCK", reasons };
  if (noul("missing_required_intent") >= t.missingIntentReviewAt) return { decision: "REVIEW", reasons: [{ code: "MISSING_SEMANTIC_AUTHORIZATION", message: "The exact action needs additional user intent or confirmation.", source: "JEV" }] };
  if (!["exact", "narrower"].includes(alignment.choice) || alignment.confidence < t.alignmentMinConfidence) return { decision: "REVIEW", reasons: [{ code: "SEMANTIC_ALIGNMENT_UNCERTAIN", message: "The action is not confidently aligned with the user's explicit request.", source: "JEV" }] };
  if (noul("target_matches_intent") < t.targetYesMin) return { decision: "REVIEW", reasons: [{ code: "TARGET_ALIGNMENT_UNCERTAIN", message: "The selected target or recipient is not sufficiently supported by the user's request.", source: "JEV" }] };
  if (policy.requireHumanForRisk?.includes(risk)) return { decision: "REVIEW", reasons: [{ code: "HUMAN_REVIEW_REQUIRED", message: "Policy requires human review for this risk class.", source: "DETERMINISTIC" }] };
  return { decision: "ALLOW", reasons: [] };
}

export function failureDecisionForRisk(risk: RiskClass, failOpenReadOnly = false): AuthorizationDecision {
  if (risk === "READ_ONLY") return failOpenReadOnly ? "ALLOW" : "REVIEW";
  if (risk === "REVERSIBLE_WRITE" || risk === "EXTERNAL_COMMUNICATION") return "REVIEW";
  return "BLOCK";
}

const providerErrorCode = (error: unknown): string => error instanceof Error && /^JEV_[A-Z_]+/.test(error.message) ? error.message.split(":")[0]! : "JEV_PROVIDER_ERROR";
