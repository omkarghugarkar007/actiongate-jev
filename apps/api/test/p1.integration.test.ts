import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FunctionFactProvider, SignedRequestIssuer, verifySignedRequest } from "@actiongate/core";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";
import { SignedWebhookNotifier, verifyWebhookSignature } from "../src/services/webhooks.js";
import { API_ROLES } from "../src/services/control-plane.js";

const KEY = "ag_p1_test";
const headers = { authorization: `Bearer ${KEY}` };
const CREDENTIAL_SECRET = "credential-broker-secret-at-least-32-bytes";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const satisfiedFacts = new FunctionFactProvider({
  name: "ledger",
  resolve: () => ({ authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" })
});

function build(overrides: Parameters<typeof buildApp>[0] = {}) {
  const app = buildApp({
    provider: FakeDecisionProvider.allow(),
    apiKey: KEY,
    apiKeyTenantId: "tenant-p1",
    apiKeyRoles: [...API_ROLES],
    logger: false,
    ...overrides
  });
  apps.push(app);
  return app;
}

function refundRequest() {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    tenantId: "tenant-p1",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "support-agent" },
    userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
  };
}

async function authorize(app: ReturnType<typeof buildApp>, payload: Record<string, unknown> = refundRequest()) {
  const response = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
  expect(response.statusCode).toBe(200);
  return { payload, body: response.json() };
}

describe("credential broker", () => {
  it("consumes the grant and returns a short-lived signed request the downstream can verify", async () => {
    const issuer = new SignedRequestIssuer({ secret: CREDENTIAL_SECRET, keyId: "cred_1", maxTtlSeconds: 120 });
    const app = build({ credentialIssuer: issuer });
    const { payload, body } = await authorize(app);

    const exchange = await app.inject({
      method: "POST", url: "/v1/grants/exchange", headers,
      payload: {
        token: body.grant.token,
        tenantId: payload.tenantId,
        environment: payload.environment,
        actor: { agentId: "support-agent" },
        proposedAction: payload.proposedAction,
        ttlSeconds: 60,
        audience: "payments-api"
      }
    });
    expect(exchange.statusCode).toBe(200);
    const result = exchange.json();
    expect(result.credential.type).toBe("signed_request");
    // The grant itself is never handed back alongside the credential.
    expect(JSON.stringify(result)).not.toContain(body.grant.token);

    const verified = verifySignedRequest({ headers: result.credential.headers, secrets: { cred_1: CREDENTIAL_SECRET } });
    expect(verified).toMatchObject({ valid: true, audience: "payments-api" });
  });

  it("rejects a tampered or expired credential downstream", async () => {
    const issuer = new SignedRequestIssuer({ secret: CREDENTIAL_SECRET, keyId: "cred_1" });
    const app = build({ credentialIssuer: issuer });
    const { payload, body } = await authorize(app);
    const exchange = await app.inject({
      method: "POST", url: "/v1/grants/exchange", headers,
      payload: { token: body.grant.token, tenantId: payload.tenantId, environment: payload.environment, actor: { agentId: "support-agent" }, proposedAction: payload.proposedAction }
    });
    const credentialHeaders = exchange.json().credential.headers as Record<string, string>;

    expect(verifySignedRequest({ headers: { ...credentialHeaders, "x-actiongate-grant-id": randomUUID() }, secrets: { cred_1: CREDENTIAL_SECRET } }))
      .toEqual({ valid: false, reason: "BAD_SIGNATURE" });
    expect(verifySignedRequest({ headers: credentialHeaders, secrets: { other: CREDENTIAL_SECRET } }))
      .toEqual({ valid: false, reason: "UNKNOWN_KEY" });
    expect(verifySignedRequest({ headers: credentialHeaders, secrets: { cred_1: CREDENTIAL_SECRET }, now: Date.now() + 10 * 60_000 }))
      .toEqual({ valid: false, reason: "EXPIRED" });
  });

  it("exchanges a grant exactly once", async () => {
    const app = build({ credentialIssuer: new SignedRequestIssuer({ secret: CREDENTIAL_SECRET, keyId: "cred_1" }) });
    const { payload, body } = await authorize(app);
    const exchangePayload = { token: body.grant.token, tenantId: payload.tenantId, environment: payload.environment, actor: { agentId: "support-agent" }, proposedAction: payload.proposedAction };
    expect((await app.inject({ method: "POST", url: "/v1/grants/exchange", headers, payload: exchangePayload })).statusCode).toBe(200);
    // The exchange spends the permit, so a replay is the same conflict as a replayed consume.
    expect((await app.inject({ method: "POST", url: "/v1/grants/exchange", headers, payload: exchangePayload })).statusCode).toBe(409);
  });

  it("reports honestly when no broker is configured", async () => {
    const app = build();
    const { payload, body } = await authorize(app);
    const exchange = await app.inject({
      method: "POST", url: "/v1/grants/exchange", headers,
      payload: { token: body.grant.token, tenantId: payload.tenantId, environment: payload.environment, actor: { agentId: "support-agent" }, proposedAction: payload.proposedAction }
    });
    expect(exchange.statusCode).toBe(501);
  });
});

