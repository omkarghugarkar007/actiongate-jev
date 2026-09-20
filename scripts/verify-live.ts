import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { verifyExport, verifySignedRequest, type SignedExport } from "@actiongate/core";
import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, staticTokenResolver } from "@actiongate/proxy-core";
import { createMcpProxyServer, HttpMcpUpstream } from "@actiongate/mcp-proxy";
import { createHttpProxyServer, FetchHttpUpstream } from "@actiongate/http-proxy";

/**
 * Real end-to-end verification. Nothing here is mocked:
 *
 *  - a real ActionGate API on Redis and PostgreSQL, backed by live Jev via OpenRouter
 *  - real HTTP between every component, including the proxies and their upstreams
 *  - the real TypeScript SDK and the real Python SDK, over the network
 *  - a real browser driving the real UI
 *
 * Run it against a disposable stack. It creates tenants, keys, and audit records.
 */
const API = process.env.ACTIONGATE_URL ?? "http://localhost:8080";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const KEY = process.env.ACTIONGATE_API_KEY;
if (!KEY) throw new Error("ACTIONGATE_API_KEY is required (use the key printed by pnpm db:seed)");

const results: { area: string; check: string; ok: boolean; detail: string }[] = [];
const record = (area: string, check: string, ok: boolean, detail = "") => {
  results.push({ area, check, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${area} · ${check}${detail ? ` — ${detail}` : ""}`);
};

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { status: response.status, body: body as Record<string, unknown>, headers: response.headers };
}

function refundBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    tenantId: process.env.ACTIONGATE_TENANT_ID ?? "tenant-1",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "verify-live" },
    userIntent: { text: "Refund the duplicate $49 charge on txn_5512.", source: "user_message" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_5512", amountCents: 4900 }, riskClass: "FINANCIAL" },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" },
    ...overrides
  };
}

console.log(`\nVerifying ${API} (web ${WEB})\n`);

// ---------------------------------------------------------------- API core
console.log("API");
const ready = await api("/ready");
record("API", "ready with real dependencies", ready.status === 200,
  `storage=${String(ready.body.storage)} controlPlane=${String(ready.body.controlPlane)} provider=${String(ready.body.provider)}`);

const authorized = await api("/v1/authorize", { method: "POST", body: JSON.stringify(refundBody()) });
const decision = authorized.body as { decision?: string; decisionId?: string; grant?: { token: string; grantId: string }; model?: { provider?: string; resolvedModel?: string; usage?: { costUsd?: number } } };
record("API", "authorize returns a live decision", authorized.status === 200 && Boolean(decision.decisionId),
  `${decision.decision} via ${decision.model?.provider ?? "?"}/${decision.model?.resolvedModel ?? "?"}`);
record("API", "decision came from the live model, not a fixture", decision.model?.provider === "openrouter", `cost $${(decision.model?.usage?.costUsd ?? 0).toFixed(6)}`);
record("API", "enforced allow carries a grant", decision.decision !== "ALLOW" || Boolean(decision.grant));

if (decision.grant) {
  const consumePayload = {
    token: decision.grant.token,
    tenantId: refundBody().tenantId,
    environment: "development",
    actor: { agentId: "verify-live" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_5512", amountCents: 4900 }, riskClass: "FINANCIAL" }
  };
  const consumed = await api("/v1/grants/consume", { method: "POST", body: JSON.stringify(consumePayload) });
  record("API", "grant consumes once", consumed.status === 200);
  const replayed = await api("/v1/grants/consume", { method: "POST", body: JSON.stringify(consumePayload) });
  record("API", "replay is refused", replayed.status === 409, `HTTP ${replayed.status}`);

  const mutated = await api("/v1/authorize", { method: "POST", body: JSON.stringify(refundBody()) });
  const mutatedGrant = (mutated.body as { grant?: { token: string } }).grant;
  if (mutatedGrant) {
    const tampered = await api("/v1/grants/consume", {
      method: "POST",
      body: JSON.stringify({ ...consumePayload, token: mutatedGrant.token, proposedAction: { ...consumePayload.proposedAction, arguments: { transactionId: "txn_OTHER", amountCents: 4900 } } })
    });
    record("API", "mutated arguments are refused", tampered.status === 403, `HTTP ${tampered.status}`);
  }
}

const downgrade = await api("/v1/authorize", { method: "POST", body: JSON.stringify(refundBody({ proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_5512", amountCents: 4900 }, riskClass: "READ_ONLY" } })) });
record("API", "risk downgrade is refused", downgrade.status === 403, `HTTP ${downgrade.status}`);

const noFacts = await api("/v1/authorize", { method: "POST", body: JSON.stringify({ ...refundBody(), deterministicFacts: undefined }) });
record("API", "hard rules are not satisfied by silence", (noFacts.body as { decision?: string }).decision === "BLOCK",
  String((noFacts.body as { reasons?: { code: string }[] }).reasons?.[0]?.code));

// ------------------------------------------------------------- simulator
console.log("\nSimulator");
const simulated = await api("/v1/simulate", { method: "POST", body: JSON.stringify({ request: { actor: { agentId: "verify" }, userIntent: refundBody().userIntent, proposedAction: refundBody().proposedAction, deterministicFacts: refundBody().deterministicFacts } }) });
record("Simulator", "returns a decision", simulated.status === 200, String((simulated.body as { decision?: string }).decision));
record("Simulator", "issues no grant and stores nothing", !("grant" in (simulated.body as object)) && !JSON.stringify(simulated.body).includes("\"token\""));

// ------------------------------------------------------------- executions
console.log("\nExecution outcomes");
if (decision.decisionId) {
  const recorded = await api("/v1/executions", { method: "POST", body: JSON.stringify({ decisionId: decision.decisionId, status: "COMPLETED", externalRef: "verify-live" }) });
  record("Executions", "records an outcome", recorded.status === 201);
  const listed = await api(`/v1/executions?decisionId=${decision.decisionId}`);
  record("Executions", "outcome is readable", Array.isArray((listed.body as { data?: unknown[] }).data) && (listed.body as { data: unknown[] }).data.length > 0);
}

// -------------------------------------------------------- credential broker
console.log("\nCredential broker");
const brokerSecret = process.env.ACTIONGATE_CREDENTIAL_SECRET;
if (brokerSecret) {
  const forExchange = await api("/v1/authorize", { method: "POST", body: JSON.stringify(refundBody()) });
  const exchangeGrant = (forExchange.body as { grant?: { token: string } }).grant;
  if (exchangeGrant) {
    const exchanged = await api("/v1/grants/exchange", {
      method: "POST",
      body: JSON.stringify({
        token: exchangeGrant.token, tenantId: refundBody().tenantId, environment: "development",
        actor: { agentId: "verify-live" },
        proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_5512", amountCents: 4900 }, riskClass: "FINANCIAL" },
        ttlSeconds: 60, audience: "payments-api"
      })
    });
    const credential = (exchanged.body as { credential?: { headers: Record<string, string> } }).credential;
    record("Broker", "exchanges a grant for a credential", exchanged.status === 200 && Boolean(credential));
    if (credential) {
      const verified = verifySignedRequest({ headers: credential.headers, secrets: { [process.env.ACTIONGATE_CREDENTIAL_KID ?? "cred_1"]: brokerSecret } });
      record("Broker", "downstream can verify it independently", verified.valid === true);
      const tamperedHeaders = { ...credential.headers, "x-actiongate-grant-id": randomUUID() };
      record("Broker", "a tampered credential is refused", verifySignedRequest({ headers: tamperedHeaders, secrets: { [process.env.ACTIONGATE_CREDENTIAL_KID ?? "cred_1"]: brokerSecret } }).valid === false);
    }
  }
} else {
  record("Broker", "skipped", true, "set ACTIONGATE_CREDENTIAL_SECRET to exercise it");
}

// --------------------------------------------------------------- telemetry
console.log("\nTelemetry and governance");
const metrics = await api("/metrics");
const metricsText = String(metrics.body);
record("Metrics", "exposes decision counters", metrics.status === 200 && metricsText.includes("actiongate_decisions_total"));
record("Metrics", "never names the tenant", !metricsText.includes(refundBody().tenantId));

const exported = await api("/v1/audit/export");
const attestation = (exported.body as { attestation?: SignedExport }).attestation;
record("Audit", "export succeeds", exported.status === 200);
record("Audit", "export carries no grant token", !JSON.stringify(exported.body).includes("\"token\""));
if (attestation) {
  const evidenceKeys = JSON.parse(process.env.ACTIONGATE_EVIDENCE_KEYS ?? "{}") as Record<string, string>;
  record("Audit", "attestation verifies", verifyExport(attestation, evidenceKeys).valid === true, `${attestation.count} entries chained`);
  const broken = structuredClone(attestation);
  if (broken.entries.length > 0) {
    broken.entries[0]!.entry = { tampered: true };
    record("Audit", "a tampered export is detected", verifyExport(broken, evidenceKeys).valid === false);
  }
}

// ------------------------------------------------------------- TypeScript SDK
console.log("\nTypeScript SDK");
{
  const gate = new ActionGate({ apiKey: KEY, baseUrl: API });
  let executed = false;
  const guarded = gate.wrapTool({
    name: "refund_payment", operation: "refund", riskClass: "FINANCIAL",
    execute: async () => { executed = true; return { refunded: true }; },
    buildRequest: async () => ({
      requestId: randomUUID(), idempotencyKey: randomUUID(),
      tenantId: refundBody().tenantId, environment: "development" as const, mode: "enforce" as const,
      actor: { agentId: "verify-sdk" },
      userIntent: { text: "Refund the duplicate $49 charge on txn_5512.", source: "user_message" as const },
      deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
    })
  });
  try {
    await guarded({ transactionId: "txn_5512", amountCents: 4900 }, {});
    record("SDK (TS)", "guarded call reaches the handler over real HTTP", executed);
  } catch (error) {
    record("SDK (TS)", "guarded call reaches the handler over real HTTP", false, String(error).slice(0, 90));
  }

  // A transaction the user never named must not reach the handler.
  executed = false;
  const swapped = gate.wrapTool({
    name: "refund_payment", operation: "refund", riskClass: "FINANCIAL",
    execute: async () => { executed = true; return { refunded: true }; },
    buildRequest: async () => ({
      requestId: randomUUID(), idempotencyKey: randomUUID(),
      tenantId: refundBody().tenantId, environment: "development" as const, mode: "enforce" as const,
      actor: { agentId: "verify-sdk" },
      userIntent: { text: "Refund the duplicate $49 charge on txn_5512.", source: "user_message" as const },
      deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
    })
  });
  try { await swapped({ transactionId: "txn_NEVER_MENTIONED", amountCents: 4900 }, {}); } catch { /* denial is expected */ }
  record("SDK (TS)", "a target swap never reaches the handler", !executed);
}

// ----------------------------------------------------------------- Python SDK
console.log("\nPython SDK");
{
  const script = join(tmpdir(), `actiongate-verify-${randomUUID()}.py`);
  writeFileSync(script, `
import json, sys, uuid
sys.path.insert(0, ${JSON.stringify(new URL("../packages/sdk-python/src", import.meta.url).pathname)})
from actiongate import ActionGate, Actor, UserIntent, ActionGateError

gate = ActionGate(api_key=${JSON.stringify(KEY)}, base_url=${JSON.stringify(API)})
executed = {"asked": False, "swapped": False}

def build(arguments, runtime):
    return {
        "tenant_id": ${JSON.stringify(process.env.ACTIONGATE_TENANT_ID ?? "tenant-1")},
        "environment": "development",
        "mode": "enforce",
        "actor": Actor(agent_id="verify-python"),
        "user_intent": UserIntent(text="Refund the duplicate $49 charge on txn_5512."),
        "deterministic_facts": {"authenticated": True, "authorizedByRbac": True, "duplicate": False, "amountCents": 4900, "currency": "USD"},
    }

asked = gate.wrap_tool(name="refund_payment", operation="refund", risk_class="FINANCIAL",
                       execute=lambda a, r: executed.__setitem__("asked", True), build_request=build)
swapped = gate.wrap_tool(name="refund_payment", operation="refund", risk_class="FINANCIAL",
                         execute=lambda a, r: executed.__setitem__("swapped", True), build_request=build)

try:
    asked({"transactionId": "txn_5512", "amountCents": 4900})
except ActionGateError as error:
    pass
try:
    swapped({"transactionId": "txn_NEVER_MENTIONED", "amountCents": 4900})
except ActionGateError:
    pass

print(json.dumps(executed))
`);
  try {
    const output = execFileSync("python3", [script], { encoding: "utf8", timeout: 60_000 }).trim();
    const parsed = JSON.parse(output.split("\n").at(-1)!) as { asked: boolean; swapped: boolean };
    record("SDK (Python)", "guarded call reaches the handler over real HTTP", parsed.asked);
    record("SDK (Python)", "a target swap never reaches the handler", !parsed.swapped);
  } catch (error) {
    record("SDK (Python)", "runs against the live API", false, String(error).slice(0, 120));
  }
}

// -------------------------------------------------------------- MCP proxy
console.log("\nMCP proxy (real upstream over HTTP)");
{
  const upstreamCalls: string[] = [];
  const upstream = Fastify({ logger: false });
  upstream.post("/mcp", async (request) => {
    const body = request.body as { id: number; method: string; params?: { name?: string } };
    if (body.method === "tools/list") return { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "refund_payment" }, { name: "get_order" }] } };
    upstreamCalls.push(String(body.params?.name));
    return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } };
  });
  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });

  const proxy = createMcpProxyServer({
    client: new ActionGate({ apiKey: KEY, baseUrl: API }),
    registry: new ActionGateRegistry({ baseUrl: API, apiKey: KEY, cacheTtlMs: 0 }),
    upstream: new HttpMcpUpstream({ url: `${upstreamUrl}/mcp` }),
    resolvePrincipal: staticTokenResolver([{ token: "verify-proxy-token-0001", tenantId: refundBody().tenantId, environment: "development", actor: { agentId: "verify-mcp" } }]),
    logger: false
  });
  const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

  const call = async (name: string, args: Record<string, unknown>, intent: string) =>
    (await fetch(`${proxyUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer verify-proxy-token-0001", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "actiongate/intent": intent } } })
    })).json() as Promise<{ result?: unknown; error?: { code: number } }>;

  const listed = await (await fetch(`${proxyUrl}/mcp`, {
    method: "POST", headers: { Authorization: "Bearer verify-proxy-token-0001", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  })).json() as { result?: { tools: { name: string }[] } };
  record("MCP proxy", "lists registry-approved tools", (listed.result?.tools.length ?? 0) > 0, (listed.result?.tools ?? []).map((tool) => tool.name).join(", "));

  // get_order carries no hard rules. refund_payment does, and the proxy asserts
  // no deterministic facts of its own, so it correctly fails closed there — that
  // is checked separately below rather than treated as a proxy defect.
  const allowed = await call("get_order", { orderId: "8841" }, "Show me order 8841.");
  record("MCP proxy", "forwards an allowed call to the real upstream", Boolean(allowed.result) && upstreamCalls.length === 1,
    `upstream saw ${upstreamCalls.join(", ") || "nothing"}`);

  const hardRuled = await call("refund_payment", { transactionId: "txn_5512", amountCents: 4900 }, "Refund the duplicate $49 charge on txn_5512.");
  record("MCP proxy", "a hard-ruled tool fails closed without a fact provider", Boolean(hardRuled.error) && upstreamCalls.length === 1);

  const before = upstreamCalls.length;
  const anonymous = await (await fetch(`${proxyUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refund_payment", arguments: {} } }) })).json() as { error?: { code: number } };
  record("MCP proxy", "an unauthenticated caller never reaches upstream", anonymous.error?.code === -32001 && upstreamCalls.length === before);

  const unknown = await call("drop_database", {}, "Delete everything.");
  record("MCP proxy", "an unregistered tool never reaches upstream", unknown.error?.code === -32601 && upstreamCalls.length === before);

  await proxy.close();
  await upstream.close();
}

// -------------------------------------------------------------- HTTP proxy
console.log("\nHTTP proxy (real upstream over HTTP)");
{
  const upstreamHits: string[] = [];
  const upstream = Fastify({ logger: false });
  upstream.post("/refunds", async (request) => { upstreamHits.push(JSON.stringify(request.body)); return { refunded: true }; });
  upstream.get("/orders/:orderId", async (request) => { upstreamHits.push(JSON.stringify(request.params)); return { orderId: (request.params as { orderId: string }).orderId, status: "SHIPPED" }; });
  upstream.get("/admin/secrets", async () => ({ secrets: "should never be reachable" }));
  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });

  const proxy = createHttpProxyServer({
    client: new ActionGate({ apiKey: KEY, baseUrl: API }),
    registry: new ActionGateRegistry({ baseUrl: API, apiKey: KEY, cacheTtlMs: 0 }),
    upstream: new FetchHttpUpstream({ baseUrl: upstreamUrl }),
    resolvePrincipal: staticTokenResolver([{ token: "verify-http-token-0001", tenantId: refundBody().tenantId, environment: "development", actor: { agentId: "verify-http" } }]),
    routes: [
      { method: "GET", path: "/orders/:orderId", tool: "get_order" },
      { method: "POST", path: "/refunds", tool: "refund_payment" }
    ],
    logger: false
  });
  const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

  const allowed = await fetch(`${proxyUrl}/orders/8841`, {
    headers: { Authorization: "Bearer verify-http-token-0001", "X-ActionGate-Intent": "Show me order 8841." }
  });
  record("HTTP proxy", "forwards an allowed route to the real upstream", allowed.status === 200 && upstreamHits.length === 1,
    `decision ${allowed.headers.get("x-actiongate-decision-id")?.slice(0, 8) ?? "?"}`);

  // Same reasoning as the MCP proxy: no facts, so hard rules fail closed.
  const hardRuled = await fetch(`${proxyUrl}/refunds`, {
    method: "POST",
    headers: { Authorization: "Bearer verify-http-token-0001", "Content-Type": "application/json", "X-ActionGate-Intent": "Refund the duplicate $49 charge on txn_5512." },
    body: JSON.stringify({ transactionId: "txn_5512", amountCents: 4900 })
  });
  record("HTTP proxy", "a hard-ruled route fails closed without a fact provider", hardRuled.status === 403 && upstreamHits.length === 1);

  const unmapped = await fetch(`${proxyUrl}/admin/secrets`, { headers: { Authorization: "Bearer verify-http-token-0001" } });
  record("HTTP proxy", "an unmapped route is not a pass-through", unmapped.status === 404 && upstreamHits.length === 1);

  const anonymous = await fetch(`${proxyUrl}/orders/8841`, {});
  record("HTTP proxy", "an unauthenticated caller is refused", anonymous.status === 401 && upstreamHits.length === 1);

  await proxy.close();
  await upstream.close();
}

// ---------------------------------------------------------------------- UI
if (process.env.VERIFY_UI !== "false") {
  console.log("\nUI (real browser against the live stack)");
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1040, height: 840 } });

    await page.goto(WEB);
    // The counter renders 0 before the fetch resolves, so wait for a real row
    // rather than reading the first value that appears.
    let rows = 0;
    try {
      await page.waitForFunction(() => document.querySelectorAll(".row:not(.headings)").length > 0, { timeout: 20_000 });
      rows = await page.locator(".row:not(.headings)").count();
    } catch { /* leave at zero so the check fails */ }
    record("UI", "dashboard loads real decisions", rows > 0, `${rows} rows`);
    record("UI", "dashboard shows no offline notice", (await page.locator(".notice").count()) === 0);

    await page.goto(`${WEB}/simulator`);
    const simulate = async (preset?: string) => {
      if (preset) await page.getByRole("button", { name: preset }).click();
      await page.getByRole("button", { name: "Simulate" }).click();
      await page.waitForSelector(".verdict .pill", { timeout: 30_000 });
      return {
        decision: (await page.locator(".verdict .pill").textContent())?.trim(),
        reason: (await page.locator(".reasons .row:not(.headings) code").first().textContent())?.trim()
      };
    };
    const asked = await simulate();
    record("UI", "simulator allows the action the user asked for", asked.decision === "ALLOW", `${asked.decision} / ${asked.reason}`);
    const swapped = await simulate("A different transaction");
    record("UI", "simulator refuses a transaction the user never named", swapped.decision !== "ALLOW", `${swapped.decision} / ${swapped.reason}`);
    const question = await simulate("A question, not a request");
    record("UI", "simulator refuses a question treated as a request", question.decision !== "ALLOW", `${question.decision} / ${question.reason}`);
    record("UI", "the page never receives a grant", !(await page.content()).includes("grantId"));

    await browser.close();
  } catch (error) {
    record("UI", "browser checks run", false, String(error).slice(0, 120));
  }
}

// ------------------------------------------------------------------ report
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("\nFailures:");
  for (const failure of failed) console.log(`  ${failure.area} · ${failure.check} ${failure.detail}`);
  process.exitCode = 1;
}

