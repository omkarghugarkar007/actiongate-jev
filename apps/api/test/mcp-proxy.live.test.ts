import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenRouterJevProvider } from "@actiongate/decision-provider";
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

// Live gate for the standalone proxy: the whole chain (MCP client -> proxy ->
// ActionGate -> live Jev -> grant -> upstream) runs against real OpenRouter.
const enabled = process.env.RUN_LIVE_JEV_TESTS === "true";
const PROXY_TOKEN = "live-proxy-token-for-the-agent";

let api: ReturnType<typeof buildApp>;
let proxy: ReturnType<typeof createMcpProxyServer>;
let upstreamCalls: { name: string; args: Record<string, unknown> }[] = [];

beforeAll(async () => {
  if (!enabled) return;
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the live MCP proxy gate");

  api = buildApp({
    provider: new OpenRouterJevProvider({ apiKey, model: process.env.JEV_MODEL ?? "typesafe/jev-1.13", appTitle: "ActionGate live MCP proxy gate" }),
    apiKey: "ag_live_proxy",
    apiKeyTenantId: "tenant-live-proxy",
    logger: false,
    storage: "memory",
    controlPlaneStorage: "memory",
    grantSecret: "live-proxy-gate-secret-at-least-32-bytes-long"
  });
  const address = await api.listen({ port: 0, host: "127.0.0.1" });

  const upstream: McpUpstream = {
    listTools: async () => [{ name: "get_order" }, { name: "refund_payment" }],
    callTool: async (name, args) => {
      upstreamCalls.push({ name, args });
      return { content: [{ type: "text", text: `${name} ok` }] };
    }
  };
  proxy = createMcpProxyServer({
    client: new ActionGate({ apiKey: "ag_live_proxy", baseUrl: address }),
    registry: new ActionGateRegistry({ baseUrl: address, apiKey: "ag_live_proxy", cacheTtlMs: 0 }),
    upstream,
    resolvePrincipal: staticTokenResolver([
      { token: PROXY_TOKEN, tenantId: "tenant-live-proxy", environment: "development", actor: { agentId: "support-agent" } }
    ]),
    logger: false
  });
});

afterAll(async () => {
  await proxy?.close();
  await api?.close();
});

function call(name: string, args: Record<string, unknown>, intent?: string) {
  return proxy.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${PROXY_TOKEN}` },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...(intent ? { _meta: { [ACTIONGATE_INTENT_META_KEY]: intent } } : {}) }
    }
  });
}

describe.skipIf(!enabled)("standalone MCP proxy @live", () => {
  it("forwards an aligned read only after live Jev evidence produces a consumed grant", async () => {
    upstreamCalls = [];
    const response = await call("get_order", { orderId: "123" }, "Show me order 123.");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error).toBeUndefined();
    expect(upstreamCalls).toEqual([{ name: "get_order", args: { orderId: "123" } }]);

    // Confirm the decision behind this call really came from the live gateway.
    const decisionId = body.result._meta["actiongate/decisionId"];
    const decision = await api.inject({
      method: "GET",
      url: `/v1/decisions/${decisionId}`,
      headers: { authorization: "Bearer ag_live_proxy" }
    });
    expect(decision.statusCode).toBe(200);
    // The detail endpoint returns the stored audit record, so the decision
    // response (and its provider attribution) sits under `response`.
    const model = decision.json().response?.model;
    expect(model?.provider).toBe("openrouter");
    expect(model?.resolvedModel).toBeTruthy();
  });

  it("refuses a financial call no trusted fact provider can vouch for, whatever the model says", async () => {
    upstreamCalls = [];
    const response = await call(
      "refund_payment",
      { transactionId: "txn_8923", amountCents: 4900 },
      "Please refund my duplicate $49 charge."
    );
    expect(response.json().error.code).toBe(JSON_RPC.ACTION_DENIED);
    expect(upstreamCalls).toHaveLength(0);
  });
});