describe("execution outcomes", () => {
  it("records attempt, completion, and reversal separately from authorization", async () => {
    const app = build();
    const { body } = await authorize(app);
    for (const status of ["ATTEMPTED", "COMPLETED", "REVERSED"] as const) {
      const response = await app.inject({ method: "POST", url: "/v1/executions", headers, payload: { decisionId: body.decisionId, status, detail: `${status} detail` } });
      expect(response.statusCode).toBe(201);
    }
    const list = await app.inject({ method: "GET", url: `/v1/executions?decisionId=${body.decisionId}`, headers });
    expect(list.json().data.map((item: { status: string }) => item.status)).toEqual(["ATTEMPTED", "COMPLETED", "REVERSED"]);
  });

  it("refuses an execution for a decision the tenant does not have", async () => {
    const app = build();
    const response = await app.inject({ method: "POST", url: "/v1/executions", headers, payload: { decisionId: randomUUID(), status: "COMPLETED" } });
    expect(response.statusCode).toBe(404);
  });
});

describe("review queue", () => {
  async function pendingReview(app: ReturnType<typeof buildApp>, requiredApprovals?: number) {
    const { body } = await authorize(app);
    const created = await app.inject({
      method: "POST", url: "/v1/reviews", headers,
      payload: {
        decisionId: body.decisionId,
        reason: "Needs a human",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ...(requiredApprovals ? { requiredApprovals } : {})
      }
    });
    expect(created.statusCode).toBe(201);
    return { review: created.json(), decisionId: body.decisionId };
  }

  it("lists, claims, and refuses a second claimant", async () => {
    const app = build();
    const { review } = await pendingReview(app);
    expect((await app.inject({ method: "GET", url: "/v1/reviews?status=PENDING", headers })).json().data).toHaveLength(1);

    const claimed = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/claim`, headers, payload: { assignee: "alex" } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().assignee).toBe("alex");

    const second = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/claim`, headers, payload: { assignee: "sam" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("REVIEW_ALREADY_CLAIMED");
  });

  it("escalates to a new assignee and keeps the note", async () => {
    const app = build();
    const { review } = await pendingReview(app);
    const escalated = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/escalate`, headers, payload: { assignee: "oncall", note: "Above my limit" } });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json()).toMatchObject({ assignee: "oncall", escalatedTo: "oncall", escalationNote: "Above my limit" });
  });

  it("revalidates the exact action at approval and mints a fresh grant", async () => {
    const app = build();
    const { review, decisionId } = await pendingReview(app);
    const resolved = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers, payload: { decision: "APPROVED" } });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json();
    expect(body.review.status).toBe("APPROVED");
    // The approval produces a new decision and a new permit, not the original one.
    expect(body.revalidation.decision).toBe("ALLOW");
    expect(body.revalidation.decisionId).not.toBe(decisionId);
    expect(body.revalidation.grant.token).toBeTruthy();
  });

  it("does not mint a grant when the tool was disabled after the review was raised", async () => {
    const app = build();
    const { review } = await pendingReview(app);
    await app.inject({ method: "POST", url: "/v1/incidents/disable-tools", headers, payload: { tools: ["refund_payment"] } });
    const resolved = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers, payload: { decision: "APPROVED" } });
    // The registry is consulted at approval time, so a disabled tool cannot be approved through.
    expect(resolved.statusCode).toBe(403);
    expect(resolved.json().error.code).toBe("TOOL_DISABLED");
  });

  it("requires two distinct reviewers when configured", async () => {
    const app = build();
    const { review } = await pendingReview(app, 2);

    const first = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers, payload: { decision: "APPROVED" } });
    expect(first.statusCode).toBe(202);
    expect(first.json().approvalsRemaining).toBe(1);

    // The same key approving again must not satisfy the second approval.
    const duplicate = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers, payload: { decision: "APPROVED" } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_APPROVER");

    const secondKey = await app.inject({ method: "POST", url: "/v1/api-keys", headers, payload: { name: "reviewer-two", environment: "development", roles: ["reviewer", "authorize", "consume", "decision_reader"] } });
    const secondToken = secondKey.json().token;
    const second = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers: { authorization: `Bearer ${secondToken}` }, payload: { decision: "APPROVED" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().review.status).toBe("APPROVED");
  });

  it("denies without revalidating or granting", async () => {
    const app = build();
    const { review } = await pendingReview(app);
    const denied = await app.inject({ method: "POST", url: `/v1/reviews/${review.id}/resolve`, headers, payload: { decision: "DENIED" } });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().status).toBe("DENIED");
    expect(denied.json().revalidation).toBeUndefined();
  });
});

describe("incident response", () => {
  it("disables tools in bulk so later authorization fails closed", async () => {
    const app = build();
    const disabled = await app.inject({ method: "POST", url: "/v1/incidents/disable-tools", headers, payload: { tools: ["refund_payment", "send_email"] } });
    expect(disabled.json().disabled).toEqual(["refund_payment", "send_email"]);
    const after = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: refundRequest() });
    expect(after.statusCode).toBe(403);
  });

  it("revokes every outstanding grant and leaves them unconsumable", async () => {
    const app = build();
    const { payload, body } = await authorize(app);
    const revoked = await app.inject({ method: "POST", url: "/v1/incidents/revoke-grants", headers, payload: {} });
    expect(revoked.json().revoked).toContain(body.grant.grantId);

    const consume = await app.inject({
      method: "POST", url: "/v1/grants/consume", headers,
      payload: { token: body.grant.token, tenantId: payload.tenantId, environment: payload.environment, actor: { agentId: "support-agent" }, proposedAction: payload.proposedAction }
    });
    expect(consume.statusCode).toBe(403);
    expect(consume.json().error.code).toBe("GRANT_REVOKED");
  });

  it("narrows bulk revocation to one tool", async () => {
    const app = build();
    const { body } = await authorize(app);
    const revoked = await app.inject({ method: "POST", url: "/v1/incidents/revoke-grants", headers, payload: { tool: "send_email" } });
    expect(revoked.json().revoked).not.toContain(body.grant.grantId);
  });
});

describe("signed webhooks", () => {
  it("signs a delivery the receiver can verify and rejects a replay outside the window", async () => {
    const secret = "webhook-secret-that-is-at-least-32-bytes";
    const captured: { body: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ body: String(init?.body), headers: init?.headers as Record<string, string> });
      return new Response("", { status: 200 });
    });
    const notifier = new SignedWebhookNotifier({ url: "https://hooks.internal/actiongate", secret, fetch: fetchMock as unknown as typeof fetch });
    const app = build({ notifier });
    const { body } = await authorize(app);
    await app.inject({ method: "POST", url: "/v1/executions", headers, payload: { decisionId: body.decisionId, status: "COMPLETED" } });

    expect(captured).toHaveLength(1);
    const delivery = captured[0]!;
    expect(verifyWebhookSignature({
      secret,
      signature: delivery.headers["X-ActionGate-Signature"]!,
      timestamp: delivery.headers["X-ActionGate-Timestamp"]!,
      body: delivery.body
    })).toBe(true);

    // A delivery replayed later than the tolerance window is refused.
    expect(verifyWebhookSignature({
      secret,
      signature: delivery.headers["X-ActionGate-Signature"]!,
      timestamp: delivery.headers["X-ActionGate-Timestamp"]!,
      body: delivery.body,
      now: Date.now() + 10 * 60_000
    })).toBe(false);
  });

  it("retries then dead-letters, without failing the request that triggered it", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    const notifier = new SignedWebhookNotifier({
      url: "https://hooks.internal/actiongate",
      secret: "webhook-secret-that-is-at-least-32-bytes",
      maxAttempts: 3,
      sleep: async () => {},
      fetch: fetchMock as unknown as typeof fetch
    });
    const app = build({ notifier });
    const { body } = await authorize(app);
    const recorded = await app.inject({ method: "POST", url: "/v1/executions", headers, payload: { decisionId: body.decisionId, status: "FAILED" } });
    // The API call still succeeded even though every delivery attempt failed.
    expect(recorded.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const dead = await app.inject({ method: "GET", url: "/v1/incidents/dead-letters", headers });
    expect(dead.json().data).toHaveLength(1);
    expect(dead.json().data[0]).toMatchObject({ status: "DEAD", attempts: 3, type: "execution.failed" });
  });

  it("refuses a destination that is not allowlisted", () => {
    expect(() => new SignedWebhookNotifier({
      url: "https://evil.example/hook",
      secret: "webhook-secret-that-is-at-least-32-bytes",
      allowedHosts: ["hooks.internal"]
    })).toThrow(/not allowlisted/);
  });
});

describe("trusted facts through the API", () => {
  it("lets a provider satisfy hard rules the caller never sends", async () => {
    const app = build({ factProviders: [satisfiedFacts] });
    const payload = { ...refundRequest(), deterministicFacts: undefined };
    delete (payload as Record<string, unknown>).deterministicFacts;
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
    expect(response.json().decision).toBe("ALLOW");
  });
});
