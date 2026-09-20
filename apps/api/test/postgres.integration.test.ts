import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { DEFAULT_POLICY, FunctionFactProvider, type DecisionProvider } from "@actiongate/core";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";
import { EvidenceCipher } from "../src/security/evidence-cipher.js";
import { API_ROLES, defaultToolRegistrations } from "../src/services/control-plane.js";
import { PostgresControlPlaneRepository } from "../src/services/postgres-control-plane.js";

const enabled = process.env.RUN_POSTGRES_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://actiongate:actiongate@localhost:5432/actiongate";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const pool = enabled ? new Pool({ connectionString: databaseUrl }) : undefined;
const redis = enabled ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : undefined;
const tenantA = `tenant-pg-a-${randomUUID()}`;
const tenantB = `tenant-pg-b-${randomUUID()}`;
const redisPrefix = `actiongate-pg-${randomUUID()}`;
const evidenceKeys = [{ id: "evidence-1", secret: "postgres-integration-evidence-key-at-least-32-bytes" }];
const oldGrantKey = { id: "grant-old", secret: "postgres-old-grant-key-at-least-32-bytes" };
const nextGrantKey = { id: "grant-next", secret: "postgres-next-grant-key-at-least-32-bytes" };
const apps: ReturnType<typeof buildApp>[] = [];
const trustedFacts = new FunctionFactProvider({
  name: "postgres-test-ledger",
  resolve: ({ request }) => ({
    authenticated: true,
    authorizedByRbac: true,
    duplicate: false,
    amountCents: Number(request.proposedAction.arguments.amountCents),
    currency: "USD"
  })
});
let tokenA = "";
let tokenB = "";
let limitedTokenA = "";
let limitedKeyId = "";

