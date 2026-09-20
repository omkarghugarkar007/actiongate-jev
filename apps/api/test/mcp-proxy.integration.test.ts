import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { ActionGate } from "@actiongate/sdk";
import {
  ACTIONGATE_INTENT_META_KEY,
  ActionGateRegistry,
  JSON_RPC,
  createMcpProxyServer,
  staticTokenResolver,
  type McpUpstream
} from "@actiongate/mcp-proxy";
import { buildApp } from "../src/app.js";

const PROXY_TOKEN = "proxy-token-for-the-agent";
const UPSTREAM_CREDENTIAL = "upstream-secret-only-the-proxy-holds";

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

/** Stands in for a networked MCP server that requires a private credential. */
function fakeUpstream() {
  const calls: { name: string; args: Record<string, unknown>; credential: string }[] = [];
  const upstream: McpUpstream = {
    listTools: async () => [
      { name: "get_order", description: "Upstream order reader" },
      { name: "refund_payment" },
      { name: "drop_database", description: "Never registered with ActionGate" }
    ],
    callTool: async (name, args) => {
      calls.push({ name, args, credential: UPSTREAM_CREDENTIAL });
      return { content: [{ type: "text", text: `${name} ok` }] };
    }
  };
  return { upstream, calls };
}

async function buildStack(provider = FakeDecisionProvider.allow()) {
  const api = buildApp({ provider, apiKey: "ag_proxy_test", apiKeyTenantId: "tenant-proxy", logger: false });
  apps.push(api);
  const address = await api.listen({ port: 0, host: "127.0.0.1" });
  const client = new ActionGate({ apiKey: "ag_proxy_test", baseUrl: address });
  const { upstream, calls } = fakeUpstream();
  const proxy = createMcpProxyServer({
    client,
    registry: new ActionGateRegistry({ baseUrl: address, apiKey: "ag_proxy_test", cacheTtlMs: 0 }),
    upstream,
    resolvePrincipal: staticTokenResolver([
      { token: PROXY_TOKEN, tenantId: "tenant-proxy", environment: "development", actor: { agentId: "support-agent" } }
    ]),
    logger: false
  });
  apps.push(proxy);
  return { proxy, calls, api };
}

// `null` means send no Authorization header at all. A default of `undefined`
// would be replaced by the default value and silently authenticate the request.
function rpc(proxy: ReturnType<typeof createMcpProxyServer>, payload: unknown, token: string | null = PROXY_TOKEN) {
  return proxy.inject({
    method: "POST",
    url: "/mcp",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: payload as Record<string, unknown>
  });
}

describe("standalone MCP proxy end to end", () => {
  it("lists only registry-approved tools using server-owned metadata", async () => {
    const { proxy } = await buildStack();
    const response = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.statusCode).toBe(200);
    const tools = response.json().result.tools as { name: string; inputSchema: Record<string, unknown> }[];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_order");
    // Upstream offers it; the tenant registry does not, so the agent never sees it.
    expect(names).not.toContain("drop_database");
    expect(tools.find((tool) => tool.name === "get_order")?.inputSchema).toMatchObject({ type: "object" });
  });

  it("authorizes, consumes a real grant, then forwards to upstream", async () => {
    const { proxy, calls } = await buildStack();
    const response = await rpc(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_order", arguments: { orderId: "123" }, _meta: { [ACTIONGATE_INTENT_META_KEY]: "Show me order 123." } }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "get_order", args: { orderId: "123" } });
    // The decision is correlatable, the permit is not exposed, and the upstream
    // credential never reaches the caller.
    expect(body.result._meta["actiongate/decisionId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_CREDENTIAL);
    expect(JSON.stringify(body)).not.toContain("ag_proxy_test");
  });

  it("issues a fresh single-use grant per call rather than reusing one", async () => {
    const { proxy, calls } = await buildStack();
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_order", arguments: { orderId: "123" } } };
    const first = await rpc(proxy, payload);
    const second = await rpc(proxy, payload);
    expect(first.json().error).toBeUndefined();
    expect(second.json().error).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(first.json().result._meta["actiongate/decisionId"]).not.toBe(second.json().result._meta["actiongate/decisionId"]);
  });

  it("rejects an unauthenticated caller at the HTTP layer and never reaches upstream", async () => {
    const { proxy, calls } = await buildStack();
    const missing = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    const wrong = await rpc(proxy, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-the-token-at-all");
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("does not forward a call the policy blocks", async () => {
    const { proxy, calls } = await buildStack(FakeDecisionProvider.scopeExpansion());
    const response = await rpc(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_order", arguments: { orderId: "123" } }
    });
    expect(response.json().error.code).toBe(JSON_RPC.ACTION_DENIED);
    expect(calls).toHaveLength(0);
  });

  it("refuses a tool the tenant registry does not know", async () => {
    const { proxy, calls } = await buildStack();
    const response = await rpc(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "drop_database", arguments: {} }
    });
    expect(response.json().error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  it("blocks a financial tool when no trusted fact provider asserts RBAC", async () => {
    const { proxy, calls } = await buildStack();
    const response = await rpc(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "refund_payment", arguments: { transactionId: "txn_1", amountCents: 4900 } }
    });
    // refund_payment requires authentication and RBAC. The proxy asserts no facts
    // of its own, so the hard rules fail closed rather than being assumed true.
    expect(response.json().error.code).toBe(JSON_RPC.ACTION_DENIED);
    expect(calls).toHaveLength(0);
  });
});
