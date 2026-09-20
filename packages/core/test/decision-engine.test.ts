import { describe, expect, it } from "vitest";
import { AuthorizationEngine, DEFAULT_POLICY, actionFingerprint, buildMinimalState, failureDecisionForRisk, redactSecrets, type AuthorizationRequest } from "../src/index.js";
import { FakeDecisionProvider } from "../../decision-provider/src/index.js";

const request = (overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  requestId: "req-1", idempotencyKey: "idem-key-001", tenantId: "tenant-1", environment: "development", mode: "enforce",
  actor: { agentId: "support" }, userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" },
  proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_duplicate", amountCents: 4900 }, riskClass: "FINANCIAL" },
  deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD", resourceExists: true },
  ...overrides
});

describe("AuthorizationEngine", () => {
  it("allows a supported action", async () => expect((await new AuthorizationEngine(FakeDecisionProvider.allow()).authorize(request(), DEFAULT_POLICY)).decision).toBe("ALLOW"));
  it("records provider-reported token usage and cost", async () => {
    const result = await new AuthorizationEngine(FakeDecisionProvider.allow()).authorize(request(), DEFAULT_POLICY);
    expect(result.model?.provider).toBe("fake");
    expect(result.model?.usage?.inputTokens).toBe(100);
  });
  it("blocks an exact numeric limit violation before Jev", async () => {
    const provider = FakeDecisionProvider.allow();
    const result = await new AuthorizationEngine(provider).authorize(request({ deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 49_000, currency: "USD" } }), DEFAULT_POLICY);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons[0]?.code).toBe("AMOUNT_EXCEEDS_LIMIT");
    expect(provider.calls).toBe(0);
  });
  it("blocks semantic scope expansion", async () => expect((await new AuthorizationEngine(FakeDecisionProvider.scopeExpansion()).authorize(request(), DEFAULT_POLICY)).decision).toBe("BLOCK"));
  it("routes missing intent to review", async () => expect((await new AuthorizationEngine(FakeDecisionProvider.missingIntent()).authorize(request(), DEFAULT_POLICY)).decision).toBe("REVIEW"));
  it("fails closed for financial provider errors", async () => expect((await new AuthorizationEngine(FakeDecisionProvider.error()).authorize(request(), DEFAULT_POLICY)).decision).toBe("BLOCK"));
  it.each([
    ["unauthenticated", { authenticated: false, authorizedByRbac: true }, "AUTH_REQUIRED"],
    ["RBAC denied", { authenticated: true, authorizedByRbac: false }, "RBAC_DENIED"],
    ["duplicate", { authenticated: true, authorizedByRbac: true, duplicate: true }, "DUPLICATE_ACTION"],
    ["missing resource", { authenticated: true, authorizedByRbac: true, resourceExists: false }, "RESOURCE_NOT_FOUND"]
  ])("hard-blocks %s without calling Jev", async (_name, deterministicFacts, code) => {
    const provider = FakeDecisionProvider.allow();
    const result = await new AuthorizationEngine(provider).authorize(request({ deterministicFacts }), DEFAULT_POLICY);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.some((reason) => reason.code === code)).toBe(true);
    expect(provider.calls).toBe(0);
  });
  it("blocks an agent risk downgrade", async () => {
    const result = await new AuthorizationEngine(FakeDecisionProvider.allow()).authorize(request({ proposedAction: { ...request().proposedAction, riskClass: "READ_ONLY" } }), DEFAULT_POLICY);
    expect(result.reasons[0]?.code).toBe("RISK_CLASS_MISMATCH");
  });
  it("reviews read-only provider failures by default and explicitly supports fail-open", async () => {
    const read = request({ proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "1" }, riskClass: "READ_ONLY" }, deterministicFacts: {} });
    expect((await new AuthorizationEngine(FakeDecisionProvider.error()).authorize(read, DEFAULT_POLICY)).decision).toBe("REVIEW");
    expect((await new AuthorizationEngine(FakeDecisionProvider.error(), { failOpenReadOnly: true }).authorize(read, DEFAULT_POLICY)).decision).toBe("ALLOW");
  });
  it("reports but does not enforce in shadow mode", async () => {
    const result = await new AuthorizationEngine(FakeDecisionProvider.scopeExpansion()).authorize(request({ mode: "shadow" }), DEFAULT_POLICY);
    expect(result.decision).toBe("ALLOW"); expect(result.wouldHaveDecision).toBe("BLOCK");
  });
});

describe("security utilities", () => {
  it("redacts nested secrets", () => expect(redactSecrets({ ok: 1, nested: { api_key: "secret" } })).toEqual({ ok: 1, nested: { api_key: "[REDACTED]" } }));
  it("creates stable fingerprints across key order", () => {
    const a = actionFingerprint(request(), "1");
    const b = actionFingerprint(request({ proposedAction: { tool: "refund_payment", operation: "refund", riskClass: "FINANCIAL", arguments: { amountCents: 4900, transactionId: "txn_duplicate" } } }), "1");
    expect(a).toBe(b);
  });
  it("changes fingerprints when a material action changes", () => expect(actionFingerprint(request(), "1")).not.toBe(actionFingerprint(request({ proposedAction: { ...request().proposedAction, arguments: { amountCents: 5000 } } }), "1")));
  it("omits unrelated context from semantic state", () => {
    const state = buildMinimalState(request({ context: { resources: { transaction: { id: "txn" }, customerMarketingHistory: "omit" }, currentState: { privateProfile: "omit" } } }), DEFAULT_POLICY.tools.refund_payment!);
    expect(state.relevant_resource).toEqual({ transaction: { id: "txn" } });
    expect(JSON.stringify(state)).not.toContain("customerMarketingHistory");
    expect(JSON.stringify(state)).not.toContain("privateProfile");
  });
  it("uses risk-aware failures", () => { expect(failureDecisionForRisk("READ_ONLY")).toBe("REVIEW"); expect(failureDecisionForRisk("DESTRUCTIVE")).toBe("BLOCK"); });
});
