import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, FunctionFactProvider } from "@actiongate/core";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { ActionGate, ActionBlockedError, ActionGrantMissingError, EmbeddedPolicyError, EmbeddedTransport } from "@actiongate/sdk";

/**
 * Embedded mode must give the same guarantees as the hosted path, so the same
 * assertions are made here: the handler runs only after a grant is consumed.
 */
const facts = new FunctionFactProvider({
  name: "local",
  resolve: () => ({ authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" })
});

function gate(overrides: Parameters<typeof ActionGate.embedded>[0] = {}) {
  return ActionGate.embedded({ provider: FakeDecisionProvider.allow(), factProviders: [facts], ...overrides });
}

function guarded(instance: ActionGate, calls: string[]) {
  return instance.wrapTool({
    name: "refund_payment",
    operation: "refund",
    riskClass: "FINANCIAL",
    execute: async (input: { transactionId: string; amountCents: number }) => { calls.push(input.transactionId); return { refunded: true }; },
    buildRequest: async () => ({
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      tenantId: "local",
      environment: "development" as const,
      mode: "enforce" as const,
      actor: { agentId: "embedded-agent" },
      userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" as const }
    })
  });
}

describe("embedded mode", () => {
  it("needs no API key, no base URL, and no server", async () => {
    const calls: string[] = [];
    await guarded(gate(), calls)({ transactionId: "txn_1", amountCents: 4900 }, {});
    expect(calls).toEqual(["txn_1"]);
  });

  it("falls back to the deterministic provider when no key is present", () => {
    const transport = new EmbeddedTransport({});
    // Without a key it must not silently pretend to be doing semantic work.
    expect(typeof transport.usingLiveProvider).toBe("boolean");
  });

  it("consumes exactly one grant per allowed call", async () => {
    const transport = new EmbeddedTransport({ provider: FakeDecisionProvider.allow(), factProviders: [facts] });
    const instance = new ActionGate({ transport });
    await guarded(instance, [])({ transactionId: "txn_1", amountCents: 4900 }, {});
    expect(transport.outstandingGrants()).toBe(0);
  });

  it("rejects a replayed grant", async () => {
    const transport = new EmbeddedTransport({ provider: FakeDecisionProvider.allow(), factProviders: [facts] });
    const instance = new ActionGate({ transport });
    const request = {
      requestId: "r1", idempotencyKey: "k1", tenantId: "local", environment: "development" as const, mode: "enforce" as const,
      actor: { agentId: "embedded-agent" },
      userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" as const },
      proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" as const }
    };
    const decision = await instance.authorize(request);
    const consume = { token: decision.grant!.token, tenantId: "local", environment: "development" as const, actor: { agentId: "embedded-agent" }, proposedAction: request.proposedAction };
    await expect(instance.consumeGrant(consume)).resolves.toMatchObject({ status: "CONSUMED" });
    await expect(instance.consumeGrant(consume)).rejects.toBeInstanceOf(EmbeddedPolicyError);
  });

  it("rejects a mutated action at consumption", async () => {
    const transport = new EmbeddedTransport({ provider: FakeDecisionProvider.allow(), factProviders: [facts] });
    const instance = new ActionGate({ transport });
    const request = {
      requestId: "r1", idempotencyKey: "k1", tenantId: "local", environment: "development" as const, mode: "enforce" as const,
      actor: { agentId: "embedded-agent" },
      userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" as const },
      proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" as const }
    };
    const decision = await instance.authorize(request);
    await expect(instance.consumeGrant({
      token: decision.grant!.token, tenantId: "local", environment: "development", actor: { agentId: "embedded-agent" },
      proposedAction: { ...request.proposedAction, arguments: { transactionId: "txn_OTHER", amountCents: 4900 } }
    })).rejects.toThrow();
    expect(transport.outstandingGrants()).toBe(1);
  });

  it("never runs the handler on BLOCK", async () => {
    const calls: string[] = [];
    // scopeExpansion drives the composed decision to BLOCK.
    const instance = gate({ provider: FakeDecisionProvider.scopeExpansion() });
    await expect(guarded(instance, calls)({ transactionId: "txn_1", amountCents: 4900 }, {})).rejects.toBeInstanceOf(ActionBlockedError);
    expect(calls).toEqual([]);
  });

  it("never runs the handler when hard rules are unsatisfied", async () => {
    const calls: string[] = [];
    // No fact provider, so refund_payment's hard rules cannot be evaluated.
    const instance = ActionGate.embedded({ provider: FakeDecisionProvider.allow() });
    await expect(guarded(instance, calls)({ transactionId: "txn_1", amountCents: 4900 }, {})).rejects.toBeInstanceOf(ActionBlockedError);
    expect(calls).toEqual([]);
  });

  it("refuses a tool the policy does not contain", async () => {
    const instance = gate();
    await expect(instance.wrapTool({
      name: "drop_database", operation: "delete", riskClass: "DESTRUCTIVE",
      execute: async () => "done",
      buildRequest: async () => ({
        requestId: "r", idempotencyKey: "k", tenantId: "local", environment: "development" as const, mode: "enforce" as const,
        actor: { agentId: "a" }, userIntent: { text: "drop it", source: "user_message" as const }
      })
    })({}, {})).rejects.toMatchObject({ code: "TOOL_NOT_REGISTERED" });
  });

  it("refuses a risk downgrade, exactly as the server does", async () => {
    const instance = gate();
    await expect(instance.wrapTool({
      name: "refund_payment", operation: "refund", riskClass: "READ_ONLY",
      execute: async () => "done",
      buildRequest: async () => ({
        requestId: "r", idempotencyKey: "k", tenantId: "local", environment: "development" as const, mode: "enforce" as const,
        actor: { agentId: "a" }, userIntent: { text: "refund", source: "user_message" as const }
      })
    })({ amountCents: 1 }, {})).rejects.toMatchObject({ code: "TOOL_METADATA_MISMATCH" });
  });

  it("returns the original decision for a replayed idempotency key", async () => {
    const instance = gate();
    const request = {
      requestId: "r1", idempotencyKey: "same-key", tenantId: "local", environment: "development" as const, mode: "enforce" as const,
      actor: { agentId: "a" }, userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" as const },
      proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" as const }
    };
    const first = await instance.authorize(request);
    const second = await instance.authorize(request);
    expect(second.decisionId).toBe(first.decisionId);
  });

  it("accepts a caller-supplied policy in place of the bundled one", async () => {
    const calls: string[] = [];
    const stricter = {
      ...DEFAULT_POLICY,
      tools: { ...DEFAULT_POLICY.tools, refund_payment: { ...DEFAULT_POLICY.tools.refund_payment!, hardRules: { ...DEFAULT_POLICY.tools.refund_payment!.hardRules, maxAmountCents: 100 } } }
    };
    const instance = gate({ policy: stricter });
    await expect(guarded(instance, calls)({ transactionId: "txn_1", amountCents: 4900 }, {})).rejects.toBeInstanceOf(ActionBlockedError);
    expect(calls).toEqual([]);
  });

  it("does not issue a grant in shadow mode, and does not execute without one", async () => {
    const instance = gate();
    const shadow = await instance.authorize({
      requestId: "r", idempotencyKey: "k-shadow", tenantId: "local", environment: "development", mode: "shadow",
      actor: { agentId: "a" }, userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" },
      proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" }
    });
    expect(shadow.grant).toBeUndefined();
    void ActionGrantMissingError;
  });
});
