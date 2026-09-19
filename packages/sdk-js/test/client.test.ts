import { describe, expect, it } from "vitest";
import { ActionBlockedError, ActionGate, ActionGateApiError } from "../src/index.js";

describe("ActionGate SDK", () => {
  it("never executes a blocked tool", async () => {
    let executed = false;
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => new Response(JSON.stringify({ decision: "BLOCK", decisionId: "d", requestId: "r" }), { status: 200 }) });
    const wrapped = gate.wrapTool<{ id: string }, void, object>({
      name: "delete_record", operation: "delete", riskClass: "DESTRUCTIVE", execute: async () => { executed = true; },
      buildRequest: async () => ({ requestId: "r", idempotencyKey: "idempotency-1", tenantId: "t", environment: "development", mode: "enforce", actor: { agentId: "a" }, userIntent: { text: "delete", source: "user_message" } })
    });
    await expect(wrapped({ id: "1" }, {})).rejects.toBeInstanceOf(ActionBlockedError); expect(executed).toBe(false);
  });
  it("executes an allowed tool exactly once and sends the idempotency header", async () => {
    let executions = 0;
    let idempotencyHeader: string | null = null;
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test/", fetch: async (_input, init) => {
      idempotencyHeader = new Headers(init?.headers).get("Idempotency-Key");
      return new Response(JSON.stringify({ decision: "ALLOW", decisionId: "d", requestId: "r" }), { status: 200 });
    } });
    const wrapped = gate.wrapTool<{ id: string }, string, object>({
      name: "get_order", operation: "read", riskClass: "READ_ONLY", execute: async ({ id }) => { executions += 1; return id; },
      buildRequest: async () => ({ requestId: "r", idempotencyKey: "idempotency-2", tenantId: "t", environment: "development", mode: "enforce", actor: { agentId: "a" }, userIntent: { text: "read order", source: "user_message" } })
    });
    await expect(wrapped({ id: "42" }, {})).resolves.toBe("42");
    expect(executions).toBe(1);
    expect(idempotencyHeader).toBe("idempotency-2");
  });
  it("maps non-success API responses to a typed error", async () => {
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => new Response(JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT", message: "conflict" } }), { status: 409 }) });
    await expect(gate.authorize({} as never)).rejects.toBeInstanceOf(ActionGateApiError);
  });
});
