import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenRouterJevProvider } from "@actiongate/decision-provider";
import { runResearchWorkflow } from "../src/research.js";
import { assertPublicEvidence } from "../src/recording.js";

const enabled = process.env.RUN_LIVE_RESEARCH_TESTS === "true";
describe.skipIf(!enabled)("Tavily research through the real Jev gate @live", () => {
  it("binds and consumes a live Jev research permit before one free Tavily search", async () => {
    if (process.env.RESEARCH_FREE_CREDITS_CONFIRMED !== "true" || process.env.TAVILY_PAYGO_DISABLED !== "true") throw new Error("Confirm promotional OpenRouter funding and disabled Tavily paid overflow before this opt-in live suite.");
    const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!key || !tavilyKey) throw new Error("OpenRouter and Tavily keys are required; this selected live suite cannot be skipped.");
    const keyResponse = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!keyResponse.ok) throw new Error("Cannot verify the OpenRouter key limit before the live gate.");
    const before = (await keyResponse.json()).data as { limit: unknown; limit_remaining: unknown; usage: unknown };
    if (typeof before.limit !== "number" || before.limit > 5 || typeof before.limit_remaining !== "number" || before.limit_remaining < 1) throw new Error("Live research gate requires a provider-enforced key limit of at most $5 and at least $1 headroom.");
    const provider = new OpenRouterJevProvider({ apiKey: key, model: "typesafe/jev-1.13", appTitle: "ActionGate guarded public research live gate" });
    // Scripted planner; both search and refund authorization use genuine Jev.
    // Nemotron planning with sources is verified separately in the Nebius capture.
    const result = await runResearchWorkflow("refund", { backend: "fake", provider, planner: undefined }, {
      tavily: { apiKey: tavilyKey, confirmedPaygoDisabled: true, maxCredits: 1, ledgerPath: resolve(`.actiongate/tavily-jev-${randomUUID()}.json`) }, seededSnippetAttack: true });
    const events = result.events.filter((event) => ["research-decision", "decision"].includes(event.kind));
    expect(events).toHaveLength(2);
    for (const event of events) {
      const data = event.data as { model?: { provider?: string; resolvedModel?: string } };
      expect(data.model?.provider).toBe("openrouter");
      expect(data.model?.resolvedModel).toBeTruthy();
      expect(event.status).toBe("allow");
    }
    expect(result.research?.provider).toBe("tavily");
    expect(result.budget).toMatchObject({ closed: true, completedCredits: 1, reservedCredits: 0 });
    expect(result.refund?.executions).toBe(1);
    expect(result.events.find((event) => event.kind === "research-replay")?.data).toEqual({ statusCode: 409 });
    const afterResponse = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const after = afterResponse.ok ? (await afterResponse.json()).data as { usage: unknown } : null;
    const usageDeltaUsd = typeof before.usage === "number" && typeof after?.usage === "number" ? after.usage - before.usage : null;
    const record = { schemaVersion: 1, capturedAt: new Date().toISOString(), description: "Real Tavily and real Jev authorization; scripted planner. Separate Nebius records verify source-aware Nemotron planning.",
      checks: "live gateway attribution, authorize, consume-before-search, search usage, refund consumption and replay", result,
      keyUsageDeltaUsd: usageDeltaUsd, costLimitSource: "Provider-enforced $5 key limit; owner-confirmed promotional funding; delta is not an invoice" };
    assertPublicEvidence(record, [key, tavilyKey]);
    const output = resolve(`.actiongate/tavily-jev-verification-${randomUUID()}.json`);
    await mkdir(resolve(".actiongate"), { recursive: true });
    await writeFile(output, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, searchCredits: result.budget?.completedCredits, keyUsageDeltaUsd: usageDeltaUsd, resolvedModels: events.map((event) => (event.data as { model: { resolvedModel: string } }).model.resolvedModel) }));
  }, 60_000);
});
