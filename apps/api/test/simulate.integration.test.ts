import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@actiongate/core";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";
import { API_ROLES } from "../src/services/control-plane.js";

const KEY = "ag_sim_test";
const headers = { authorization: `Bearer ${KEY}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function build(roles: string[] = [...API_ROLES]) {
  const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: KEY, apiKeyTenantId: "tenant-sim", apiKeyRoles: roles as never, logger: false });
  apps.push(app);
  return app;
}

const simulation = {
  request: {
    actor: { agentId: "agent" },
    userIntent: { text: "Refund the duplicate charge.", source: "user_message" },
    proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId: "txn_1", amountCents: 4900 }, riskClass: "FINANCIAL" },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: false, amountCents: 4900, currency: "USD" }
  }
};

describe("policy simulator", () => {
  it("returns a decision without storing anything or issuing a grant", async () => {
    const app = build();
    const response = await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: simulation });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.simulated).toBe(true);
    expect(body.decision).toBe("ALLOW");
    // A simulation must never hand back a permit.
    expect(body.grant).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("token");

    // And it must leave no trace in the audit trail.
    const decisions = await app.inject({ method: "GET", url: "/v1/decisions", headers });
    expect(decisions.json().data).toHaveLength(0);
  });

  it("does not consume an idempotency key, so the same action can still run for real", async () => {
    const app = build();
    await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: simulation });
    await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: simulation });
    const real = await app.inject({
      method: "POST", url: "/v1/authorize", headers,
      payload: { ...simulation.request, requestId: "real-1", idempotencyKey: "real-key-0001", tenantId: "tenant-sim", environment: "development", mode: "enforce" }
    });
    expect(real.statusCode).toBe(200);
    expect(real.json().grant).toBeTruthy();
  });

  it("evaluates a candidate policy without committing it", async () => {
    const app = build();
    const stricter = {
      ...DEFAULT_POLICY,
      tools: {
        ...DEFAULT_POLICY.tools,
        refund_payment: { ...DEFAULT_POLICY.tools.refund_payment!, hardRules: { ...DEFAULT_POLICY.tools.refund_payment!.hardRules, maxAmountCents: 100 } }
      }
    };
    const response = await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: { ...simulation, policy: stricter } });
    expect(response.json().decision).toBe("BLOCK");
    expect(response.json().reasons.map((reason: { code: string }) => reason.code)).toContain("AMOUNT_EXCEEDS_LIMIT");

    // The stored policy is untouched, so a real call still behaves as before.
    const real = await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: simulation });
    expect(real.json().decision).toBe("ALLOW");
  });

  it("still derives operation and risk from the registry", async () => {
    const app = build();
    const response = await app.inject({
      method: "POST", url: "/v1/simulate", headers,
      payload: { request: { ...simulation.request, proposedAction: { ...simulation.request.proposedAction, riskClass: "READ_ONLY" } } }
    });
    // A downgrade is refused in simulation exactly as it is in enforcement.
    expect(response.statusCode).toBe(403);
  });

  it("is restricted to policy administrators", async () => {
    const app = build(["authorize", "consume"]);
    expect((await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: simulation })).statusCode).toBe(403);
  });

  it("refuses a candidate policy that does not contain the tool", async () => {
    const app = build();
    const withoutTool = { ...DEFAULT_POLICY, tools: { get_order: DEFAULT_POLICY.tools.get_order! } };
    const response = await app.inject({ method: "POST", url: "/v1/simulate", headers, payload: { ...simulation, policy: withoutTool } });
    expect(response.statusCode).toBe(409);
  });
});
