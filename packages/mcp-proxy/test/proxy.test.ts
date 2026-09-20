import { describe, expect, it, beforeEach, vi } from "vitest";
import type { ActionGrantConsumeRequest, AuthorizationRequest, AuthorizationResponse } from "@actiongate/core";
import {
  ACTIONGATE_INTENT_META_KEY,
  ActionGateMcpProxy,
  JSON_RPC,
  type McpUpstream,
  type ProxyPrincipal,
  type ProxyRegistry,
  type RegistryTool
} from "@actiongate/mcp-proxy";

const PRINCIPAL: ProxyPrincipal = {
  tenantId: "tenant-1",
  environment: "development",
  actor: { agentId: "support-agent", userId: "user-9" }
};

const REGISTRY_TOOLS: RegistryTool[] = [
  { name: "get_order", operation: "read", riskClass: "READ_ONLY", enabled: true, argumentSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] } },
  { name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", enabled: true },
  { name: "delete_record", operation: "delete", riskClass: "DESTRUCTIVE", enabled: false }
];

const GRANT_TOKEN = "grant-token-that-must-never-leak";

function allowResponse(request: AuthorizationRequest): AuthorizationResponse {
  return {
    requestId: request.requestId,
    decisionId: "11111111-1111-4111-8111-111111111111",
    decision: "ALLOW",
    mode: "enforce",
    riskClass: request.proposedAction.riskClass,
    reasons: [{ code: "POLICY_SATISFIED", message: "ok", source: "DETERMINISTIC" }],
    signals: { deterministic: {} },
    timing: { totalMs: 5, deterministicMs: 1 },
    policy: { id: "support-agent-default", version: "1.0.0" },
    createdAt: new Date().toISOString(),
    grant: { token: GRANT_TOKEN, grantId: "22222222-2222-4222-8222-222222222222", expiresAt: new Date(Date.now() + 30_000).toISOString() }
  };
}

function denyResponse(decision: "BLOCK" | "REVIEW", request: AuthorizationRequest): AuthorizationResponse {
  return {
    requestId: request.requestId,
    decisionId: "33333333-3333-4333-8333-333333333333",
    decision,
    mode: "enforce",
    riskClass: request.proposedAction.riskClass,
    reasons: [{ code: "RBAC_FAILED", message: "not permitted", source: "DETERMINISTIC" }],
    signals: { deterministic: {} },
    timing: { totalMs: 5, deterministicMs: 1 },
    policy: { id: "support-agent-default", version: "1.0.0" },
    createdAt: new Date().toISOString()
  };
}

let authorize: ReturnType<typeof vi.fn>;
let consumeGrant: ReturnType<typeof vi.fn>;
let callTool: ReturnType<typeof vi.fn>;
let listUpstreamTools: ReturnType<typeof vi.fn>;

function buildProxy(overrides: Partial<ConstructorParameters<typeof ActionGateMcpProxy>[0]> = {}) {
  const upstream: McpUpstream = {
    listTools: listUpstreamTools as unknown as McpUpstream["listTools"],
    callTool: callTool as unknown as McpUpstream["callTool"]
  };
  const registry: ProxyRegistry = { listTools: async () => REGISTRY_TOOLS };
  return new ActionGateMcpProxy({
    client: { authorize, consumeGrant } as never,
    registry,
    upstream,
    resolvePrincipal: async (token) => (token === "proxy-token" ? PRINCIPAL : undefined),
    ...overrides
  });
}

function callRequest(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) }
  };
}

beforeEach(() => {
  authorize = vi.fn(async (request: AuthorizationRequest) => allowResponse(request));
  consumeGrant = vi.fn(async (_request: ActionGrantConsumeRequest) => ({
    grantId: "22222222-2222-4222-8222-222222222222",
    decisionId: "11111111-1111-4111-8111-111111111111",
    status: "CONSUMED" as const,
    consumedAt: new Date().toISOString()
  }));
  callTool = vi.fn(async () => ({ content: [{ type: "text", text: "order 123" }] }));
  listUpstreamTools = vi.fn(async () => [
    { name: "get_order", description: "upstream description" },
    { name: "refund_payment" },
    { name: "delete_record" },
    { name: "drop_database", description: "not registered with ActionGate" }
  ]);
});

describe("ActionGateMcpProxy tools/list", () => {
  it("advertises only tools that exist upstream and are enabled in the registry", async () => {
    const response = await buildProxy().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "proxy-token");
    const names = (response.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names).toEqual(["get_order", "refund_payment"]);
    // An unregistered upstream tool is never described, so a model cannot learn it exists.
    expect(names).not.toContain("drop_database");
    // A registered-but-disabled tool is hidden too.
    expect(names).not.toContain("delete_record");
  });

  it("advertises the registry schema rather than the upstream schema", async () => {
    const response = await buildProxy().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "proxy-token");
    const tools = (response.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
    expect(tools[0]?.inputSchema).toEqual(REGISTRY_TOOLS[0]?.argumentSchema);
  });
});

