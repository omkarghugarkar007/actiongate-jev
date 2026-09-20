import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";
import { Telemetry } from "../src/services/telemetry.js";
import { QuotaEnforcer } from "../src/services/quota.js";
import { API_ROLES } from "../src/services/control-plane.js";

const KEY = "ag_metrics_test";
const headers = { authorization: `Bearer ${KEY}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function build(overrides: Parameters<typeof buildApp>[0] = {}) {
  const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: KEY, apiKeyTenantId: "tenant-metrics", apiKeyRoles: [...API_ROLES], logger: false, ...overrides });
  apps.push(app);
  return app;
}

function readRequest() {
  return {
    requestId: randomUUID(), idempotencyKey: randomUUID(), tenantId: "tenant-metrics",
    environment: "development", mode: "enforce", actor: { agentId: "agent" },
    userIntent: { text: "Show me order 1", source: "user_message" },
    proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "1" }, riskClass: "READ_ONLY" }
  };
}

describe("Telemetry", () => {
  it("hashes tenant identifiers so a scrape never names a customer", () => {
    const telemetry = new Telemetry("salt");
    const label = telemetry.tenantLabel("acme-corporation");
    expect(label).not.toContain("acme");
    expect(label).toHaveLength(16);
    // Stable, so per-tenant series still work.
    expect(telemetry.tenantLabel("acme-corporation")).toBe(label);
    expect(telemetry.tenantLabel("other-corp")).not.toBe(label);
  });

  it("renders counters and histograms in Prometheus format", () => {
    const telemetry = new Telemetry("salt");
    telemetry.increment("actiongate_decisions_total", "Decisions.", { decision: "ALLOW" });
    telemetry.increment("actiongate_decisions_total", "Decisions.", { decision: "ALLOW" });
    telemetry.observe("actiongate_decision_duration_ms", "Latency.", 30, { tenant: "abc" });
    const output = telemetry.render();
    expect(output).toContain("# TYPE actiongate_decisions_total counter");
    expect(output).toContain('actiongate_decisions_total{decision="ALLOW"} 2');
    expect(output).toContain("# TYPE actiongate_decision_duration_ms histogram");
    expect(output).toContain('actiongate_decision_duration_ms_bucket{le="50",tenant="abc"} 1');
    expect(output).toContain('actiongate_decision_duration_ms_bucket{le="10",tenant="abc"} 0');
    expect(output).toContain('actiongate_decision_duration_ms_count{tenant="abc"} 1');
  });

  it("escapes label values so a crafted value cannot break the exposition format", () => {
    const telemetry = new Telemetry("salt");
    telemetry.increment("actiongate_test_total", "Test.", { reason: 'a"b\nc' });
    expect(telemetry.render()).toContain('reason="a\\"b\\nc"');
  });
});

describe("QuotaEnforcer", () => {
  it("allows up to the limit then rejects with a retry hint", () => {
    let now = 1_000_000;
    const quotas = new QuotaEnforcer({ acme: { authorizePerMinute: 2 } }, {}, () => now);
    expect(quotas.checkAuthorize("acme").allowed).toBe(true);
    expect(quotas.checkAuthorize("acme").allowed).toBe(true);
    const rejected = quotas.checkAuthorize("acme");
    expect(rejected).toMatchObject({ allowed: false, reason: "RATE_LIMIT" });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    now += 61_000;
    expect(quotas.checkAuthorize("acme").allowed).toBe(true);
  });

  it("counts a rejected attempt, so probing the limit is not free", () => {
    let now = 1_000_000;
    const quotas = new QuotaEnforcer({ acme: { authorizePerMinute: 1 } }, {}, () => now);
    quotas.checkAuthorize("acme");
    quotas.checkAuthorize("acme");
    now += 30_000;
    // Still inside the window and still over, rather than reset by the probe.
    expect(quotas.checkAuthorize("acme").allowed).toBe(false);
  });

  it("stops a tenant once its daily provider budget is spent", () => {
    let now = 1_000_000;
    const quotas = new QuotaEnforcer({ acme: { providerCostUsdPerDay: 0.01 } }, {}, () => now);
    expect(quotas.checkCostBudget("acme").allowed).toBe(true);
    quotas.recordCost("acme", 0.009);
    expect(quotas.checkCostBudget("acme").allowed).toBe(true);
    quotas.recordCost("acme", 0.002);
    expect(quotas.checkCostBudget("acme")).toMatchObject({ allowed: false, reason: "COST_BUDGET" });
    now += 86_400_001;
    expect(quotas.checkCostBudget("acme").allowed).toBe(true);
    expect(quotas.spendToday("acme")).toBe(0);
  });

  it("applies defaults but lets a tenant override them", () => {
    const quotas = new QuotaEnforcer({ vip: { authorizePerMinute: 100 } }, { authorizePerMinute: 1 });
    expect(quotas.quotaFor("vip").authorizePerMinute).toBe(100);
    expect(quotas.quotaFor("someone-else").authorizePerMinute).toBe(1);
  });

  it("does not limit a tenant with no quota configured", () => {
    const quotas = new QuotaEnforcer({});
    for (let index = 0; index < 50; index += 1) expect(quotas.checkAuthorize("free").allowed).toBe(true);
  });
});

describe("metrics endpoint", () => {
  it("records decisions and grants, and never exposes the tenant slug", async () => {
    const app = build();
    await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: readRequest() });
    const metrics = await app.inject({ method: "GET", url: "/metrics", headers });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("actiongate_decisions_total");
    expect(metrics.body).toContain("actiongate_grants_issued_total");
    expect(metrics.body).toContain("actiongate_decision_duration_ms_count");
    expect(metrics.body).not.toContain("tenant-metrics");
  });

  it("is role-gated rather than open to anyone who can reach the port", async () => {
    const app = build({ apiKeyRoles: ["authorize", "consume"] });
    expect((await app.inject({ method: "GET", url: "/metrics", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
  });

  it("rejects an over-quota tenant before spending anything with the provider", async () => {
    const provider = FakeDecisionProvider.allow();
    const app = build({ provider, quotas: { "tenant-metrics": { authorizePerMinute: 1 } } });
    expect((await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: readRequest() })).statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: readRequest() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect(limited.json().error.code).toBe("RATE_LIMIT");
    // The provider saw only the request that was allowed through.
    expect(provider.calls).toBe(1);
  });
});