beforeAll(async () => {
  if (!pool) return;
  await pool.query("INSERT INTO tenants (slug, name) VALUES ($1, $2), ($3, $4)", [tenantA, "Postgres tenant A", tenantB, "Postgres tenant B"]);
  const repository = controlPlane();
  for (const tenantId of [tenantA, tenantB]) {
    await repository.addPolicy(tenantId, DEFAULT_POLICY, "test-bootstrap");
    for (const tool of defaultToolRegistrations().values()) {
      const input = {
        name: tool.name, operation: tool.operation, riskClass: tool.riskClass, argumentSchema: tool.argumentSchema,
        owner: tool.owner, dataSensitivity: tool.dataSensitivity, policyId: tool.policyId, policyVersion: tool.policyVersion, enabled: tool.enabled
      };
      await repository.putTool(tenantId, input, "test-bootstrap");
    }
  }
  tokenA = (await repository.createApiKey({ tenantId: tenantA, name: "tenant-a-admin", environment: "development", roles: [...API_ROLES] })).token;
  tokenB = (await repository.createApiKey({ tenantId: tenantB, name: "tenant-b-admin", environment: "development", roles: [...API_ROLES] })).token;
  const limited = await repository.createApiKey({ tenantId: tenantA, name: "tenant-a-runtime", environment: "development", roles: ["authorize", "consume"] });
  limitedTokenA = limited.token;
  limitedKeyId = limited.key.id;
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (redis) {
    const keys = await redis.keys(`${redisPrefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
  if (pool) {
    const tenantRows = await pool.query<{ id: string }>("SELECT id::text FROM tenants WHERE slug = ANY($1::text[])", [[tenantA, tenantB]]);
    const tenantIds = tenantRows.rows.map((row) => row.id);
    if (tenantIds.length) {
      await pool.query("DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM decision_corrections WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM reviews WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM tool_registry WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM api_keys WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM policy_versions WHERE policy_id IN (SELECT id FROM policies WHERE tenant_id = ANY($1::uuid[]))", [tenantIds]);
      await pool.query("DELETE FROM policies WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
    }
    await pool.end();
  }
});

describe.skipIf(!enabled)("PostgreSQL tenant control plane with Redis enforcement", () => {
  it("persists tenant identity, registry, policy, encrypted audit, rotation, revocation, and retention across API restarts", async () => {
    let providerCalls = 0;
    const fake = FakeDecisionProvider.allow();
    const provider: DecisionProvider = { async evaluate(request) { providerCalls += 1; return fake.evaluate(request); } };
    const first = appWith({ provider, grantKeys: [oldGrantKey], grantActiveKeyId: oldGrantKey.id });
    apps.push(first);
    const body = authorizationBody("durable");
    const authorizationResponse = await authorize(first, tokenA, body);
    expect(authorizationResponse.statusCode).toBe(200);
    const authorization = authorizationResponse.json();
    expect(authorization.grant.token).toMatch(/^ag2\.grant-old\./);

    const crossTenantRead = await first.inject({ method: "GET", url: `/v1/decisions/${authorization.decisionId}?tenantId=${tenantA}`, headers: auth(tokenB) });
    expect(crossTenantRead.statusCode).toBe(403);
    const crossTenantConsume = await first.inject({ method: "POST", url: "/v1/grants/consume", headers: auth(tokenB), payload: consumeBody(authorization.grant.token, body) });
    expect(crossTenantConsume.statusCode).toBe(403);

    const nextPolicy = { ...structuredClone(DEFAULT_POLICY), version: "1.0.1" };
    expect((await first.inject({ method: "POST", url: `/v1/policies/${nextPolicy.id}/versions`, headers: auth(tokenA), payload: nextPolicy })).statusCode).toBe(201);
    expect((await first.inject({ method: "POST", url: `/v1/decisions/${authorization.decisionId}/override`, headers: auth(tokenA), payload: { correctDecision: "REVIEW", reason: "Encrypted operator correction" } })).statusCode).toBe(201);

    const rawAudit = await pool!.query<{ payload: string }>("SELECT payload_encrypted::text AS payload FROM audit_events ae JOIN tenants t ON t.id = ae.tenant_id WHERE t.slug = $1", [tenantA]);
    expect(rawAudit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rawAudit.rows)).not.toContain("durable private customer request");
    expect(JSON.stringify(rawAudit.rows)).not.toContain("Encrypted operator correction");
    const redisKeys = await redis!.keys(`${redisPrefix}:decision:*`);
    const rawRedis = redisKeys.length ? await redis!.mget(redisKeys) : [];
    expect(JSON.stringify(rawRedis)).not.toContain("durable private customer request");

    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const restarted = appWith({ provider, grantKeys: [oldGrantKey, nextGrantKey], grantActiveKeyId: nextGrantKey.id });
    apps.push(restarted);
    expect((await restarted.inject({ method: "GET", url: `/v1/decisions/${authorization.decisionId}`, headers: auth(tokenA) })).statusCode).toBe(200);
    const policies = await restarted.inject({ method: "GET", url: "/v1/policies", headers: auth(tokenA) });
    expect(policies.json().data.map((policy: { version: string }) => policy.version)).toContain("1.0.1");
    const auditExport = await restarted.inject({ method: "GET", url: "/v1/audit/export", headers: auth(tokenA) });
    expect(auditExport.body).not.toContain(authorization.grant.token);
    expect(auditExport.json().events.map((event: { eventType: string }) => event.eventType)).toContain("decision.overridden");

    expect((await restarted.inject({ method: "POST", url: "/v1/grants/consume", headers: auth(tokenA), payload: consumeBody(authorization.grant.token, body) })).statusCode).toBe(200);
    const newAuthorization = (await authorize(restarted, tokenA, authorizationBody("new-key"))).json();
    expect(newAuthorization.grant.token).toMatch(/^ag2\.grant-next\./);
    expect((await restarted.inject({ method: "POST", url: `/v1/grants/${newAuthorization.grant.grantId}/revoke`, headers: auth(tokenA) })).statusCode).toBe(200);
    const revokedConsumption = await restarted.inject({ method: "POST", url: "/v1/grants/consume", headers: auth(tokenA), payload: consumeBody(newAuthorization.grant.token, authorizationBody("new-key")) });
    expect(revokedConsumption.statusCode).toBe(403);
    expect(revokedConsumption.json().error.code).toBe("GRANT_REVOKED");

    expect((await authorize(restarted, limitedTokenA, authorizationBody("before-revoke"))).statusCode).toBe(200);
    expect((await restarted.inject({ method: "POST", url: `/v1/api-keys/${limitedKeyId}/revoke`, headers: auth(tokenA) })).statusCode).toBe(200);
    expect((await authorize(restarted, limitedTokenA, authorizationBody("after-revoke"))).statusCode).toBe(401);

    const indexKey = `${redisPrefix}:decision:tenant:${createHash("sha256").update(tenantA).digest("hex")}`;
    await redis!.zadd(indexKey, Date.parse("2020-01-01T00:00:00.000Z"), authorization.decisionId);
    const retained = await restarted.inject({ method: "DELETE", url: `/v1/audit/retention?before=${encodeURIComponent("2021-01-01T00:00:00.000Z")}`, headers: auth(tokenA) });
    expect(retained.statusCode).toBe(200);
    expect(retained.json().decisionsMinimized).toBe(1);
    expect((await restarted.inject({ method: "GET", url: `/v1/decisions/${authorization.decisionId}`, headers: auth(tokenA) })).statusCode).toBe(404);
    const idempotentRetry = await authorize(restarted, tokenA, body);
    expect(idempotentRetry.json().decisionId).toBe(authorization.decisionId);
    expect(providerCalls).toBe(3);
  });
});

function controlPlane() { return new PostgresControlPlaneRepository(pool!, new EvidenceCipher(evidenceKeys, evidenceKeys[0]!.id)); }
function appWith(input: { provider: DecisionProvider; grantKeys: typeof evidenceKeys; grantActiveKeyId: string }) {
  return buildApp({
    provider: input.provider,
    controlPlane: controlPlane(),
    storage: "redis",
    redisUrl,
    redisPrefix,
    evidenceKeys,
    evidenceActiveKeyId: evidenceKeys[0]!.id,
    grantKeys: input.grantKeys,
    grantActiveKeyId: input.grantActiveKeyId,
    factProviders: [trustedFacts],
    logger: false,
    rateLimitMax: 10_000
  });
}
function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function authorize(app: ReturnType<typeof buildApp>, token: string, payload: ReturnType<typeof authorizationBody>) {
  return app.inject({ method: "POST", url: "/v1/authorize", headers: { ...auth(token), "idempotency-key": payload.idempotencyKey }, payload });
}
function authorizationBody(suffix: string) {
  return {
    requestId: `request-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    tenantId: tenantA,
    environment: "development" as const,
    mode: "enforce" as const,
    actor: { agentId: "refund-agent", userId: "user-42", sessionId: "session-1" },
    userIntent: { text: `${suffix} private customer request`, source: "user_message" as const },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: `txn-${suffix}`, amountCents: 4900 }, riskClass: "FINANCIAL" as const },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" },
    policyVersion: "1.0.0"
  };
}
function consumeBody(token: string, body: ReturnType<typeof authorizationBody>) {
  return { token, tenantId: body.tenantId, environment: body.environment, actor: body.actor, proposedAction: body.proposedAction };
}
