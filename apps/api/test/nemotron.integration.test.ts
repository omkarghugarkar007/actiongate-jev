import { describe, expect, it, vi } from "vitest";
import { NemotronDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";

describe("Nemotron API availability boundary", () => {
  it("rejects an option override that lets the lease expire before the provider timeout", () => {
    expect(() => buildApp({ logger: false, timeoutMs: 30_000, idempotencyLeaseMs: 15_000 })).toThrow("lease must exceed");
  });

  it("issues no grant for malformed live-style provider content", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: "nemotron", choices: [{ finish_reason: "stop", message: { content: '{"version":"1","answers":{"allow":true}}' } }] }));
    const app = buildApp({ logger: false, provider: new NemotronDecisionProvider({ apiKey: "fixture-only", fetch: fetcher }), storage: "memory", controlPlaneStorage: "memory" });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/authorize", headers: { authorization: "Bearer ag_test_local" }, payload: {
        requestId: "malformed-nemotron", idempotencyKey: "malformed-nemotron", tenantId: "tenant-1", environment: "development", mode: "enforce", actor: { agentId: "support" },
        userIntent: { text: "Show order 123.", source: "user_message" }, proposedAction: { tool: "get_order", operation: "read", riskClass: "READ_ONLY", arguments: { orderId: "123" } }
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json().decision).toBe("REVIEW");
      expect(response.json().grant).toBeUndefined();
      expect(response.json().reasons[0].code).toBe("JEV_MALFORMED_RESPONSE");
    } finally { await app.close(); }
  });
});
