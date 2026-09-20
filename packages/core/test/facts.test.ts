import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationEngine,
  DEFAULT_POLICY,
  FunctionFactProvider,
  HttpFactProvider,
  composeFacts,
  resolveTrustedFacts,
  runDeterministicRules,
  type AuthorizationRequest,
  type Policy,
  type ToolPolicy,
  type TrustedFactProvider
} from "../src/index.js";
import { FakeDecisionProvider } from "../../decision-provider/src/index.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    requestId: "req-1",
    idempotencyKey: "idem-key-0001",
    tenantId: "tenant-1",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "agent", userId: "user-9" },
    userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { amountCents: 4900 }, riskClass: "FINANCIAL" },
    ...overrides
  };
}

const SATISFIED = { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" } as const;

/** refund_payment, hardened to accept only server-resolved facts. */
function trustedRefundPolicy(maxFactAgeSeconds?: number): Policy {
  const base = DEFAULT_POLICY.tools.refund_payment!;
  const tool: ToolPolicy = {
    ...base,
    hardRules: { ...base.hardRules, requireTrustedFacts: true, ...(maxFactAgeSeconds ? { maxFactAgeSeconds } : {}) }
  };
  return { ...DEFAULT_POLICY, tools: { ...DEFAULT_POLICY.tools, refund_payment: tool } };
}

describe("composeFacts", () => {
  it("marks caller facts as untrusted and provider facts as trusted", () => {
    const composed = composeFacts(
      { authenticated: true, authorizedByRbac: true },
      [{ provider: "identity", facts: { authorizedByRbac: false }, observedAt: "2026-09-20T11:59:00.000Z" }]
    );
    // The provider's answer wins over the caller's claim about the same fact.
    expect(composed.facts.authorizedByRbac).toBe(false);
    expect(composed.attribution.authorizedByRbac).toEqual({ provenance: "trusted", source: "identity", observedAt: "2026-09-20T11:59:00.000Z" });
    expect(composed.attribution.authenticated).toMatchObject({ provenance: "caller", source: "caller" });
  });

  it("lets a later provider override an earlier one", () => {
    const composed = composeFacts(undefined, [
      { provider: "general", facts: { amountCents: 100 } },
      { provider: "ledger", facts: { amountCents: 4900 } }
    ]);
    expect(composed.facts.amountCents).toBe(4900);
    expect(composed.attribution.amountCents?.source).toBe("ledger");
  });

  it("keeps one failing provider from taking the others down", async () => {
    const good: TrustedFactProvider = { name: "good", resolve: async () => ({ provider: "good", facts: { authenticated: true } }) };
    const bad: TrustedFactProvider = { name: "bad", resolve: async () => { throw new Error("upstream down"); } };
    const { resolved, failures } = await resolveTrustedFacts([bad, good], { request: request(), tool: undefined });
    expect(resolved).toHaveLength(1);
    expect(failures).toEqual([{ provider: "bad", message: "upstream down" }]);
  });
});

describe("mandatory trusted facts", () => {
  const policy = trustedRefundPolicy();
  const tool = policy.tools.refund_payment!;

  it("refuses facts the caller asserted about itself", () => {
    const composed = composeFacts(SATISFIED, []);
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW });
    expect(result.decision).toBe("BLOCK");
    const codes = result.reasons.map((reason) => reason.code);
    expect(codes).toContain("FACT_NOT_TRUSTED");
    // The message names the fact so an operator can see which one to source.
    expect(result.reasons.find((reason) => reason.code === "FACT_NOT_TRUSTED")?.message).toContain("authenticated");
  });

  it("accepts the same values once a provider vouches for them", () => {
    const composed = composeFacts(undefined, [{ provider: "identity", facts: SATISFIED, observedAt: new Date(NOW - 1000).toISOString() }]);
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW });
    expect(result.decision).toBeUndefined();
  });

  it("still blocks a trusted fact that denies the action", () => {
    const composed = composeFacts(undefined, [{ provider: "identity", facts: { ...SATISFIED, authorizedByRbac: false } }]);
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW });
    expect(result.reasons.map((reason) => reason.code)).toContain("RBAC_DENIED");
  });

  it("records provenance in the deterministic signals", () => {
    const composed = composeFacts({ duplicate: false }, [{ provider: "identity", facts: { authenticated: true, authorizedByRbac: true } }]);
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW });
    expect(result.signals.factProvenance).toBe("authenticated=identity,authorizedByRbac=identity,duplicate=caller");
  });

  it("does not let the legacy policy flag make caller facts authoritative", () => {
    const composed = composeFacts(SATISFIED, []);
    const base = DEFAULT_POLICY.tools.refund_payment!;
    const toolWithLegacyOptOut = { ...base, hardRules: { ...base.hardRules, requireTrustedFacts: false } };
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, toolWithLegacyOptOut, { attribution: composed.attribution, now: NOW });
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toContain("FACT_NOT_TRUSTED");
  });
});

