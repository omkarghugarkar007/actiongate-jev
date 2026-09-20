import type { AuthorizationRequest } from "./contracts.js";
import type { ToolPolicy } from "./policy.js";

export type DeterministicFacts = NonNullable<AuthorizationRequest["deterministicFacts"]>;

/** Every deterministic fact a hard rule can depend on. */
export const FACT_NAMES = [
  "authenticated",
  "authorizedByRbac",
  "duplicate",
  "amountCents",
  "currency",
  "destinationAllowlisted",
  "resourceExists"
] as const;
export type FactName = typeof FACT_NAMES[number];

/**
 * `caller` facts are asserted by whoever called the API. They are untrusted
 * input: an agent that can reach ActionGate can claim its own RBAC. `trusted`
 * facts were resolved server-side by a provider the deployment operates.
 */
export type FactProvenance = "caller" | "trusted";

export interface FactAttribution {
  provenance: FactProvenance;
  /** `caller`, or the name of the provider that resolved the fact. */
  source: string;
  /** When the provider observed the value. Absent for caller-supplied facts. */
  observedAt?: string;
}

export interface ResolvedFactSet {
  provider: string;
  facts: DeterministicFacts;
  /** Defaults to resolution time when a provider does not report it. */
  observedAt?: string;
}

export interface TrustedFactProvider {
  readonly name: string;
  /**
   * Resolve whatever facts this provider can vouch for. Returning `undefined`
   * or omitting a fact is normal; it simply means this provider has nothing to
   * say about it.
   */
  resolve(input: { request: AuthorizationRequest; tool: ToolPolicy | undefined }): Promise<ResolvedFactSet | undefined>;
}

export interface ComposedFacts {
  facts: DeterministicFacts;
  attribution: Partial<Record<FactName, FactAttribution>>;
}

/**
 * Merges caller-supplied facts with provider-resolved ones. A trusted fact
 * always wins over the caller's claim about the same thing, and later providers
 * win over earlier ones, so the most specific provider is registered last.
 */
export function composeFacts(
  callerFacts: DeterministicFacts | undefined,
  resolved: readonly ResolvedFactSet[] = []
): ComposedFacts {
  const facts: Record<string, unknown> = {};
  const attribution: Partial<Record<FactName, FactAttribution>> = {};

  for (const name of FACT_NAMES) {
    const value = callerFacts?.[name];
    if (value === undefined) continue;
    facts[name] = value;
    attribution[name] = { provenance: "caller", source: "caller" };
  }

  for (const set of resolved) {
    const observedAt = set.observedAt ?? new Date().toISOString();
    for (const name of FACT_NAMES) {
      const value = set.facts?.[name];
      if (value === undefined) continue;
      facts[name] = value;
      attribution[name] = { provenance: "trusted", source: set.provider, observedAt };
    }
  }

  return { facts: facts as DeterministicFacts, attribution };
}

/** Runs every provider, tolerating individual failures so one bad adapter cannot
 * take authorization down. A provider that throws simply contributes no facts,
 * which leaves the rule it would have satisfied unevaluable and therefore closed. */
export async function resolveTrustedFacts(
  providers: readonly TrustedFactProvider[],
  input: { request: AuthorizationRequest; tool: ToolPolicy | undefined }
): Promise<{ resolved: ResolvedFactSet[]; failures: { provider: string; message: string }[] }> {
  const resolved: ResolvedFactSet[] = [];
  const failures: { provider: string; message: string }[] = [];
  for (const provider of providers) {
    try {
      const set = await provider.resolve(input);
      if (set) resolved.push({ ...set, provider: set.provider || provider.name });
    } catch (error) {
      failures.push({ provider: provider.name, message: error instanceof Error ? error.message : "fact provider failed" });
    }
  }
  return { resolved, failures };
}
