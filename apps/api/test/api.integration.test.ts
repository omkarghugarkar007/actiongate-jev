import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { DEFAULT_POLICY } from "@actiongate/core";
import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];
const body = { requestId: "req-api", idempotencyKey: "idem-api-001", tenantId: "tenant-1", environment: "development", mode: "enforce", actor: { agentId: "agent" }, userIntent: { text: "Refund the duplicate charge", source: "user_message" }, proposedAction: { tool: "refund_payment", operation: "refund", arguments: { amountCents: 4900 }, riskClass: "FINANCIAL" }, deterministicFacts: { authenticated: true, authorizedByRbac: true, amountCents: 4900, currency: "USD" } };
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("POST /v1/authorize", () => {
  it("authorizes and replays an identical request", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const first = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123", "idempotency-key": body.idempotencyKey }, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: body });
    expect(first.statusCode).toBe(200); expect(second.json().decisionId).toBe(first.json().decisionId);
  });
  it("rejects a key reused for another body", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: body });
    const conflict = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: { ...body, proposedAction: { ...body.proposedAction, arguments: { amountCents: 5000 } } } });
    expect(conflict.statusCode).toBe(409);
  });
  it("requires authentication", async () => { const app = buildApp({ apiKey: "ag_test_123" }); apps.push(app); expect((await app.inject({ method: "GET", url: "/v1/policies" })).statusCode).toBe(401); });
  it("rejects malformed input and mismatched header keys", async () => {
    const app = buildApp({ apiKey: "ag_test_123" }); apps.push(app);
    const headers = { authorization: "Bearer ag_test_123" };
    expect((await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/authorize", headers: { ...headers, "idempotency-key": "different-key" }, payload: body })).statusCode).toBe(409);
  });
  it("persists sanitized decisions for detail retrieval and includes provider cost", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const headers = { authorization: "Bearer ag_test_123" };
    const created = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: { ...body, proposedAction: { ...body.proposedAction, arguments: { amountCents: 4900, token: "must-not-persist" } } } });
    const decision = created.json();
    expect(decision.model.usage.inputTokens).toBe(100);
    const detail = await app.inject({ method: "GET", url: `/v1/decisions/${decision.decisionId}?tenantId=tenant-1`, headers });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain("must-not-persist");
  });
  it("returns operational ALLOW with a shadow BLOCK finding", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.scopeExpansion(), apiKey: "ag_test_123" }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: { ...body, mode: "shadow", idempotencyKey: "idem-shadow-001" } });
    expect(response.json()).toMatchObject({ decision: "ALLOW", wouldHaveDecision: "BLOCK", mode: "shadow" });
  });
  it("keeps policy versions immutable", async () => {
    const app = buildApp({ apiKey: "ag_test_123" }); apps.push(app);
    const headers = { authorization: "Bearer ag_test_123" };
    const next = { ...structuredClone(DEFAULT_POLICY), version: "1.0.1" };
    expect((await app.inject({ method: "POST", url: `/v1/policies/${next.id}/versions`, headers, payload: next })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/policies/${next.id}/versions`, headers, payload: next })).statusCode).toBe(409);
  });
});
