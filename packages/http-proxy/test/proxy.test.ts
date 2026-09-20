import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationRequest, AuthorizationResponse } from "@actiongate/core";
import type { ProxyPrincipal, ProxyRegistry, RegistryTool } from "@actiongate/proxy-core";
import { ACTIONGATE_INTENT_HEADER, ActionGateHttpProxy, RouteTable, type HttpUpstream, type ProxyRoute } from "@actiongate/http-proxy";

const PRINCIPAL: ProxyPrincipal = { tenantId: "tenant-1", environment: "development", actor: { agentId: "billing-service" } };
const GRANT_TOKEN = "grant-token-that-must-never-leak";

const REGISTRY_TOOLS: RegistryTool[] = [
  { name: "get_order", operation: "read", riskClass: "READ_ONLY", enabled: true },
  { name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", enabled: true },
  { name: "delete_record", operation: "delete", riskClass: "DESTRUCTIVE", enabled: false }
];

const ROUTES: ProxyRoute[] = [
  { method: "GET", path: "/orders/:orderId", tool: "get_order" },
  { method: "POST", path: "/refunds", tool: "refund_payment" },
  { method: "DELETE", path: "/records/:id", tool: "delete_record" }
];

function allow(request: AuthorizationRequest): AuthorizationResponse {
  return {
    requestId: request.requestId,
    decisionId: "11111111-1111-4111-8111-111111111111",
    decision: "ALLOW",
    mode: "enforce",
    riskClass: request.proposedAction.riskClass,
    reasons: [{ code: "POLICY_SATISFIED", message: "ok", source: "SYSTEM" }],
    signals: { deterministic: {} },
    timing: { totalMs: 3, deterministicMs: 1 },
    policy: { id: "p", version: "1.0.0" },
    createdAt: new Date().toISOString(),
    grant: { token: GRANT_TOKEN, grantId: "22222222-2222-4222-8222-222222222222", expiresAt: new Date(Date.now() + 30_000).toISOString() }
  };
}

function deny(decision: "BLOCK" | "REVIEW", request: AuthorizationRequest): AuthorizationResponse {
  const response = allow(request);
  delete response.grant;
  return { ...response, decision, reasons: [{ code: "RBAC_DENIED", message: "no", source: "DETERMINISTIC" }] };
}

let authorize: ReturnType<typeof vi.fn>;
let consumeGrant: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;

function buildProxy(routes: readonly ProxyRoute[] = ROUTES) {
  const registry: ProxyRegistry = { listTools: async () => REGISTRY_TOOLS };
  const upstream: HttpUpstream = { send: send as unknown as HttpUpstream["send"] };
  return new ActionGateHttpProxy({
    client: { authorize, consumeGrant } as never,
    registry,
    upstream,
    resolvePrincipal: async (token) => (token === "proxy-token" ? PRINCIPAL : undefined),
    routes
  });
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return { method, path, query: {}, headers, ...(body !== undefined ? { body } : {}) };
}

beforeEach(() => {
  authorize = vi.fn(async (request: AuthorizationRequest) => allow(request));
  consumeGrant = vi.fn(async () => ({ grantId: "g", decisionId: "d", status: "CONSUMED" as const, consumedAt: new Date().toISOString() }));
  send = vi.fn(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true } }));
});

describe("RouteTable", () => {
  it("matches method, literal segments, and named params", () => {
    const table = new RouteTable(ROUTES);
    expect(table.match("GET", "/orders/123")?.params).toEqual({ orderId: "123" });
    expect(table.match("get", "/orders/123")?.route.tool).toBe("get_order");
    expect(table.match("POST", "/orders/123")).toBeUndefined();
    expect(table.match("GET", "/orders/123/refunds")).toBeUndefined();
    expect(table.match("GET", "/orders")).toBeUndefined();
  });

  it("rejects a route path that is not absolute", () => {
    expect(() => new RouteTable([{ method: "GET", path: "orders", tool: "get_order" }])).toThrow(/must start/);
  });
});

