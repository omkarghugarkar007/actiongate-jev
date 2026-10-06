import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNebiusBudget } from "../src/budget.js";

const directories: string[] = [];
const model = "nvidia/nemotron-3-super-120b-a12b";
const endpoint = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const quote = { id: model, context_length: 262144, pricing: { prompt: "0.0000003", completion: "0.0000009", request: "0", image: "0", price_per_video_second: "0", price_per_minute: "0" } };
const init = { method: "POST", redirect: "error" as const, headers: { authorization: "Bearer fixture-never-real-key" }, body: JSON.stringify({ model, messages: [{ role: "system", content: "test" }, { role: "user", content: "test" }], response_format: {}, temperature: 0, max_tokens: 2048, stream: false, chat_template_kwargs: { enable_thinking: false } }) };
const completion = () => Response.json({ model, usage: { prompt_tokens: 100, completion_tokens: 10 } });
async function setup(inference: () => Promise<Response>, capUsd = 0.1, maxRequests = 3) {
  const folder = await mkdtemp(join(tmpdir(), "actiongate-budget-test-")); directories.push(folder);
  const ledgerPath = join(folder, "budget.json");
  const fetcher = vi.fn(async (url: unknown) => url === endpoint ? inference() : Response.json({ data: [quote] }));
  const options = { apiKey: "fixture-never-real-key", model, capUsd, confirmedFreeBalanceUsd: 1, maxRequests, ledgerPath, fetch: fetcher as typeof fetch };
  return { budget: await createNebiusBudget(options), fetcher, ledgerPath, options };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe("owned inference batch spending boundary", () => {
  it("reserves before dispatch, settles real tokens, persists no key and closes explicitly", async () => {
    const { budget, ledgerPath } = await setup(async () => {
      const state = JSON.parse(await readFile(ledgerPath, "utf8"));
      expect(state.retainedReservationUsd).toBeCloseTo(0.0804864);
      return completion();
    });
    await budget.fetch(endpoint, init);
    expect(budget.snapshot()).toMatchObject({ retainedReservationUsd: 0, inputTokens: 100, outputTokens: 10 });
    expect(budget.snapshot().chargedEstimateUsd).toBeCloseTo(0.000039);
    await budget.close();
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("closed");
    expect(await readFile(ledgerPath, "utf8")).not.toContain("fixture-never-real-key");
  });

  it("cannot overbook the cap during concurrent requests", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const { budget, fetcher } = await setup(() => pending);
    const first = budget.fetch(endpoint, init);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("budget exhausted");
    expect(fetcher).toHaveBeenCalledTimes(2); // catalog + first inference only
    release(completion()); await first;
  });

  it.each(["transport", "HTTP", "usage", "model", "output"])("retains the bound and halts on unknown %s accounting", async (failure) => {
    const { budget, fetcher } = await setup(async () => {
      if (failure === "transport") throw new Error("sensitive upstream detail");
      if (failure === "HTTP") return new Response("sensitive detail", { status: 500 });
      if (failure === "usage") return Response.json({ model });
      if (failure === "model") return Response.json({ model: "unpriced", usage: { prompt_tokens: 100, completion_tokens: 10 } });
      return Response.json({ model, usage: { prompt_tokens: 100, completion_tokens: 2049 } });
    });
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("reservation retained");
    expect(budget.snapshot()).toMatchObject({ closed: true, chargedEstimateUsd: 0 });
    expect(budget.snapshot().retainedReservationUsd).toBeCloseTo(0.0804864);
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("closed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unpriced endpoints, changed models and billable tool/image fields before dispatch", async () => {
    const { budget, fetcher } = await setup(async () => completion());
    await expect(budget.fetch("https://attacker.example", init)).rejects.toThrow();
    const body = JSON.parse(init.body);
    await expect(budget.fetch(endpoint, { ...init, body: JSON.stringify({ ...body, model: "other" }) })).rejects.toThrow();
    await expect(budget.fetch(endpoint, { ...init, body: JSON.stringify({ ...body, tools: [] }) })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps request count and refuses to reopen an existing ledger", async () => {
    const { budget, fetcher, options } = await setup(async () => completion(), 0.1, 1);
    await budget.fetch(endpoint, init);
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("budget exhausted");
    await expect(createNebiusBudget(options)).rejects.toThrow();
    expect(fetcher.mock.calls.filter(([url]) => url === endpoint)).toHaveLength(1);
  });

  it("does not dispatch when a pre-call reservation cannot fit", async () => {
    const { budget, fetcher } = await setup(async () => completion(), 0.01);
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("budget exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().requests).toHaveLength(0);
  });

  it.each([null, "", "not-a-price", "-1", "1e2"])("rejects invalid pricing %s rather than treating it as free", async (price) => {
    const folder = await mkdtemp(join(tmpdir(), "actiongate-invalid-price-")); directories.push(folder);
    const fetcher = vi.fn(async () => Response.json({ data: [{ ...quote, pricing: { ...quote.pricing, prompt: price } }] }));
    await expect(createNebiusBudget({ apiKey: "fixture-never-real-key", model, capUsd: 0.1,
      confirmedFreeBalanceUsd: 1, maxRequests: 3, ledgerPath: join(folder, "budget.json"), fetch: fetcher as typeof fetch
    })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1); // catalog only
  });

  it("rejects a cancelled call before reserving or dispatching", async () => {
    const { budget, fetcher } = await setup(async () => completion());
    const controller = new AbortController(); controller.abort();
    await expect(budget.fetch(endpoint, { ...init, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(budget.snapshot().requests).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("closes without dispatch if the reservation cannot be persisted", async () => {
    const { budget, fetcher, ledgerPath } = await setup(async () => completion());
    const folder = join(ledgerPath, "..");
    await rm(folder, { recursive: true }); await writeFile(folder, "unavailable directory");
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("not dispatched");
    expect(budget.snapshot()).toMatchObject({ closed: true, haltedReason: "Ledger persistence failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(budget.fetch(endpoint, init)).rejects.toThrow("closed");
  });
});
