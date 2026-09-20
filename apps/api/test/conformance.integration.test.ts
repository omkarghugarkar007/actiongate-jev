import { describe, expect, it } from "vitest";
import { createScriptedGate, runConformance, type AdapterUnderTest, type ScriptedGate } from "@actiongate/conformance";
import { ActionGate } from "@actiongate/sdk";
import { ActionGateMcpProxy, ACTIONGATE_INTENT_META_KEY } from "@actiongate/mcp-proxy";
import { ActionGateHttpProxy } from "@actiongate/http-proxy";
import type { ProxyPrincipal, ProxyRegistry, RegistryTool } from "@actiongate/proxy-core";

/**
 * The conformance suite exists to check third-party adapters. Running the ones
 * this project ships through it proves the suite is calibrated against real
 * implementations, not only against the straw adapters in its own tests.
 */
const PRINCIPAL: ProxyPrincipal = { tenantId: "conformance", environment: "development", actor: { agentId: "conformance" } };
const TOOLS: RegistryTool[] = [
  { name: "get_order", operation: "read", riskClass: "READ_ONLY", enabled: true },
  { name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", enabled: true }
];
const registry: ProxyRegistry = { listTools: async () => TOOLS };

/** Bridges the scripted gate into the SDK's HTTP client without a network. */
function sdkClient(gate: ScriptedGate) {
  return new ActionGate({
    apiKey: "conformance",
    baseUrl: "https://gate.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      try {
        const payload = url.endsWith("/v1/authorize") ? await gate.authorize(body) : await gate.consumeGrant(body);
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify({ error: { code: "UPSTREAM", message: "The authorization service rejected the request." } }), { status: 503 });
      }
    }) as unknown as typeof fetch
  });
}

function sdkAdapter(gate: ScriptedGate): AdapterUnderTest {
  const client = sdkClient(gate);
  let executed = false;
  return {
    name: "@actiongate/sdk wrapTool",
    level: "guard",
    reset: async () => { executed = false; },
    async attempt({ tool, arguments: args }) {
      const guarded = client.wrapTool({
        name: tool,
        operation: tool === "get_order" ? "read" : "refund",
        riskClass: tool === "get_order" ? "READ_ONLY" : "FINANCIAL",
        execute: async () => { executed = true; return { ok: true }; },
        buildRequest: async () => ({
          requestId: "conformance", idempotencyKey: "conformance-key-0001",
          tenantId: "conformance", environment: "development" as const, mode: "enforce" as const,
          actor: { agentId: "conformance" },
          userIntent: { text: "do the thing", source: "user_message" as const }
        })
      });
      try { await guarded(args, {}); } catch { /* denial paths throw by design */ }
      return { executed };
    }
  };
}

function mcpProxyAdapter(gate: ScriptedGate): AdapterUnderTest {
  let executed = false;
  const proxy = new ActionGateMcpProxy({
    client: gate as never,
    registry,
    upstream: { listTools: async () => TOOLS.map((tool) => ({ name: tool.name })), callTool: async () => { executed = true; return { content: [] }; } },
    resolvePrincipal: async () => PRINCIPAL
  });
  return {
    name: "@actiongate/mcp-proxy",
    level: "isolate",
    reset: async () => { executed = false; },
    async attempt({ tool, arguments: args, intent }) {
      await proxy.handle(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args, ...(intent ? { _meta: { [ACTIONGATE_INTENT_META_KEY]: intent } } : {}) } },
        "token"
      );
      return { executed };
    }
  };
}

function httpProxyAdapter(gate: ScriptedGate): AdapterUnderTest {
  let executed = false;
  const proxy = new ActionGateHttpProxy({
    client: gate as never,
    registry,
    upstream: { send: async () => { executed = true; return { status: 200, headers: {}, body: { ok: true } }; } },
    resolvePrincipal: async () => PRINCIPAL,
    routes: [
      { method: "GET", path: "/orders/:orderId", tool: "get_order" },
      { method: "POST", path: "/refunds", tool: "refund_payment" }
    ]
  });
  return {
    name: "@actiongate/http-proxy",
    level: "isolate",
    reset: async () => { executed = false; },
    async attempt({ tool, arguments: args }) {
      const isRead = tool === "get_order";
      await proxy.handle(
        isRead
          ? { method: "GET", path: "/orders/1", query: {}, headers: {} }
          : { method: "POST", path: "/refunds", query: {}, headers: {}, body: args },
        "token"
      );
      return { executed };
    }
  };
}

describe("shipped adapters are conformant", () => {
  it.each([
    ["sdk", sdkAdapter],
    ["mcp-proxy", mcpProxyAdapter],
    ["http-proxy", httpProxyAdapter]
  ])("%s passes every check for its claimed level", async (_name, build) => {
    const gate = createScriptedGate();
    const result = await runConformance(build(gate), gate);
    const failures = result.checks.filter((check) => check.status === "fail");
    expect(failures.map((check) => `${check.id}: ${check.error}`)).toEqual([]);
    expect(result.conformant).toBe(true);
    expect(result.passed).toBeGreaterThanOrEqual(7);
  });
});
