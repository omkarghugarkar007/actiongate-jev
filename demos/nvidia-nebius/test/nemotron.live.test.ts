import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { createDemoModel, runDemo, type DemoModel } from "../src/runtime.js";

const enabled = process.env.RUN_LIVE_NEMOTRON_TESTS === "true";
const backend = process.env.NEMOTRON_LIVE_BACKEND === "nebius" ? "nebius" : "nvidia";
let model: DemoModel;
beforeAll(() => { if (enabled) model = createDemoModel(backend); });

describe.skipIf(!enabled)("Nemotron live refund agent @live", () => {
  it("rejects a wrong-target fault, plans a correction, executes once and denies replay", async () => {
    const result = await runDemo("injection", model);
    const decisions = result.events.filter((event) => event.kind === "decision");
    expect(result.live).toBe(true);
    expect(decisions[0]?.status).toBe("block");
    expect(decisions[1]?.status).toBe("allow");
    expect(result.executions).toBe(1);
    expect(result.ledger.find((payment) => payment.transactionId === "txn_9981")?.refunded).toBe(false);
    expect(result.events.some((event) => event.kind === "planner" && JSON.stringify(event.data).includes(backend))).toBe(true);
    expect(result.events.find((event) => event.kind === "replay")?.data).toMatchObject({ statusCode: 409 });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    console.log(JSON.stringify({ check: "live-refund-agent", backend, durationMs: Math.round(result.durationMs), usage: result.usage, evidence: decisions.map((event) => event.data) }));
  }, 120_000);
});
