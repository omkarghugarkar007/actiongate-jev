import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, runDeterministicRules, type AuthorizationRequest } from "../src/index.js";

const refundPolicy = DEFAULT_POLICY.tools.refund_payment!;

function refundRequest(deterministicFacts?: AuthorizationRequest["deterministicFacts"]): AuthorizationRequest {
  return {
    requestId: "req-1",
    idempotencyKey: "idem-key-0001",
    tenantId: "tenant-1",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "agent" },
    userIntent: { text: "refund my duplicate charge", source: "user_message" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { amountCents: 4900 }, riskClass: "FINANCIAL" },
    ...(deterministicFacts ? { deterministicFacts } : {})
  };
}

const satisfied = { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" } as const;

describe("hard rules are satisfied affirmatively, never by silence", () => {
  it("blocks when no deterministic facts are supplied at all", () => {
    const result = runDeterministicRules(refundRequest(), refundPolicy);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "AUTH_FACT_MISSING",
      "RBAC_FACT_MISSING",
      "DUPLICATE_FACT_MISSING",
      "AMOUNT_FACT_MISSING",
      "CURRENCY_FACT_MISSING"
    ]);
  });

  it("allows only when every configured rule is affirmatively satisfied", () => {
    expect(runDeterministicRules(refundRequest(satisfied), refundPolicy).decision).toBeUndefined();
  });

  it.each([
    ["authenticated", "AUTH_FACT_MISSING"],
    ["authorizedByRbac", "RBAC_FACT_MISSING"],
    ["duplicate", "DUPLICATE_FACT_MISSING"],
    ["amountCents", "AMOUNT_FACT_MISSING"],
    ["currency", "CURRENCY_FACT_MISSING"]
  ] as const)("blocks when %s alone is omitted", (omitted, code) => {
    const facts: Record<string, unknown> = { ...satisfied };
    delete facts[omitted];
    const result = runDeterministicRules(refundRequest(facts as AuthorizationRequest["deterministicFacts"]), refundPolicy);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toContain(code);
  });

  it("still distinguishes an explicit denial from an unverifiable control", () => {
    const denied = runDeterministicRules(refundRequest({ ...satisfied, authorizedByRbac: false }), refundPolicy);
    expect(denied.reasons.map((reason) => reason.code)).toContain("RBAC_DENIED");
    expect(denied.reasons.map((reason) => reason.code)).not.toContain("RBAC_FACT_MISSING");
  });

  it("leaves a tool without hard rules free of fact requirements", () => {
    const readOnly = runDeterministicRules(
      { ...refundRequest(), proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "1" }, riskClass: "READ_ONLY" } },
      DEFAULT_POLICY.tools.get_order!
    );
    expect(readOnly.decision).toBeUndefined();
  });
});
