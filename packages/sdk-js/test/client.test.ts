import { describe, expect, it } from "vitest";
import { ActionBlockedError, ActionGate, ActionGateApiError, ActionGrantMissingError } from "../src/index.js";

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
  it("consumes the exact-action grant before executing an allowed tool exactly once", async () => {
    let executions = 0;
    let idempotencyHeader: string | null = null;
    const calls: Array<{ url: string; body: any }> = [];
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test/", fetch: async (input, init) => {
      const url = input.toString();
      const requestBody = JSON.parse(String(init?.body));
      calls.push({ url, body: requestBody });
      if (url.endsWith("/v1/authorize")) {
        idempotencyHeader = new Headers(init?.headers).get("Idempotency-Key");
        return jsonResponse({ decision: "ALLOW", decisionId: "d", requestId: "r", mode: "enforce", grant: { token: "ag1.payload.signature", grantId: "g", expiresAt: "2026-09-19T10:00:30.000Z" } });
      }
      return jsonResponse({ grantId: "g", decisionId: "d", status: "CONSUMED", consumedAt: "2026-09-19T10:00:01.000Z" });
    } });
    const wrapped = gate.wrapTool<{ id: string }, string, object>({
      name: "get_order", operation: "read", riskClass: "READ_ONLY", execute: async ({ id }) => { executions += 1; return id; },
      buildRequest: async () => ({ requestId: "r", idempotencyKey: "idempotency-2", tenantId: "t", environment: "development", mode: "enforce", actor: { agentId: "a" }, userIntent: { text: "read order", source: "user_message" } })
    });
    await expect(wrapped({ id: "42" }, {})).resolves.toBe("42");
    expect(executions).toBe(1);
    expect(idempotencyHeader).toBe("idempotency-2");
    expect(calls.map((call) => call.url)).toEqual(["http://test/v1/authorize", "http://test/v1/grants/consume"]);
    expect(calls[1]?.body).toMatchObject({
      token: "ag1.payload.signature",
      tenantId: "t",
      actor: { agentId: "a" },
      proposedAction: { tool: "get_order", operation: "read", arguments: { id: "42" }, riskClass: "READ_ONLY" }
    });
  });

  it("does not execute when an enforced allow is missing its grant", async () => {
    let executions = 0;
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => jsonResponse({ decision: "ALLOW", decisionId: "d", requestId: "r", mode: "enforce" }) });
    const wrapped = readTool(gate, async () => { executions += 1; return "executed"; });
    await expect(wrapped({ id: "42" }, {})).rejects.toBeInstanceOf(ActionGrantMissingError);
    expect(executions).toBe(0);
  });

  it("does not execute when grant consumption fails", async () => {
    let executions = 0;
    let calls = 0;
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ decision: "ALLOW", decisionId: "d", requestId: "r", mode: "enforce", grant: { token: "ag1.payload.signature", grantId: "g", expiresAt: "2026-09-19T10:00:30.000Z" } });
      return jsonResponse({ error: { code: "GRANT_ALREADY_CONSUMED", message: "already used" } }, 409);
    } });
    const wrapped = readTool(gate, async () => { executions += 1; return "executed"; });
    await expect(wrapped({ id: "42" }, {})).rejects.toMatchObject({ code: "GRANT_ALREADY_CONSUMED" });
    expect(executions).toBe(0);
  });

  it("keeps shadow mode observational and does not request a grant", async () => {
    let executions = 0;
    let calls = 0;
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => {
      calls += 1;
      return jsonResponse({ decision: "ALLOW", decisionId: "d", requestId: "r", mode: "shadow", wouldHaveDecision: "BLOCK" });
    } });
    const wrapped = gate.wrapTool<{ id: string }, string, object>({
      name: "get_order", operation: "read", riskClass: "READ_ONLY", execute: async () => { executions += 1; return "executed"; },
      buildRequest: async () => ({ requestId: "r", idempotencyKey: "idempotency-shadow", tenantId: "t", environment: "development", mode: "shadow", actor: { agentId: "a" }, userIntent: { text: "read", source: "user_message" } })
    });
    await expect(wrapped({ id: "42" }, {})).resolves.toBe("executed");
    expect({ executions, calls }).toEqual({ executions: 1, calls: 1 });
  });
  it("maps non-success API responses to a typed error", async () => {
    const gate = new ActionGate({ apiKey: "test", baseUrl: "http://test", fetch: async () => new Response(JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT", message: "conflict" } }), { status: 409 }) });
    await expect(gate.authorize({} as never)).rejects.toBeInstanceOf(ActionGateApiError);
  });
});

function readTool(gate: ActionGate, execute: (input: { id: string }) => Promise<string>) {
  return gate.wrapTool<{ id: string }, string, object>({
    name: "get_order", operation: "read", riskClass: "READ_ONLY", execute,
    buildRequest: async () => ({ requestId: "r", idempotencyKey: "idempotency-read", tenantId: "t", environment: "development", mode: "enforce", actor: { agentId: "a" }, userIntent: { text: "read", source: "user_message" } })
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
