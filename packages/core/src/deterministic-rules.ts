import type { AuthorizationRequest, AuthorizationDecision, Reason } from "./contracts.js";
import type { FactAttribution, FactName } from "./facts.js";
import type { ToolPolicy } from "./policy.js";

export interface RuleResult {
  decision?: Exclude<AuthorizationDecision, "ALLOW">;
  reasons: Reason[];
  signals: Record<string, boolean | number | string | null>;
}

export interface RuleContext {
  /** Where each supplied fact came from. Facts with no entry are treated as caller-supplied. */
  attribution?: Partial<Record<FactName, FactAttribution>>;
  now?: number;
}

const messages: Record<string, string> = {
  AUTH_REQUIRED: "The action requires an authenticated user.",
  RBAC_DENIED: "The actor is not authorized for this operation.",
  TOOL_NOT_ALLOWED: "The requested tool is not enabled by policy.",
  OPERATION_NOT_ALLOWED: "The requested operation does not match the registered tool operation.",
  DUPLICATE_ACTION: "A duplicate action was detected.",
  RESOURCE_NOT_FOUND: "The requested resource does not exist.",
  AMOUNT_EXCEEDS_LIMIT: "The exact amount exceeds the configured policy limit.",
  INVALID_CURRENCY: "The currency is not permitted by policy.",
  DESTINATION_NOT_ALLOWED: "The destination is not allowlisted.",
  RISK_CLASS_MISMATCH: "The supplied risk class does not match the server-owned tool registry.",
  AUTH_FACT_MISSING: "The tool requires an authenticated user but no authentication fact was supplied.",
  RBAC_FACT_MISSING: "The tool requires an authorization check but no RBAC fact was supplied.",
  DUPLICATE_FACT_MISSING: "The tool denies duplicates but no duplicate-check fact was supplied.",
  AMOUNT_FACT_MISSING: "The tool has an amount limit but no trusted amount was supplied.",
  CURRENCY_FACT_MISSING: "The tool restricts currencies but no trusted currency was supplied.",
  DESTINATION_FACT_MISSING: "The tool requires an allowlisted destination but no allowlist fact was supplied."
};

/** A fact is only usable if it is present, trusted enough for the tool, and fresh enough. */
type FactStatus = "ok" | "absent" | "untrusted" | "stale";

