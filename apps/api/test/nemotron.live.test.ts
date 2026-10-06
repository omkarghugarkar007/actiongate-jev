import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunctionFactProvider } from "@actiongate/core";
import { NemotronDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";

const enabled = process.env.RUN_LIVE_NEMOTRON_TESTS === "true";
const backend = process.env.NEMOTRON_LIVE_BACKEND === "nebius" ? "nebius" : "nvidia";
let app: ReturnType<typeof buildApp>;
const headers = { authorization: "Bearer ag_live_nemotron" };
beforeAll(() => {
  if (!enabled) return;
  const apiKey = backend === "nvidia" ? process.env.NVIDIA_API_KEY : process.env.NEBIUS_API_KEY;
  if (!apiKey) throw new Error(`${backend === "nvidia" ? "NVIDIA_API_KEY" : "NEBIUS_API_KEY"} is required for the live gate`);
  app = buildApp({
    provider: new NemotronDecisionProvider({ backend, apiKey }), timeoutMs: 30_000, idempotencyLeaseMs: 45_000,
    apiKey: "ag_live_nemotron", apiKeyTenantId: "nemotron-live", logger: false, storage: "memory", controlPlaneStorage: "memory",
    factProviders: [new FunctionFactProvider({ name: "test-system", resolve: () => ({ authenticated: true, authorizedByRbac: false, duplicate: false, amountCents: 4900, currency: "USD", resourceExists: true }) })]
  });
});
afterAll(async () => { await app?.close(); });

describe.skipIf(!enabled)("Nemotron live authorization gate @live", () => {
  it("attributes a live decision, binds the exact action, and consumes once", async () => {
    const payload = {
      requestId: randomUUID(), idempotencyKey: randomUUID(), tenantId: "nemotron-live", environment: "development", mode: "enforce",
      actor: { agentId: "support-agent" }, userIntent: { text: "Show me order 123.", source: "user_message" },
      proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "123" }, riskClass: "READ_ONLY" }
    };
    const reply = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload });
    expect(reply.statusCode).toBe(200);
    const decision = reply.json();
    expect(decision.model.provider).toBe(backend);
    expect(decision.model.resolvedModel).toBeTruthy();
    expect(decision.model.usage.inputTokens).toBeGreaterThan(0);
    expect(decision.decision).toBe("ALLOW");
    const consumption = { token: decision.grant.token, tenantId: payload.tenantId, environment: payload.environment, actor: payload.actor, proposedAction: payload.proposedAction };
    const mutated = await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: { ...consumption, proposedAction: { ...payload.proposedAction, arguments: { orderId: "999" } } } });
    expect(mutated.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/grants/consume", headers, payload: consumption })).statusCode).toBe(409);
    console.log(JSON.stringify({ check: "live-nemotron-authorization", model: decision.model, timing: decision.timing }));
  }, 45_000);

  it("holds RBAC denial even when the caller claims permission", async () => {
    const reply = await app.inject({ method: "POST", url: "/v1/authorize", headers, payload: {
      requestId: randomUUID(), idempotencyKey: randomUUID(), tenantId: "nemotron-live", environment: "development", mode: "enforce", actor: { agentId: "support-agent" },
      userIntent: { text: "Refund my $49 transaction txn_5512.", source: "user_message" },
      proposedAction: { tool: "refund_payment", operation: "refund", riskClass: "FINANCIAL", arguments: { transactionId: "txn_5512", amountCents: 4900 } },
      deterministicFacts: { authenticated: true, authorizedByRbac: true }
    } });
    const decision = reply.json();
    expect(decision.decision).toBe("BLOCK");
    expect(decision.reasons.some((reason: { code: string }) => reason.code === "RBAC_DENIED")).toBe(true);
    expect(decision.grant).toBeUndefined();
  });
});
