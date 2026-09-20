import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunctionFactProvider } from "@actiongate/core";
import { TypeSafeJevProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";

// Opt-in and fail-loud: ordinary CI never spends TypeSafe credits, while an
// explicitly requested live run cannot turn a missing key into a skipped pass.
const enabled = process.env.RUN_LIVE_TYPESAFE_TESTS === "true";
const headers = { authorization: "Bearer ag_typesafe_live" };
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  if (!enabled) return;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for the direct TypeSafe authorization gate");
  app = buildApp({
    provider: new TypeSafeJevProvider({ apiKey, model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0" }),
    apiKey: "ag_typesafe_live",
    apiKeyTenantId: "tenant-typesafe-live",
    logger: false,
    storage: "memory",
    controlPlaneStorage: "memory",
    grantSecret: "live-typesafe-gate-secret-at-least-32-bytes",
    factProviders: [new FunctionFactProvider({
      name: "live-test-system",
      resolve: ({ request }) => request.proposedAction.tool === "refund_payment"
        ? { authenticated: true, authorizedByRbac: false, duplicate: false, amountCents: 4900, currency: "USD", resourceExists: true }
        : { resourceExists: true }
    })]
  });
});

afterAll(async () => app?.close());

function liveRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    idempotencyKey: `typesafe-live-${randomUUID()}`,
    tenantId: "tenant-typesafe-live",
    environment: "development",
    mode: "enforce",
    actor: { agentId: "support-agent" },
    userIntent: { text: "Show me order 123.", source: "user_message" },
    proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "123" }, riskClass: "READ_ONLY" },
    context: { resources: { order: { id: "123" } } },
    ...overrides
  };
}

describe.skipIf(!enabled)("direct TypeSafe authorization gate @live", () => {
  it("issues and consumes a grant from direct TypeSafe evidence", async () => {
    const payload = liveRequest();
    const response = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
    expect(response.statusCode).toBe(200);
    const authorization = response.json();
    expect(authorization.model?.provider).toBe("typesafe");
    expect(authorization.model?.resolvedModel).toMatch(/^jev-/);
    expect(authorization.timing?.semanticMs).toBeGreaterThan(0);
    expect(authorization.decision).toBe("ALLOW");
    expect(authorization.grant?.token).toBeTruthy();

    const consumption = {
      token: authorization.grant.token,
      tenantId: payload.tenantId,
      environment: payload.environment,
      actor: payload.actor,
      proposedAction: payload.proposedAction
    };
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption })).statusCode).toBe(409);
  });

  it("does not let direct model evidence override a deterministic denial", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/authorize",
      headers,
      payload: liveRequest({
        userIntent: { text: "Please refund my duplicate $49 charge.", source: "user_message" },
        proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_8923", amountCents: 4900 }, riskClass: "FINANCIAL" },
        deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD", resourceExists: true }
      })
    });
    const authorization = response.json();
    expect(authorization.decision).toBe("BLOCK");
    expect(authorization.grant).toBeUndefined();
    expect(authorization.reasons.some((reason: { source: string }) => reason.source === "DETERMINISTIC")).toBe(true);
  });
});
