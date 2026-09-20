import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { API_ROLES, InMemoryControlPlaneRepository } from "../src/services/control-plane.js";
import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("P0 tenant and registry enforcement", () => {
  it("rejects cross-tenant, cross-environment, risk-downgrade, unknown-tool, and invalid-argument requests before provider evaluation", async () => {
    let providerCalls = 0;
    const fake = FakeDecisionProvider.allow();
    const controlPlane = testControlPlane();
    const app = buildApp({
      controlPlane,
      logger: false,
      provider: { async evaluate(request) { providerCalls += 1; return fake.evaluate(request); } }
    });
    apps.push(app);

    const crossTenant = await authorize(app, "tenant-a-admin", authorizationBody("tenant-b", "cross-tenant"));
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().error.code).toBe("TENANT_SCOPE_VIOLATION");

    const crossEnvironment = await authorize(app, "tenant-a-admin", { ...authorizationBody("tenant-a", "cross-env"), environment: "production" });
    expect(crossEnvironment.statusCode).toBe(403);
    expect(crossEnvironment.json().error.code).toBe("ENVIRONMENT_SCOPE_VIOLATION");

    const downgradeBody = authorizationBody("tenant-a", "downgrade");
    downgradeBody.proposedAction.riskClass = "READ_ONLY";
    const downgrade = await authorize(app, "tenant-a-admin", downgradeBody);
    expect(downgrade.statusCode).toBe(403);
    expect(downgrade.json().error.code).toBe("TOOL_METADATA_MISMATCH");

    const unknown = authorizationBody("tenant-a", "unknown");
    unknown.proposedAction.tool = "unregistered_tool";
    const unknownResponse = await authorize(app, "tenant-a-admin", unknown);
    expect(unknownResponse.statusCode).toBe(404);
    expect(unknownResponse.json().error.code).toBe("TOOL_NOT_REGISTERED");

    const invalid = authorizationBody("tenant-a", "invalid");
    invalid.proposedAction.arguments = { transactionId: "txn-invalid", amountCents: -1 };
    const invalidResponse = await authorize(app, "tenant-a-admin", invalid);
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json().error.code).toBe("ACTION_ARGUMENTS_INVALID");

    const callerSelectedPolicy = await authorize(app, "tenant-a-admin", {
      ...authorizationBody("tenant-a", "policy-downgrade"),
      policyVersion: "0.0.1"
    });
    expect(callerSelectedPolicy.statusCode).toBe(403);
    expect(callerSelectedPolicy.json().error.code).toBe("POLICY_VERSION_MISMATCH");
    expect(providerCalls).toBe(0);
  });

  it("scopes decision reads and grant consumption to authenticated tenant context", async () => {
    const app = buildApp({ controlPlane: testControlPlane(), provider: FakeDecisionProvider.allow(), logger: false });
    apps.push(app);
    const body = authorizationBody("tenant-a", "isolation");
    const authorized = await authorize(app, "tenant-a-admin", body);
    expect(authorized.statusCode).toBe(200);
    const decision = authorized.json();

    const explicitCrossTenantRead = await app.inject({ method: "GET", url: `/v1/decisions/${decision.decisionId}?tenantId=tenant-a`, headers: auth("tenant-b-admin") });
    expect(explicitCrossTenantRead.statusCode).toBe(403);
    const opaqueCrossTenantRead = await app.inject({ method: "GET", url: `/v1/decisions/${decision.decisionId}`, headers: auth("tenant-b-admin") });
    expect(opaqueCrossTenantRead.statusCode).toBe(404);

    const crossTenantConsume = await app.inject({ method: "POST", url: "/v1/grants/consume", headers: auth("tenant-b-admin"), payload: consumeBody(decision.grant.token, body) });
    expect(crossTenantConsume.statusCode).toBe(403);
    expect(crossTenantConsume.json().error.code).toBe("TENANT_SCOPE_VIOLATION");
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers: auth("tenant-a-admin"), payload: consumeBody(decision.grant.token, body) })).statusCode).toBe(200);
  });

  it("enforces roles and revokes tenant API keys immediately without exposing their hashes", async () => {
    const app = buildApp({ controlPlane: testControlPlane(), provider: FakeDecisionProvider.allow(), logger: false });
    apps.push(app);
    const issuedResponse = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: auth("tenant-a-admin"),
      payload: { name: "authorize-only", environment: "development", roles: ["authorize"] }
    });
    expect(issuedResponse.statusCode).toBe(201);
    const issued = issuedResponse.json();
    expect(issued.token).toMatch(/^agk_/);
    expect((await authorize(app, issued.token, authorizationBody("tenant-a", "limited-role"))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/decisions", headers: auth(issued.token) })).statusCode).toBe(403);

    const listed = await app.inject({ method: "GET", url: "/v1/api-keys", headers: auth("tenant-a-admin") });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(issued.token);
    expect(listed.body).not.toContain("scrypt-v1");

    expect((await app.inject({ method: "POST", url: `/v1/api-keys/${issued.key.id}/revoke`, headers: auth("tenant-a-admin") })).statusCode).toBe(200);
    expect((await authorize(app, issued.token, authorizationBody("tenant-a", "revoked-key"))).statusCode).toBe(401);
  });

  it("rejects invalid registry schemas and policy-inconsistent tool metadata at registration time", async () => {
    const app = buildApp({ controlPlane: testControlPlane(), provider: FakeDecisionProvider.allow(), logger: false });
    apps.push(app);
    const base = {
      operation: "refund",
      riskClass: "FINANCIAL",
      owner: "payments-platform",
      dataSensitivity: "RESTRICTED",
      policyId: "support-agent-default",
      policyVersion: "1.0.0",
      enabled: true
    };
    const invalidSchema = await app.inject({
      method: "PUT", url: "/v1/tools/refund_payment", headers: auth("tenant-a-admin"),
      payload: { ...base, argumentSchema: { type: "not-a-json-schema-type" } }
    });
    expect(invalidSchema.statusCode).toBe(400);
    expect(invalidSchema.json().error.code).toBe("TOOL_SCHEMA_INVALID");

    const inconsistent = await app.inject({
      method: "PUT", url: "/v1/tools/refund_payment", headers: auth("tenant-a-admin"),
      payload: { ...base, operation: "delete", argumentSchema: { type: "object" } }
    });
    expect(inconsistent.statusCode).toBe(409);
    expect(inconsistent.json().error.code).toBe("TOOL_POLICY_MISMATCH");

    const invalidName = await app.inject({
      method: "PUT", url: "/v1/tools/INVALID%20NAME", headers: auth("tenant-a-admin"),
      payload: { ...base, argumentSchema: { type: "object" } }
    });
    expect(invalidName.statusCode).toBe(400);
    expect(invalidName.json().error.code).toBe("TOOL_NAME_INVALID");
  });

  it("revokes grants and persists review, correction, and token-free audit evidence", async () => {
    const app = buildApp({ controlPlane: testControlPlane(), provider: FakeDecisionProvider.allow(), logger: false });
    apps.push(app);
    const body = authorizationBody("tenant-a", "governance");
    const authorization = (await authorize(app, "tenant-a-admin", body)).json();
    const grantToken = authorization.grant.token as string;

    const override = await app.inject({ method: "POST", url: `/v1/decisions/${authorization.decisionId}/override`, headers: auth("tenant-a-admin"), payload: { correctDecision: "REVIEW", reason: "Operator found missing evidence" } });
    expect(override.statusCode).toBe(201);
    const review = await app.inject({ method: "POST", url: "/v1/reviews", headers: auth("tenant-a-admin"), payload: { decisionId: authorization.decisionId, reason: "Second check required", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(review.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/reviews/${review.json().id}/resolve`, headers: auth("tenant-a-admin"), payload: { decision: "DENIED" } })).statusCode).toBe(200);

    const revoked = await app.inject({ method: "POST", url: `/v1/grants/${authorization.grant.grantId}/revoke`, headers: auth("tenant-a-admin") });
    expect(revoked.statusCode).toBe(200);
    const rejected = await app.inject({ method: "POST", url: "/v1/grants/consume", headers: auth("tenant-a-admin"), payload: consumeBody(grantToken, body) });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("GRANT_REVOKED");

    const exported = await app.inject({ method: "GET", url: "/v1/audit/export", headers: auth("tenant-a-admin") });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(grantToken);
    const eventTypes = exported.json().events.map((event: { eventType: string }) => event.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining(["decision.created", "decision.overridden", "review.created", "review.resolved", "grant.revoked"]));
  });
});

function testControlPlane() {
  return new InMemoryControlPlaneRepository([
    { token: "tenant-a-admin", tenantId: "tenant-a", environment: "development", roles: [...API_ROLES] },
    { token: "tenant-b-admin", tenantId: "tenant-b", environment: "development", roles: [...API_ROLES] }
  ]);
}

function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function authorize(app: ReturnType<typeof buildApp>, token: string, payload: ReturnType<typeof authorizationBody> | Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/authorize", headers: { ...auth(token), "idempotency-key": String(payload.idempotencyKey) }, payload });
}
function authorizationBody(tenantId: string, suffix: string) {
  return {
    requestId: `request-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    tenantId,
    environment: "development" as "development" | "production",
    mode: "enforce" as const,
    actor: { agentId: "refund-agent", userId: "user-42", sessionId: "session-1" },
    userIntent: { text: "Refund the duplicate $49 charge", source: "user_message" as const },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: `txn-${suffix}`, amountCents: 4900 }, riskClass: "FINANCIAL" as "FINANCIAL" | "READ_ONLY" },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, amountCents: 4900, currency: "USD" }
  };
}
function consumeBody(token: string, body: ReturnType<typeof authorizationBody>) {
  return { token, tenantId: body.tenantId, environment: body.environment, actor: body.actor, proposedAction: body.proposedAction };
}