describe("ActionGateMcpProxy tools/call", () => {
  it("authorizes, consumes, then forwards to upstream in that order", async () => {
    const order: string[] = [];
    authorize.mockImplementation(async (request: AuthorizationRequest) => { order.push("authorize"); return allowResponse(request); });
    consumeGrant.mockImplementation(async () => { order.push("consume"); return { grantId: "22222222-2222-4222-8222-222222222222", decisionId: "11111111-1111-4111-8111-111111111111", status: "CONSUMED" as const, consumedAt: new Date().toISOString() }; });
    callTool.mockImplementation(async () => { order.push("upstream"); return { content: [] }; });

    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error).toBeUndefined();
    expect(order).toEqual(["authorize", "consume", "upstream"]);
  });

  it("derives operation and risk from the registry, not from the caller", async () => {
    await buildProxy().handle(
      // The caller tries to pass a softer classification alongside the arguments.
      callRequest("refund_payment", { amountCents: 4900, riskClass: "READ_ONLY", operation: "read" }),
      "proxy-token"
    );
    const request = authorize.mock.calls[0]?.[0] as AuthorizationRequest;
    expect(request.proposedAction.operation).toBe("refund");
    expect(request.proposedAction.riskClass).toBe("FINANCIAL");
  });

  it("derives tenant, environment, and actor from the token", async () => {
    await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    const request = authorize.mock.calls[0]?.[0] as AuthorizationRequest;
    expect(request.tenantId).toBe("tenant-1");
    expect(request.environment).toBe("development");
    expect(request.actor).toEqual(PRINCIPAL.actor);
    expect(request.mode).toBe("enforce");
  });

  it("never returns the grant token to the caller", async () => {
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(JSON.stringify(response)).not.toContain(GRANT_TOKEN);
    expect((response.result as Record<string, unknown>)._meta).toMatchObject({ "actiongate/decisionId": "11111111-1111-4111-8111-111111111111" });
  });

  it("strips _meta before forwarding so a model cannot smuggle a grant upstream", async () => {
    await buildProxy().handle(
      callRequest("get_order", { orderId: "123" }, { "actiongate/grant": "forged", [ACTIONGATE_INTENT_META_KEY]: "Show me order 123." }),
      "proxy-token"
    );
    expect(callTool).toHaveBeenCalledWith("get_order", { orderId: "123" });
  });

  it("relays user intent when supplied and states its absence plainly when not", async () => {
    const proxy = buildProxy();
    await proxy.handle(callRequest("get_order", { orderId: "123" }, { [ACTIONGATE_INTENT_META_KEY]: "Show me order 123." }), "proxy-token");
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).userIntent).toEqual({ text: "Show me order 123.", source: "user_message" });

    await proxy.handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    const withoutIntent = (authorize.mock.calls[1]?.[0] as AuthorizationRequest).userIntent;
    expect(withoutIntent.source).toBe("workflow");
    expect(withoutIntent.text).toMatch(/no user intent/i);
  });

  it("never accepts deterministic facts from the caller", async () => {
    await buildProxy().handle(
      callRequest("refund_payment", { amountCents: 4900, deterministicFacts: { authorizedByRbac: true, authenticated: true } }),
      "proxy-token"
    );
    const request = authorize.mock.calls[0]?.[0] as AuthorizationRequest;
    expect(request.deterministicFacts).toBeUndefined();
  });

  it("uses the configured server-side fact provider", async () => {
    const proxy = buildProxy({ deterministicFacts: async () => ({ authenticated: true, authorizedByRbac: true }) });
    await proxy.handle(callRequest("refund_payment", { amountCents: 4900 }), "proxy-token");
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).deterministicFacts).toEqual({ authenticated: true, authorizedByRbac: true });
  });
});

describe("ActionGateMcpProxy fails closed", () => {
  it("rejects a missing or unknown token without reaching ActionGate or upstream", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), token);
      expect(response.error?.code).toBe(JSON_RPC.UNAUTHORIZED);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("gives unknown and disabled tools the same answer and never calls upstream", async () => {
    const proxy = buildProxy();
    const unknown = await proxy.handle(callRequest("drop_database", {}), "proxy-token");
    const disabled = await proxy.handle(callRequest("delete_record", {}), "proxy-token");
    expect(unknown.error?.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(disabled.error?.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(unknown.error?.message.replace("drop_database", "X")).toBe(disabled.error?.message.replace("delete_record", "X"));
    expect(authorize).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["BLOCK", "REVIEW"] as const)("does not call upstream on %s", async (decision) => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => denyResponse(decision, request));
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error?.code).toBe(JSON_RPC.ACTION_DENIED);
    expect(response.error?.data).toMatchObject({ decision });
    expect(consumeGrant).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not call upstream when an enforced allow arrives without a grant", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => {
      const response = allowResponse(request);
      delete response.grant;
      return response;
    });
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error?.code).toBe(JSON_RPC.ACTION_DENIED);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not call upstream when grant consumption fails", async () => {
    consumeGrant.mockRejectedValue(new Error("grant already consumed"));
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error).toBeDefined();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not call upstream when ActionGate is unreachable", async () => {
    authorize.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error?.code).toBe(JSON_RPC.INTERNAL_ERROR);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses methods it does not handle instead of forwarding them", async () => {
    for (const method of ["resources/read", "prompts/get", "completion/complete", "tools/call/../.."]) {
      const response = await buildProxy().handle({ jsonrpc: "2.0", id: 1, method }, "proxy-token");
      expect(response.error?.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    }
    expect(callTool).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON-RPC and malformed params", async () => {
    const proxy = buildProxy();
    expect((await proxy.handle({ method: "tools/list" }, "proxy-token")).error?.code).toBe(JSON_RPC.INVALID_REQUEST);
    expect((await proxy.handle({ jsonrpc: "1.0", id: 1, method: "tools/list" }, "proxy-token")).error?.code).toBe(JSON_RPC.INVALID_REQUEST);
    expect((await proxy.handle(callRequest(""), "proxy-token")).error?.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect((await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_order", arguments: [] } }, "proxy-token")).error?.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reports an upstream failure without implying the action was blocked", async () => {
    callTool.mockRejectedValue(new Error("upstream exploded"));
    const response = await buildProxy().handle(callRequest("get_order", { orderId: "123" }), "proxy-token");
    expect(response.error?.code).toBe(JSON_RPC.UPSTREAM_ERROR);
    // The grant was already consumed, so the caller must not retry blindly.
    expect(consumeGrant).toHaveBeenCalledTimes(1);
  });
});