export function runDeterministicRules(req: AuthorizationRequest, tool: ToolPolicy | undefined, context: RuleContext = {}): RuleResult {
  const hits: Array<{ code: string; decision: "BLOCK" | "REVIEW"; message?: string }> = [];
  const facts = req.deterministicFacts ?? {};
  const attribution = context.attribution ?? {};
  const requireTrusted = tool?.hardRules?.requireTrustedFacts === true;
  const maxAgeMs = tool?.hardRules?.maxFactAgeSeconds != null ? tool.hardRules.maxFactAgeSeconds * 1000 : undefined;
  const now = context.now ?? Date.now();

  const statusOf = (name: FactName): FactStatus => {
    if (facts[name] === undefined) return "absent";
    if (!requireTrusted) return "ok";
    const record = attribution[name];
    // With no attribution the fact can only have come from the caller.
    if (!record || record.provenance !== "trusted") return "untrusted";
    if (maxAgeMs == null) return "ok";
    const observed = record.observedAt ? Date.parse(record.observedAt) : Number.NaN;
    if (!Number.isFinite(observed) || now - observed > maxAgeMs) return "stale";
    return "ok";
  };

  /** Runs a hard rule only when its fact is usable, and explains why if it is not. */
  const withFact = (name: FactName, missingCode: string, check: () => void) => {
    const status = statusOf(name);
    if (status === "ok") return check();
    if (status === "absent") return void hits.push({ code: missingCode, decision: "BLOCK" });
    if (status === "untrusted") {
      return void hits.push({
        code: "FACT_NOT_TRUSTED",
        decision: "BLOCK",
        message: `The tool requires server-resolved facts, but "${name}" was asserted by the caller.`
      });
    }
    return void hits.push({
      code: "FACT_STALE",
      decision: "BLOCK",
      message: `The trusted fact "${name}" is older than the tool's maximum fact age.`
    });
  };

  if (!tool?.enabled) hits.push({ code: "TOOL_NOT_ALLOWED", decision: "BLOCK" });
  if (tool && req.proposedAction.operation !== tool.operation) hits.push({ code: "OPERATION_NOT_ALLOWED", decision: "BLOCK" });
  if (tool && req.proposedAction.riskClass !== tool.riskClass) hits.push({ code: "RISK_CLASS_MISMATCH", decision: "BLOCK" });

  // A configured hard rule must be affirmatively satisfied. An absent, untrusted,
  // or stale fact means the control could not be evaluated, which fails closed
  // rather than passing: "require RBAC" must never be satisfied by silence, and
  // when the tool requires trusted facts it must not be satisfied by the caller
  // vouching for itself either.
  if (tool?.hardRules?.requireAuthenticatedUser) {
    withFact("authenticated", "AUTH_FACT_MISSING", () => {
      if (facts.authenticated !== true) hits.push({ code: "AUTH_REQUIRED", decision: "BLOCK" });
    });
  }
  if (tool?.hardRules?.requireRbac) {
    withFact("authorizedByRbac", "RBAC_FACT_MISSING", () => {
      if (facts.authorizedByRbac !== true) hits.push({ code: "RBAC_DENIED", decision: "BLOCK" });
    });
  }
  if (tool?.hardRules?.denyDuplicate) {
    withFact("duplicate", "DUPLICATE_FACT_MISSING", () => {
      if (facts.duplicate !== false) hits.push({ code: "DUPLICATE_ACTION", decision: "BLOCK" });
    });
  }
  if (facts.resourceExists === false) hits.push({ code: "RESOURCE_NOT_FOUND", decision: "BLOCK" });
  if (tool?.hardRules?.maxAmountCents != null) {
    const limit = tool.hardRules.maxAmountCents;
    withFact("amountCents", "AMOUNT_FACT_MISSING", () => {
      if ((facts.amountCents ?? 0) > limit) hits.push({ code: "AMOUNT_EXCEEDS_LIMIT", decision: "BLOCK" });
    });
  }
  if (tool?.hardRules?.allowedCurrencies) {
    const allowed = tool.hardRules.allowedCurrencies;
    withFact("currency", "CURRENCY_FACT_MISSING", () => {
      if (!facts.currency || !allowed.includes(facts.currency)) hits.push({ code: "INVALID_CURRENCY", decision: "BLOCK" });
    });
  }
  if (tool?.hardRules?.requireAllowlistedDestination) {
    withFact("destinationAllowlisted", "DESTINATION_FACT_MISSING", () => {
      if (facts.destinationAllowlisted !== true) hits.push({ code: "DESTINATION_NOT_ALLOWED", decision: "BLOCK" });
    });
  }

  const decision = hits.some((x) => x.decision === "BLOCK") ? "BLOCK" : hits[0]?.decision;
  return {
    ...(decision ? { decision } : {}),
    reasons: hits.map(({ code, message }) => ({ code, message: message ?? messages[code] ?? code, source: "DETERMINISTIC" })),
    signals: {
      authenticated: facts.authenticated ?? null,
      authorizedByRbac: facts.authorizedByRbac ?? null,
      duplicate: facts.duplicate ?? null,
      amountCents: facts.amountCents ?? null,
      resourceExists: facts.resourceExists ?? null,
      // Provenance is part of the evidence: an operator must be able to see
      // which facts the deployment vouched for and which the caller claimed.
      factProvenance: summarizeProvenance(facts, attribution)
    }
  };
}

function summarizeProvenance(
  facts: NonNullable<AuthorizationRequest["deterministicFacts"]>,
  attribution: Partial<Record<FactName, FactAttribution>>
): string {
  const entries = Object.keys(facts)
    .filter((name) => facts[name as FactName] !== undefined)
    .sort()
    .map((name) => `${name}=${attribution[name as FactName]?.source ?? "caller"}`);
  return entries.length ? entries.join(",") : "none";
}