describe("fact freshness", () => {
  const policy = trustedRefundPolicy(60);
  const tool = policy.tools.refund_payment!;

  it("accepts a fact observed within the window", () => {
    const composed = composeFacts(undefined, [{ provider: "identity", facts: SATISFIED, observedAt: new Date(NOW - 30_000).toISOString() }]);
    expect(runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW }).decision).toBeUndefined();
  });

  it("blocks a fact observed outside the window", () => {
    const composed = composeFacts(undefined, [{ provider: "identity", facts: SATISFIED, observedAt: new Date(NOW - 120_000).toISOString() }]);
    const result = runDeterministicRules({ ...request(), deterministicFacts: composed.facts }, tool, { attribution: composed.attribution, now: NOW });
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toContain("FACT_STALE");
  });
});

describe("AuthorizationEngine with fact providers", () => {
  it("resolves facts server-side so a caller need not send them", async () => {
    const engine = new AuthorizationEngine(FakeDecisionProvider.allow(), {
      factProviders: [new FunctionFactProvider({ name: "identity", resolve: () => ({ ...SATISFIED }) })]
    });
    const result = await engine.authorize(request(), trustedRefundPolicy());
    expect(result.decision).toBe("ALLOW");
    expect(result.signals.deterministic.factProvenance).toContain("authorizedByRbac=identity");
  });

  it("ignores a caller's contradicting claim in favour of the provider", async () => {
    const engine = new AuthorizationEngine(FakeDecisionProvider.allow(), {
      factProviders: [new FunctionFactProvider({ name: "identity", resolve: () => ({ ...SATISFIED, authorizedByRbac: false }) })]
    });
    const result = await engine.authorize(request({ deterministicFacts: SATISFIED }), trustedRefundPolicy());
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toContain("RBAC_DENIED");
  });

  it("cannot be lied through deterministicFacts for any consequential check", async () => {
    const base = DEFAULT_POLICY.tools.refund_payment!;
    const policy: Policy = {
      ...DEFAULT_POLICY,
      tools: {
        ...DEFAULT_POLICY.tools,
        refund_payment: {
          ...base,
          hardRules: { ...base.hardRules, requireAllowlistedDestination: true }
        }
      }
    };
    const callerClaims = {
      authenticated: true,
      authorizedByRbac: true,
      duplicate: false,
      amountCents: 1,
      currency: "USD",
      destinationAllowlisted: true,
      resourceExists: true
    } as const;
    const engine = new AuthorizationEngine(FakeDecisionProvider.allow(), {
      factProviders: [new FunctionFactProvider({
        name: "system-of-record",
        resolve: () => ({
          authenticated: false,
          authorizedByRbac: false,
          duplicate: true,
          amountCents: 49_000,
          currency: "EUR",
          destinationAllowlisted: false,
          resourceExists: false
        })
      })]
    });

    const result = await engine.authorize(request({ deterministicFacts: callerClaims }), policy);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "AUTH_REQUIRED",
      "RBAC_DENIED",
      "DUPLICATE_ACTION",
      "RESOURCE_NOT_FOUND",
      "AMOUNT_EXCEEDS_LIMIT",
      "INVALID_CURRENCY",
      "DESTINATION_NOT_ALLOWED"
    ]));
    expect(String(result.signals.deterministic.factProvenance)).not.toContain("caller");
  });

  it("fails closed and explains itself when a provider is unavailable", async () => {
    const engine = new AuthorizationEngine(FakeDecisionProvider.allow(), {
      factProviders: [{ name: "identity", resolve: async () => { throw new Error("connection refused"); } }]
    });
    const result = await engine.authorize(request({ deterministicFacts: SATISFIED }), trustedRefundPolicy());
    expect(result.decision).toBe("BLOCK");
    const codes = result.reasons.map((reason) => reason.code);
    expect(codes).toContain("FACT_NOT_TRUSTED");
    expect(codes).toContain("FACT_PROVIDER_UNAVAILABLE");
  });
});

describe("HttpFactProvider", () => {
  it("sends only decision-relevant context and keeps only known facts", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ facts: { authorizedByRbac: true, amountCents: 4900, injected: "nope", currency: "TOOLONG" }, observedAt: "2026-09-20T11:59:30.000Z" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    const provider = new HttpFactProvider({ url: "https://facts.internal/resolve", name: "ledger", fetch: fetchMock as unknown as typeof fetch });
    const resolved = await provider.resolve({ request: request(), tool: DEFAULT_POLICY.tools.refund_payment! });

    // Unknown keys and malformed values are dropped, so the service cannot inject fields.
    expect(resolved?.facts).toEqual({ authorizedByRbac: true, amountCents: 4900 });
    expect(resolved?.observedAt).toBe("2026-09-20T11:59:30.000Z");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ tenantId: "tenant-1", environment: "development", riskClass: "FINANCIAL" });
    expect(body.userIntent).toBeUndefined();
  });

  it("throws on a failed service so the rule it feeds fails closed", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("nope", { status: 503 }));
    const provider = new HttpFactProvider({ url: "https://facts.internal/resolve", fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.resolve({ request: request(), tool: undefined })).rejects.toThrow(/503/);
  });

  it("skips tools it does not claim to know", async () => {
    const fetchMock = vi.fn();
    const provider = new HttpFactProvider({ url: "https://facts.internal/resolve", tools: ["send_email"], fetch: fetchMock as unknown as typeof fetch });
    expect(await provider.resolve({ request: request(), tool: undefined })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
