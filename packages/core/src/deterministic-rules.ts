import type { AuthorizationRequest, AuthorizationDecision, Reason } from "./contracts.js";
import type { ToolPolicy } from "./policy.js";

export interface RuleResult {
  decision?: Exclude<AuthorizationDecision, "ALLOW">;
  reasons: Reason[];
  signals: Record<string, boolean | number | string | null>;
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
  RISK_CLASS_MISMATCH: "The supplied risk class does not match the server-owned tool registry."
};

export function runDeterministicRules(req: AuthorizationRequest, tool: ToolPolicy | undefined): RuleResult {
  const hits: Array<{ code: string; decision: "BLOCK" | "REVIEW" }> = [];
  const facts = req.deterministicFacts ?? {};
  if (!tool?.enabled) hits.push({ code: "TOOL_NOT_ALLOWED", decision: "BLOCK" });
  if (tool && req.proposedAction.operation !== tool.operation) hits.push({ code: "OPERATION_NOT_ALLOWED", decision: "BLOCK" });
  if (tool && req.proposedAction.riskClass !== tool.riskClass) hits.push({ code: "RISK_CLASS_MISMATCH", decision: "BLOCK" });
  if (tool?.hardRules?.requireAuthenticatedUser && facts.authenticated === false) hits.push({ code: "AUTH_REQUIRED", decision: "BLOCK" });
  if (tool?.hardRules?.requireRbac && facts.authorizedByRbac === false) hits.push({ code: "RBAC_DENIED", decision: "BLOCK" });
  if (tool?.hardRules?.denyDuplicate && facts.duplicate === true) hits.push({ code: "DUPLICATE_ACTION", decision: "BLOCK" });
  if (facts.resourceExists === false) hits.push({ code: "RESOURCE_NOT_FOUND", decision: "BLOCK" });
  if (tool?.hardRules?.maxAmountCents != null && facts.amountCents != null && facts.amountCents > tool.hardRules.maxAmountCents) hits.push({ code: "AMOUNT_EXCEEDS_LIMIT", decision: "BLOCK" });
  if (facts.currency && tool?.hardRules?.allowedCurrencies && !tool.hardRules.allowedCurrencies.includes(facts.currency)) hits.push({ code: "INVALID_CURRENCY", decision: "BLOCK" });
  if (tool?.hardRules?.requireAllowlistedDestination && facts.destinationAllowlisted === false) hits.push({ code: "DESTINATION_NOT_ALLOWED", decision: "BLOCK" });
  const decision = hits.some((x) => x.decision === "BLOCK") ? "BLOCK" : hits[0]?.decision;
  return {
    ...(decision ? { decision } : {}),
    reasons: hits.map(({ code }) => ({ code, message: messages[code] ?? code, source: "DETERMINISTIC" })),
    signals: {
      authenticated: facts.authenticated ?? null,
      authorizedByRbac: facts.authorizedByRbac ?? null,
      duplicate: facts.duplicate ?? null,
      amountCents: facts.amountCents ?? null,
      resourceExists: facts.resourceExists ?? null
    }
  };
}

