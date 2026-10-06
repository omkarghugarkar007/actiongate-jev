import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { config } from "../../../apps/api/src/config.js";
import { createDemoModel } from "../src/runtime.js";
import { runResearchWorkflow } from "../src/research.js";
import { createTavilyBatch, researchArguments } from "../src/tavily.js";

const dirs: string[] = [];
async function ledgerPath() { const dir = await mkdtemp(join(tmpdir(), "actiongate-research-")); dirs.push(dir); return join(dir, "ledger.json"); }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const usage = () => ({ key: { usage: 0, limit: null }, account: { current_plan: "Researcher", plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
const search = () => ({ request_id: "test-request", usage: { credits: 1 }, results: [{ title: "Refund reference", url: "https://docs.stripe.com/refunds", content: "Public refund processing guidance." }] });
function transport(usageData: unknown = usage(), searchData: unknown = search(), status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => Response.json(input === "https://api.tavily.com/usage" ? usageData : searchData,
    { status: input === "https://api.tavily.com/usage" ? 200 : status }));
}
const options = (ledgerPath: string, fetcher: typeof fetch) => ({ apiKey: "private-tavily-key", confirmedPaygoDisabled: true, maxCredits: 1, ledgerPath, fetch: fetcher });

describe("free-only Tavily batch", () => {
  it("requires owner confirmation even when a free plan is returned", async () => {
    const fetcher = transport();
    await expect(createTavilyBatch({ ...options(await ledgerPath(), fetcher), confirmedPaygoDisabled: false })).rejects.toThrow("paid overflow");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["paid", "unknown", "exhausted", "overflow", "key-limit"])("rejects %s account state before search", async (kind) => {
    const state: any = usage();
    if (kind === "paid") state.account.current_plan = "Bootstrap";
    if (kind === "unknown") delete state.account.plan_usage;
    if (kind === "exhausted") state.account.plan_usage = 999;
    if (kind === "overflow") state.account.paygo_usage = 1;
    if (kind === "key-limit") state.key.limit = 0;
    const fetcher = transport(state);
    await expect(createTavilyBatch(options(await ledgerPath(), fetcher))).rejects.toThrow("free-only");
    expect(fetcher.mock.calls.every(([url]) => url === "https://api.tavily.com/usage")).toBe(true);
  });
  it("reserves durably before dispatch and sends only fixed public parameters", async () => {
    const path = await ledgerPath();
    const fetcher = transport();
    fetcher.mockImplementation(async (input, init) => {
      if (input === "https://api.tavily.com/usage") return Response.json(usage());
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ reservedCredits: 1, calls: [{ status: "reserved" }] });
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ search_depth: "basic", auto_parameters: false, include_usage: true, include_raw_content: false, include_answer: false, include_domains: ["docs.stripe.com"] });
      expect(String(init?.body)).not.toContain("txn_");
      return Response.json(search());
    });
    const batch = await createTavilyBatch(options(path, fetcher));
    expect(await batch.search(researchArguments())).toMatchObject({ provider: "tavily", credits: 1 });
    expect(batch.snapshot()).toMatchObject({ completedCredits: 1, reservedCredits: 0 });
    await expect(batch.search(researchArguments())).rejects.toThrow("exhausted");
    await expect(createTavilyBatch(options(path, fetcher))).rejects.toThrow();
    await batch.close();
    expect(await readFile(path, "utf8")).not.toContain("private-tavily-key");
  });
  it.each([
    { ...researchArguments(), query: "Refund customer txn_5512" }, { ...researchArguments(), domains: ["attacker.test"] },
    { ...researchArguments(), searchDepth: "advanced" }, { ...researchArguments(), secret: "private" }
  ])("rejects changed/private search parameters", async (args) => {
    const fetcher = transport();
    const batch = await createTavilyBatch(options(await ledgerPath(), fetcher));
    await expect(batch.search(args)).rejects.toThrow("public documentation");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await batch.close();
  });
  it.each(["http", "usage", "url", "network"])("retains reservation and halts after %s failure", async (kind) => {
    const data: any = search();
    if (kind === "usage") delete data.usage;
    if (kind === "url") data.results[0].url = "https://docs.stripe.com.attacker.test/";
    const fetcher = transport(usage(), data, kind === "http" ? 500 : 200);
    if (kind === "network") fetcher.mockImplementation(async (input) => { if (input === "https://api.tavily.com/usage") return Response.json(usage()); throw new Error("secret upstream detail"); });
    const batch = await createTavilyBatch(options(await ledgerPath(), fetcher));
    await expect(batch.search(researchArguments())).rejects.toThrow("batch is closed");
    expect(batch.snapshot()).toMatchObject({ closed: true, reservedCredits: 1, completedCredits: 0 });
    await expect(batch.search(researchArguments())).rejects.toThrow("closed");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("serializes concurrent requests against the cap", async () => {
    const fetcher = transport();
    const batch = await createTavilyBatch(options(await ledgerPath(), fetcher));
    const attempts = await Promise.allSettled([batch.search(researchArguments()), batch.search(researchArguments())]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["fulfilled", "rejected"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "https://api.tavily.com/search")).toHaveLength(1);
    await batch.close();
  });
});

describe("guarded research workflow", () => {
  it("consumes before billable search, rejects replay and keeps credentials out of evidence", async () => {
    const seen: string[] = [];
    const fetcher = transport();
    fetcher.mockImplementation(async (input) => {
      if (input === "https://api.tavily.com/usage") return Response.json(usage());
      expect(seen).toContain("research-consumed");
      return Response.json(search());
    });
    const result = await runResearchWorkflow("refund", createDemoModel("fake"), { tavily: options(await ledgerPath(), fetcher), onEvent: (event) => seen.push(event.kind) });
    expect(result.research?.provider).toBe("tavily");
    expect(result.refund?.executions).toBe(1);
    expect(result.events.find((event) => event.kind === "research-replay")?.data).toEqual({ statusCode: 409 });
    expect(result.events.find((event) => event.kind === "research-mutation")?.data).toEqual({ statusCode: 403 });
    expect(result.budget).toMatchObject({ closed: true, completedCredits: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private-tavily-key|"token"/);
  });
  it("stops without searching when semantic evidence is unavailable", async () => {
    const fetcher = transport();
    const result = await runResearchWorkflow("refund", { backend: "fake", provider: FakeDecisionProvider.error(), planner: undefined }, { tavily: options(await ledgerPath(), fetcher) });
    expect(result.research).toBeNull();
    expect(result.refund).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records a post-consumption failed outcome and stops the refund", async () => {
    const fetcher = transport(usage(), {}, 500);
    const result = await runResearchWorkflow("refund", createDemoModel("fake"), { tavily: options(await ledgerPath(), fetcher) });
    expect(result.events.map((event) => event.kind)).toContain("research-failed");
    expect(result.refund).toBeNull();
    expect(result.budget).toMatchObject({ closed: true, reservedCredits: 1 });
  });
  it("refuses billable search even when host configuration permits fail-open reads", async () => {
    const fetcher = transport();
    const previous = config.failOpenReadOnly;
    config.failOpenReadOnly = true;
    try {
      const result = await runResearchWorkflow("refund", { backend: "fake", provider: FakeDecisionProvider.error(), planner: undefined }, { tavily: options(await ledgerPath(), fetcher) });
      expect(result.events.find((event) => event.kind === "research-decision")?.status).toBe("allow");
      expect(result.research).toBeNull();
      expect(result.refund).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.events.some((event) => event.kind === "research-consumed")).toBe(false);
    } finally { config.failOpenReadOnly = previous; }
  });
  it.each(["injection", "limit", "missing"] as const)("keeps malicious source text outside authority in %s offline drill", async (scenario) => {
    const result = await runResearchWorkflow(scenario, createDemoModel("fake"), { seededSnippetAttack: true });
    expect(result.research?.provider).toBe("offline-fixture");
    expect(result.refund?.ledger.find((payment) => payment.transactionId === "txn_9981")?.refunded).toBe(false);
    if (scenario !== "injection") expect(result.refund?.executions).toBe(0);
  });
});
