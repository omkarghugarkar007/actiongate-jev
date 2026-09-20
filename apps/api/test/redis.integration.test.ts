import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { FunctionFactProvider, type DecisionProvider } from "@actiongate/core";
import { buildApp } from "../src/app.js";

const enabled = process.env.RUN_REDIS_TESTS === "true";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const cleanup = enabled ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : undefined;
const apps: ReturnType<typeof buildApp>[] = [];
const prefixes: string[] = [];
const trustedFacts = new FunctionFactProvider({
  name: "redis-test-ledger",
  resolve: ({ request }) => ({
    authenticated: true,
    authorizedByRbac: true,
    duplicate: false,
    amountCents: Number(request.proposedAction.arguments.amountCents),
    currency: "USD"
  })
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (!cleanup) return;
  for (const prefix of prefixes.splice(0)) {
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.del(...keys);
  }
});
afterAll(async () => { if (cleanup) await cleanup.quit(); });

describe.skipIf(!enabled)("Redis cross-instance enforcement", () => {
  it("deduplicates authorization, persists restarts, and permits one cross-instance consumer", async () => {
    const prefix = `actiongate-test-${randomUUID()}`;
    prefixes.push(prefix);
    let providerCalls = 0;
    const fake = FakeDecisionProvider.allow();
    const provider: DecisionProvider = {
      async evaluate(request) {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fake.evaluate(request);
      }
    };
    const common = {
      provider,
      apiKey: "ag_redis_test",
      apiKeyTenantId: "tenant-redis",
      grantSecret: "redis-integration-grant-secret-at-least-32-bytes",
      storage: "redis" as const,
      redisUrl,
      redisPrefix: prefix,
      factProviders: [trustedFacts],
      logger: false,
      rateLimitMax: 10_000
    };
    const firstApp = buildApp(common);
    const secondApp = buildApp(common);
    apps.push(firstApp, secondApp);
    const body = authorizationBody("shared");

    const [first, second] = await Promise.all([
      authorize(firstApp, body),
      authorize(secondApp, body)
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.json().decisionId).toBe(first.json().decisionId);
    expect(second.json().grant).toEqual(first.json().grant);
    expect(providerCalls).toBe(1);

    const payload = consumptionBody(first.json().grant.token, body);
    const consumption = await Promise.all([
      consume(firstApp, payload),
      consume(secondApp, payload)
    ]);
    expect(consumption.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    await firstApp.close();
    await secondApp.close();
    apps.splice(0);
    const restarted = buildApp(common);
    apps.push(restarted);
    const replayedAuthorization = await authorize(restarted, body);
    expect(replayedAuthorization.json().decisionId).toBe(first.json().decisionId);
    expect(replayedAuthorization.json().grant).toEqual(first.json().grant);
    expect(providerCalls).toBe(1);
    expect((await consume(restarted, payload)).statusCode).toBe(409);

    const detail = await restarted.inject({
      method: "GET",
      url: `/v1/decisions/${first.json().decisionId}?tenantId=tenant-redis`,
      headers: authHeaders
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(first.json().grant.token);
    expect((await restarted.inject({ method: "GET", url: "/ready" })).json()).toMatchObject({ status: "ready", storage: "redis" });
  });

  it("rejects different payloads racing on one distributed idempotency key", async () => {
    const prefix = `actiongate-test-${randomUUID()}`;
    prefixes.push(prefix);
    const fake = FakeDecisionProvider.allow();
    let providerCalls = 0;
    const provider: DecisionProvider = {
      async evaluate(request) {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fake.evaluate(request);
      }
    };
    const common = {
      provider,
      apiKey: "ag_redis_test",
      apiKeyTenantId: "tenant-redis",
      grantSecret: "redis-integration-grant-secret-at-least-32-bytes",
      storage: "redis" as const,
      redisUrl,
      redisPrefix: prefix,
      factProviders: [trustedFacts],
      logger: false
    };
    const firstApp = buildApp(common);
    const secondApp = buildApp(common);
    apps.push(firstApp, secondApp);
    const original = authorizationBody("conflict");
    const changed = { ...original, proposedAction: { ...original.proposedAction, arguments: { transactionId: "txn-other", amountCents: 4900 } } };
    const responses = await Promise.all([authorize(firstApp, original), authorize(secondApp, changed)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(providerCalls).toBe(1);
  });
});

const authHeaders = { authorization: "Bearer ag_redis_test" };

function authorizationBody(suffix: string) {
  return {
    requestId: `request-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    tenantId: "tenant-redis",
    environment: "development" as const,
    mode: "enforce" as const,
    actor: { agentId: "refund-agent", userId: "user-42", sessionId: "session-1" },
    userIntent: { text: "Refund the duplicate $49 charge", source: "user_message" as const },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: `txn-${suffix}`, amountCents: 4900 }, riskClass: "FINANCIAL" as const },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
  };
}

function consumptionBody(token: string, body: ReturnType<typeof authorizationBody>) {
  return { token, tenantId: body.tenantId, environment: body.environment, actor: structuredClone(body.actor), proposedAction: structuredClone(body.proposedAction) };
}

function authorize(app: ReturnType<typeof buildApp>, payload: ReturnType<typeof authorizationBody>) {
  return app.inject({ method: "POST", url: "/v1/authorize", headers: authHeaders, payload });
}

function consume(app: ReturnType<typeof buildApp>, payload: ReturnType<typeof consumptionBody>) {
  return app.inject({ method: "POST", url: "/v1/grants/consume", headers: authHeaders, payload });
}
