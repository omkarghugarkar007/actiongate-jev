import { describe, expect, it } from "vitest";
import type { ActionGrantConsumeRequest, AuthorizationRequest, AuthorizationResponse } from "@actiongate/core";
import { ACTIONGATE_GRANT_META_KEY, ActionGateMcpGateway, McpAuthorizationDeniedError, McpGatewayError, type ActionGateEnforcementClient } from "../src/index.js";

const baseAuthorization: Omit<AuthorizationRequest, "proposedAction"> = {
  requestId: "request-mcp-1",
  idempotencyKey: "idempotency-mcp-1",
  tenantId: "tenant-1",
  environment: "production",
  mode: "enforce",
  actor: { agentId: "support-agent", userId: "user-42", sessionId: "session-7" },
  userIntent: { text: "Email the receipt to alice@example.com", source: "user_message" }
};

describe("ActionGateMcpGateway", () => {
  it("derives server-owned policy, consumes, and only then executes", async () => {
    const events: string[] = [];
    let authorized: AuthorizationRequest | undefined;
    let consumed: ActionGrantConsumeRequest | undefined;
    const client: ActionGateEnforcementClient = {
      async authorize(request) {
        events.push("authorize");
        authorized = request;
        return allowResponse(request);
      },
      async consumeGrant(request) {
        events.push("consume");
        consumed = request;
        return { grantId: grantId, decisionId, status: "CONSUMED", consumedAt: new Date().toISOString() };
      }
    };
    const gateway = new ActionGateMcpGateway<{ credential: string }>(client).register({
      name: "send_email",
      operation: "send",
      riskClass: "EXTERNAL_COMMUNICATION",
      parseArguments: (value) => {
        if (typeof value.to !== "string") throw new Error("to is required");
        return { to: value.to, body: String(value.body ?? "") };
      },
      execute: async (input, runtime) => {
        events.push("execute");
        expect(runtime.credential).toBe("server-only-secret");
        return { sent: true, to: input.to };
      }
    });

    const output = await gateway.authorizeAndCall(toolCall({ to: "alice@example.com", body: "Receipt" }), baseAuthorization, { credential: "server-only-secret" });
    expect(events).toEqual(["authorize", "consume", "execute"]);
    expect(authorized?.proposedAction).toEqual({
      tool: "send_email",
      operation: "send",
      arguments: { to: "alice@example.com", body: "Receipt" },
      riskClass: "EXTERNAL_COMMUNICATION"
    });
    expect(consumed?.proposedAction).toEqual(authorized?.proposedAction);
    expect(output.result).toEqual({ sent: true, to: "alice@example.com" });
    expect(output.authorization).not.toHaveProperty("grant");
  });

  it("never executes a denied authorization", async () => {
    let executed = false;
    let consumed = false;
    const client: ActionGateEnforcementClient = {
      async authorize(request) {
        const response = allowResponse(request);
        delete response.grant;
        response.decision = "BLOCK";
        return response;
      },
      async consumeGrant() { consumed = true; throw new Error("must not consume"); }
    };
    const gateway = new ActionGateMcpGateway(client).register({
      name: "delete_record", riskClass: "DESTRUCTIVE", execute: async () => { executed = true; }
    });
    await expect(gateway.authorizeAndCall(toolCall({}, "delete_record"), baseAuthorization, {})).rejects.toBeInstanceOf(McpAuthorizationDeniedError);
    expect({ consumed, executed }).toEqual({ consumed: false, executed: false });
  });

  it("never executes when consumption fails", async () => {
    let executed = false;
    const client: ActionGateEnforcementClient = {
      async authorize(request) { return allowResponse(request); },
      async consumeGrant() { throw new Error("GRANT_ALREADY_CONSUMED"); }
    };
    const gateway = new ActionGateMcpGateway(client).register({
      name: "send_email", riskClass: "EXTERNAL_COMMUNICATION", execute: async () => { executed = true; }
    });
    await expect(gateway.authorizeAndCall(toolCall({}, "send_email"), baseAuthorization, {})).rejects.toThrow("GRANT_ALREADY_CONSUMED");
    expect(executed).toBe(false);
  });

  it("accepts a pre-authorized grant through MCP metadata", async () => {
    let consumed: ActionGrantConsumeRequest | undefined;
    const client: ActionGateEnforcementClient = {
      async authorize() { throw new Error("must not authorize"); },
      async consumeGrant(request) {
        consumed = request;
        return { grantId, decisionId, status: "CONSUMED", consumedAt: new Date().toISOString() };
      }
    };
    const gateway = new ActionGateMcpGateway(client).register({
      name: "get_order", operation: "read", riskClass: "READ_ONLY", execute: async (input) => input.orderId
    });
    const request = toolCall({ orderId: "123" }, "get_order", { [ACTIONGATE_GRANT_META_KEY]: "ag1.payload.signature" });
    await expect(gateway.callWithGrant(request, { tenantId: "tenant-1", environment: "production", actor: baseAuthorization.actor }, {})).resolves.toBe("123");
    expect(consumed).toMatchObject({
      token: "ag1.payload.signature",
      proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "123" }, riskClass: "READ_ONLY" }
    });
  });

  it("rejects shadow execution, missing grants, invalid arguments, and unregistered tools", async () => {
    const client: ActionGateEnforcementClient = {
      async authorize(request) { return allowResponse(request); },
      async consumeGrant() { return { grantId, decisionId, status: "CONSUMED", consumedAt: new Date().toISOString() }; }
    };
    const gateway = new ActionGateMcpGateway(client).register({
      name: "get_order",
      riskClass: "READ_ONLY",
      parseArguments: (value) => { if (typeof value.orderId !== "string") throw new Error("orderId is required"); return { orderId: value.orderId }; },
      execute: async () => undefined
    });
    await expect(gateway.authorizeAndCall(toolCall({ orderId: "1" }, "get_order"), { ...baseAuthorization, mode: "shadow" }, {})).rejects.toMatchObject({ code: "ENFORCEMENT_REQUIRED" });
    await expect(gateway.callWithGrant(toolCall({ orderId: "1" }, "get_order"), { tenantId: "tenant-1", environment: "production", actor: baseAuthorization.actor }, {})).rejects.toMatchObject({ code: "GRANT_MISSING" });
    await expect(gateway.authorizeAndCall(toolCall({}, "get_order"), baseAuthorization, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(gateway.authorizeAndCall(toolCall({}, "unknown"), baseAuthorization, {})).rejects.toMatchObject({ code: "TOOL_NOT_REGISTERED" });
    expect(() => gateway.register({ name: "get_order", riskClass: "READ_ONLY", execute: async () => undefined })).toThrow(McpGatewayError);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["date", { value: new Date() }]
  ])("rejects parser-created non-JSON %s before authorization", async (_name, parsed) => {
    let authorized = false;
    const client: ActionGateEnforcementClient = {
      async authorize(request) { authorized = true; return allowResponse(request); },
      async consumeGrant() { return { grantId, decisionId, status: "CONSUMED", consumedAt: new Date().toISOString() }; }
    };
    const gateway = new ActionGateMcpGateway(client).register({
      name: "unsafe_parser",
      riskClass: "READ_ONLY",
      parseArguments: () => parsed as Record<string, unknown>,
      execute: async () => undefined
    });
    await expect(gateway.authorizeAndCall(toolCall({}, "unsafe_parser"), baseAuthorization, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(authorized).toBe(false);
  });
});

const decisionId = "60983a72-af13-443d-8bd8-6128783d5876";
const grantId = "11acc02b-541f-445d-81ed-16a738f08f22";

function allowResponse(request: AuthorizationRequest): AuthorizationResponse {
  return {
    requestId: request.requestId,
    decisionId,
    decision: "ALLOW",
    mode: "enforce",
    riskClass: request.proposedAction.riskClass,
    reasons: [],
    signals: { deterministic: {} },
    timing: { totalMs: 1, deterministicMs: 1 },
    policy: { id: "default", version: "1.0.0" },
    createdAt: new Date().toISOString(),
    grant: { token: "ag1.payload.signature", grantId, expiresAt: new Date(Date.now() + 30_000).toISOString() }
  };
}

function toolCall(argumentsValue: Record<string, unknown>, name = "send_email", meta?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0" as const,
    id: "call-1",
    method: "tools/call" as const,
    params: { name, arguments: argumentsValue, ...(meta ? { _meta: meta } : {}) }
  };
}
