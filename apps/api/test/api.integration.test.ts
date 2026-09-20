import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { ActionGrantSigner, DEFAULT_POLICY, type AuthorizationRequest, type DecisionProvider } from "@actiongate/core";
import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];
const body = { requestId: "req-api", idempotencyKey: "idem-api-001", tenantId: "tenant-1", environment: "development", mode: "enforce", actor: { agentId: "agent" }, userIntent: { text: "Refund the duplicate charge", source: "user_message" }, proposedAction: { tool: "refund_payment", operation: "refund", arguments: { amountCents: 4900 }, riskClass: "FINANCIAL" }, deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" } };
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("POST /v1/authorize", () => {
  it("authorizes and replays an identical request", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const first = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123", "idempotency-key": body.idempotencyKey }, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.json().grant.token).toMatch(/^ag1\./);
    expect(second.json().decisionId).toBe(first.json().decisionId);
    expect(second.json().grant).toEqual(first.json().grant);
  });
  it("rejects a key reused for another body", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: body });
    const conflict = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: { ...body, proposedAction: { ...body.proposedAction, arguments: { amountCents: 5000 } } } });
    expect(conflict.statusCode).toBe(409);
  });
  it("rejects a different payload racing on the same in-flight key", async () => {
    const fake = FakeDecisionProvider.allow();
    let calls = 0;
    const provider: DecisionProvider = {
      async evaluate(request) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return fake.evaluate(request);
      }
    };
    const app = buildApp({ provider, apiKey: "ag_test_123" }); apps.push(app);
    const changed = { ...body, proposedAction: { ...body.proposedAction, arguments: { amountCents: 5000 } } };
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: body }),
      app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: changed })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(calls).toBe(1);
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
    expect(JSON.stringify(detail.json())).not.toContain(decision.grant.token);
  });
  it("returns operational ALLOW with a shadow BLOCK finding", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.scopeExpansion(), apiKey: "ag_test_123" }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_123" }, payload: { ...body, mode: "shadow", idempotencyKey: "idem-shadow-001" } });
    expect(response.json()).toMatchObject({ decision: "ALLOW", wouldHaveDecision: "BLOCK", mode: "shadow" });
    expect(response.json().grant).toBeUndefined();
  });
  it("keeps policy versions immutable", async () => {
    const app = buildApp({ apiKey: "ag_test_123" }); apps.push(app);
    const headers = { authorization: "Bearer ag_test_123" };
    const next = { ...structuredClone(DEFAULT_POLICY), version: "1.0.1" };
    expect((await app.inject({ method: "POST", url: `/v1/policies/${next.id}/versions`, headers, payload: next })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/policies/${next.id}/versions`, headers, payload: next })).statusCode).toBe(409);
  });
});

describe("POST /v1/grants/consume", () => {
  const headers = { authorization: "Bearer ag_test_123" };

  it("consumes an exact-action grant once and rejects replay", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const authorized = (await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    const payload = grantConsumption(authorized.grant.token);
    const first = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ grantId: authorized.grant.grantId, decisionId: authorized.decisionId, status: "CONSUMED" });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("GRANT_ALREADY_CONSUMED");
  });

  it("rejects changed action arguments without consuming the grant", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const authorized = (await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    const changed = grantConsumption(authorized.grant.token);
    changed.proposedAction.arguments = { amountCents: 5000 };
    const mismatch = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: changed });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe("GRANT_BINDING_MISMATCH");
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: grantConsumption(authorized.grant.token) })).statusCode).toBe(200);
  });

  it("rejects a tampered token", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const authorized = (await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    const token = authorized.grant.token as string;
    const [prefix, payload, signature] = token.split(".") as [string, string, string];
    const tampered = `${prefix}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const response = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: grantConsumption(tampered) });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("GRANT_INVALID_SIGNATURE");
  });

  it("rejects an expired grant", async () => {
    let now = Date.parse("2026-09-19T10:00:00.000Z");
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123", grantTtlSeconds: 2, clock: () => now }); apps.push(app);
    const authorized = (await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    now += 2_000;
    const response = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: grantConsumption(authorized.grant.token) });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("GRANT_EXPIRED");
  });

  it("rejects a validly signed grant that was never issued by this service", async () => {
    const grantSecret = "integration-grant-secret-with-at-least-32-bytes";
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123", grantSecret }); apps.push(app);
    const signer = new ActionGrantSigner({ secret: grantSecret });
    const syntheticRequest = body as AuthorizationRequest;
    const { grant } = signer.issue(syntheticRequest, {
      requestId: body.requestId,
      decisionId: "b97b9473-f25c-4ba5-88c3-c0642c0a4541",
      decision: "ALLOW",
      mode: "enforce",
      riskClass: "FINANCIAL",
      reasons: [],
      signals: { deterministic: {} },
      timing: { totalMs: 1, deterministicMs: 1 },
      policy: { id: DEFAULT_POLICY.id, version: DEFAULT_POLICY.version },
      createdAt: new Date().toISOString()
    });
    const response = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: grantConsumption(grant.token) });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("GRANT_NOT_FOUND");
  });

  it("requires authentication and a valid consumption envelope", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: {} })).statusCode).toBe(400);
  });

  it("allows exactly one of two concurrent consumption attempts", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(app);
    const authorized = (await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    const payload = grantConsumption(authorized.grant.token);
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload }),
      app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it("does not issue grants for blocked, reviewed, or shadow decisions", async () => {
    const blocked = buildApp({ provider: FakeDecisionProvider.scopeExpansion(), apiKey: "ag_test_123" }); apps.push(blocked);
    const reviewed = buildApp({ provider: FakeDecisionProvider.missingIntent(), apiKey: "ag_test_123" }); apps.push(reviewed);
    const shadow = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_test_123" }); apps.push(shadow);
    const blockedBody = (await blocked.inject({ method: "POST", url: "/v1/authorize", headers, payload: body })).json();
    const reviewedBody = (await reviewed.inject({ method: "POST", url: "/v1/authorize", headers, payload: { ...body, idempotencyKey: "idem-review-001" } })).json();
    const shadowBody = (await shadow.inject({ method: "POST", url: "/v1/authorize", headers, payload: { ...body, mode: "shadow", idempotencyKey: "idem-shadow-002" } })).json();
    expect(blockedBody).toMatchObject({ decision: "BLOCK" });
    expect(reviewedBody).toMatchObject({ decision: "REVIEW" });
    expect(shadowBody).toMatchObject({ decision: "ALLOW", mode: "shadow" });
    expect(blockedBody.grant).toBeUndefined();
    expect(reviewedBody.grant).toBeUndefined();
    expect(shadowBody.grant).toBeUndefined();
  });
});

function grantConsumption(token: string) {
  return {
    token,
    tenantId: body.tenantId,
    environment: body.environment,
    actor: { agentId: body.actor.agentId },
    proposedAction: structuredClone(body.proposedAction)
  };
}
