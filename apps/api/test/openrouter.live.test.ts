import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunctionFactProvider } from "@actiongate/core";
import { OpenRouterJevProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";

// Live gate: proves the whole authorize -> grant -> consume path works against the
// real OpenRouter Decisions endpoint, not only against the fake provider. Opt-in
// through `pnpm test:jev:live` so ordinary runs never spend provider credits.
const enabled = process.env.RUN_LIVE_JEV_TESTS === "true";

const headers = { authorization: "Bearer ag_live_local" };
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  if (!enabled) return;
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  // Fail loudly. A skipped live suite must never look like a passing gate.
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for the live authorization gate");
  app = buildApp({
    provider: new OpenRouterJevProvider({
      apiKey,
      model: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
      appTitle: "ActionGate live authorization gate"
    }),
    apiKey: "ag_live_local",
    apiKeyTenantId: "tenant-live",
    logger: false,
    storage: "memory",
    controlPlaneStorage: "memory",
    grantSecret: "live-openrouter-gate-secret-at-least-32-bytes",
    factProviders: [new FunctionFactProvider({
      name: "live-test-system",
      resolve: ({ request }) => request.proposedAction.tool === "refund_payment"
        ? { authenticated: true, authorizedByRbac: false, duplicate: false, amountCents: 4900, currency: "USD", resourceExists: true }
        : { resourceExists: true }
    })]
  });
});

afterAll(async () => {
  await app?.close();
});

function liveRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    idempotencyKey: `live-${randomUUID()}`,
    tenantId: "tenant-live",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "support-agent" },
    userIntent: { text: "Show me order 123.", source: "user_message" },
    proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "123" }, riskClass: "READ_ONLY" },
    context: { resources: { order: { id: "123" } } },
    ...overrides
  };
}

describe.skipIf(!enabled)("OpenRouter authorization gate @live", () => {
  it("issues a grant from live Jev evidence and consumes it exactly once", async () => {
    const payload = liveRequest();
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
    expect(response.statusCode).toBe(200);
    const authorization = response.json();

    // The decision must be attributed to the live gateway, not the fake provider.
    expect(authorization.model?.provider).toBe("openrouter");
    expect(authorization.model?.resolvedModel).toBeTruthy();
    expect(authorization.timing?.semanticMs).toBeGreaterThan(0);

    expect(authorization.decision).toBe("ALLOW");
    expect(authorization.grant?.token).toBeTruthy();

    const consumption = {
      token: authorization.grant.token,
      tenantId: payload.tenantId,
      environment: payload.environment,
      actor: { agentId: payload.actor.agentId },
      proposedAction: payload.proposedAction
    };
    const consumed = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json().status).toBe("CONSUMED");

    const replayed = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption });
    expect(replayed.statusCode).toBe(409);
  });

  it("keeps live model evidence from overriding a deterministic failure", async () => {
    // refund_payment requires RBAC. However favourably the live model scores the
    // request, a failed hard rule must still block and issue no grant.
    const payload = liveRequest({
      userIntent: { text: "Please refund my duplicate $49 charge.", source: "user_message" },
      proposedAction: {
        tool: "refund_payment",
        operation: "refund",
        arguments: { transactionId: "txn_8923", amountCents: 4900 },
        riskClass: "FINANCIAL"
      },
      deterministicFacts: {
        authenticated: true,
        // Adversarial caller claim: the server-side provider above denies it.
        authorizedByRbac: true,
        duplicate: false,
        amountCents: 4900,
        currency: "USD",
        resourceExists: true
      },
      context: { resources: { transaction: { id: "txn_8923", amountCents: 4900 } } }
    });
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
    expect(response.statusCode).toBe(200);
    const authorization = response.json();

    expect(authorization.decision).toBe("BLOCK");
    expect(authorization.grant).toBeUndefined();
    expect(authorization.reasons.some((reason: { source: string }) => reason.source === "DETERMINISTIC")).toBe(true);
  });
});