describe("ActionGateHttpProxy", () => {
  it("authorizes, consumes, then forwards in that order", async () => {
    const order: string[] = [];
    authorize.mockImplementation(async (request: AuthorizationRequest) => { order.push("authorize"); return allow(request); });
    consumeGrant.mockImplementation(async () => { order.push("consume"); return { grantId: "g", decisionId: "d", status: "CONSUMED" as const, consumedAt: new Date().toISOString() }; });
    send.mockImplementation(async () => { order.push("upstream"); return { status: 200, headers: {}, body: { ok: true } }; });

    const response = await buildProxy().handle(req("POST", "/refunds", { transactionId: "txn_1", amountCents: 4900 }), "proxy-token");
    expect(response.status).toBe(200);
    expect(order).toEqual(["authorize", "consume", "upstream"]);
  });

  it("derives operation and risk from the registry and identity from the token", async () => {
    await buildProxy().handle(req("POST", "/refunds", { amountCents: 4900, riskClass: "READ_ONLY" }), "proxy-token");
    const request = authorize.mock.calls[0]?.[0] as AuthorizationRequest;
    expect(request.proposedAction.operation).toBe("refund");
    expect(request.proposedAction.riskClass).toBe("FINANCIAL");
    expect(request.tenantId).toBe("tenant-1");
    expect(request.actor).toEqual(PRINCIPAL.actor);
    expect(request.mode).toBe("enforce");
  });

  it("authorizes the exact arguments it later forwards", async () => {
    await buildProxy().handle(req("POST", "/refunds", { transactionId: "txn_1", amountCents: 4900 }), "proxy-token");
    const authorized = (authorize.mock.calls[0]?.[0] as AuthorizationRequest).proposedAction.arguments;
    expect(send.mock.calls[0]?.[0]).toMatchObject({ body: authorized });
  });

  it("merges path params into the canonical arguments", async () => {
    await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).proposedAction.arguments).toEqual({ orderId: "123" });
  });

  it("returns a correlation id but never the grant", async () => {
    const response = await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect(response.headers["x-actiongate-decision-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(response)).not.toContain(GRANT_TOKEN);
  });

  it("relays intent from a header and states its absence plainly", async () => {
    const proxy = buildProxy();
    await proxy.handle(req("GET", "/orders/123", undefined, { [ACTIONGATE_INTENT_HEADER]: "Show me order 123." }), "proxy-token");
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).userIntent).toEqual({ text: "Show me order 123.", source: "user_message" });
    await proxy.handle(req("GET", "/orders/123"), "proxy-token");
    expect((authorize.mock.calls[1]?.[0] as AuthorizationRequest).userIntent.source).toBe("workflow");
  });

  it("sends no deterministic facts of its own", async () => {
    await buildProxy().handle(req("POST", "/refunds", { amountCents: 1, deterministicFacts: { authorizedByRbac: true } }), "proxy-token");
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).deterministicFacts).toBeUndefined();
  });
});

describe("ActionGateHttpProxy fails closed", () => {
  it("rejects a missing or wrong token before anything else", async () => {
    for (const token of [undefined, "wrong"]) {
      const response = await buildProxy().handle(req("GET", "/orders/123"), token);
      expect(response.status).toBe(401);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not pass through an unmapped route", async () => {
    const response = await buildProxy().handle(req("GET", "/admin/secrets"), "proxy-token");
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe("ROUTE_NOT_MAPPED");
    expect(send).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses a route whose tool is disabled in the registry", async () => {
    const response = await buildProxy().handle(req("DELETE", "/records/1"), "proxy-token");
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["BLOCK", "REVIEW"] as const)("does not forward on %s", async (decision) => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => deny(decision, request));
    const response = await buildProxy().handle(req("POST", "/refunds", { amountCents: 4900 }), "proxy-token");
    expect(response.status).toBe(403);
    expect((response.body as { error: { data: { decision: string } } }).error.data.decision).toBe(decision);
    expect(consumeGrant).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not forward when an enforced allow carries no grant", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => { const r = allow(request); delete r.grant; return r; });
    const response = await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not forward when consumption fails", async () => {
    consumeGrant.mockRejectedValue(new Error("already consumed"));
    const response = await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect(response.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not forward when ActionGate is unreachable", async () => {
    authorize.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports an upstream failure distinctly from a denial", async () => {
    send.mockRejectedValue(new Error("upstream exploded"));
    const response = await buildProxy().handle(req("GET", "/orders/123"), "proxy-token");
    expect(response.status).toBe(502);
    expect(consumeGrant).toHaveBeenCalledTimes(1);
  });
});
