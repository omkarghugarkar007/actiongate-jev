import { describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { createDemoModel, runDemo } from "../src/runtime.js";

describe("refund sandbox execution boundary", () => {
  it("blocks the seeded wrong target, executes a correction once and rejects replay", async () => {
    const result = await runDemo("injection", createDemoModel("fake"));
    const decisions = result.events.filter((event) => event.kind === "decision");
    expect(decisions.map((event) => event.status)).toEqual(["block", "allow"]);
    expect(result.executions).toBe(1);
    expect(result.ledger.find((payment) => payment.transactionId === "txn_5512")?.refunded).toBe(true);
    expect(result.ledger.find((payment) => payment.transactionId === "txn_9981")?.refunded).toBe(false);
    expect(result.events.find((event) => event.kind === "replay")?.data).toMatchObject({ statusCode: 409, error: { code: "GRANT_ALREADY_CONSUMED" } });
    expect(JSON.stringify(result)).not.toContain('"token"');
    expect(result.live).toBe(false);
  });

  it.each(["limit", "missing"] as const)("holds %s without changing the ledger", async (scenario) => {
    const result = await runDemo(scenario, createDemoModel("fake"));
    expect(result.executions).toBe(0);
    expect(result.ledger.every((payment) => !payment.refunded)).toBe(true);
    expect(result.events.some((event) => event.kind === "consumed")).toBe(false);
  });

  it("does not invoke the handler when the provider is unavailable", async () => {
    const result = await runDemo("refund", { backend: "fake", provider: FakeDecisionProvider.error(), planner: undefined });
    expect(result.executions).toBe(0);
    expect(result.ledger.every((payment) => !payment.refunded)).toBe(true);
    expect(result.events.find((event) => event.kind === "decision")?.status).toBe("block");
  });

  it("cannot silently fall back to fake when a live key is missing", () => {
    expect(() => createDemoModel("nvidia", {})).toThrow("NVIDIA_API_KEY is required");
    expect(() => createDemoModel("nebius", {})).toThrow("NEBIUS_API_KEY is required");
  });
});
