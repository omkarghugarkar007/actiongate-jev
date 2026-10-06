import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const endpoint = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const nanoUsd = 1_000_000_000;
const usd = (value: number) => value / nanoUsd;
const PriceSchema = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(Number).pipe(z.number().finite().nonnegative().max(1));
export const BudgetSnapshotSchema = z.object({
  schemaVersion: z.literal(1), model: z.string().min(1), confirmedFreeBalanceUsd: z.number().positive(),
  confirmationSource: z.literal("Owner confirmed promotional/free credit; not a wallet API read"),
  capUsd: z.number().positive(), maximumRequests: z.number().int().positive().max(100), contextTokens: z.number().int().positive(),
  pricingUsdPerToken: z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative() }).strict(),
  chargedEstimateUsd: z.number().finite().nonnegative(), retainedReservationUsd: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), closed: z.boolean(), haltedReason: z.string().nullable(),
  requests: z.array(z.object({ sequence: z.number().int().positive(), maximumUsd: z.number().finite().nonnegative(),
    status: z.enum(["pending", "completed", "unknown"]), httpStatus: z.number().int().min(100).max(599).optional(),
    inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative().optional(), estimatedUsd: z.number().finite().nonnegative().optional()
  }).strict()).max(100)
}).strict();
const CatalogModelSchema = z.object({
  id: z.string(), context_length: z.number().int().positive().max(2_000_000),
  pricing: z.object({ prompt: PriceSchema, completion: PriceSchema, request: PriceSchema,
    image: PriceSchema, price_per_video_second: PriceSchema, price_per_minute: PriceSchema })
});
const RequestSchema = z.object({
  model: z.string(), messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string().max(128_000) }).strict()).length(2),
  response_format: z.unknown(), temperature: z.literal(0), max_tokens: z.number().int().positive().max(2048),
  stream: z.literal(false), chat_template_kwargs: z.object({ enable_thinking: z.literal(false) }).strict()
}).strict();
const UsageSchema = z.object({ model: z.string(), usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }) });
type RequestRecord = {
  sequence: number; maximumUsd: number; status: "pending" | "completed" | "unknown";
  httpStatus?: number; inputTokens?: number; outputTokens?: number; latencyMs?: number; estimatedUsd?: number;
};

/** An owner-confirmed batch budget, not an account wallet or a provider billing limit. */
export async function createNebiusBudget(options: {
  apiKey: string; model: string; confirmedFreeBalanceUsd: number; capUsd: number;
  maxRequests: number; ledgerPath: string; fetch?: typeof globalThis.fetch;
}) {
  z.object({ apiKey: z.string().min(1), model: z.string().min(1), confirmedFreeBalanceUsd: z.number().positive().max(1000),
    capUsd: z.number().positive().max(100), maxRequests: z.number().int().positive().max(100), ledgerPath: z.string().min(1)
  }).parse(options);
  if (options.capUsd > options.confirmedFreeBalanceUsd / 2) throw new Error("Keep at least half the confirmed free balance outside this batch.");
  const rawFetch = options.fetch ?? globalThis.fetch;
  const catalog = await rawFetch("https://api.tokenfactory.nebius.com/v1/models?verbose=true", {
    headers: { Authorization: `Bearer ${options.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(15_000)
  });
  if (!catalog.ok) throw new Error("Cannot establish model pricing; no inference dispatched.");
  const models = z.object({ data: z.array(z.unknown()) }).parse(await catalog.json());
  const selected = models.data.find((item) => typeof item === "object" && item !== null && "id" in item && item.id === options.model);
  const quote = CatalogModelSchema.parse(selected);
  if ([quote.pricing.request, quote.pricing.image, quote.pricing.price_per_video_second, quote.pricing.price_per_minute].some((price) => price !== 0)) {
    throw new Error("Only zero-surcharge text pricing is supported by this batch guard.");
  }
  // Round prices up and the cap down. Integers keep accumulated floating error out of enforcement.
  const inputRate = Math.ceil(quote.pricing.prompt * nanoUsd);
  const outputRate = Math.ceil(quote.pricing.completion * nanoUsd);
  const cap = Math.floor(options.capUsd * nanoUsd);
  let reserved = 0;
  let charged = 0;
  let closed = false;
  let haltedReason: string | null = null;
  const requests: RequestRecord[] = [];
  let queue = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(operation);
    queue = task.then(() => {}, () => {});
    return task;
  }
  function snapshot() {
    return {
      schemaVersion: 1, model: quote.id, confirmedFreeBalanceUsd: options.confirmedFreeBalanceUsd,
      confirmationSource: "Owner confirmed promotional/free credit; not a wallet API read",
      capUsd: usd(cap), maximumRequests: options.maxRequests, contextTokens: quote.context_length,
      pricingUsdPerToken: { input: quote.pricing.prompt, output: quote.pricing.completion },
      chargedEstimateUsd: usd(charged), retainedReservationUsd: usd(reserved),
      inputTokens: requests.reduce((total, item) => total + (item.inputTokens ?? 0), 0),
      outputTokens: requests.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
      closed, haltedReason, requests: requests.map((item) => ({ ...item }))
    };
  }
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  // Reusing a ledger cannot silently start a fresh budget after a crash.
  await writeFile(options.ledgerPath, JSON.stringify(snapshot(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  async function persist() {
    const temporary = options.ledgerPath + ".tmp";
    await writeFile(temporary, JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, options.ledgerPath);
  }
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    if (input !== endpoint || init?.method !== "POST" || init.redirect !== "error" || typeof init.body !== "string" ||
      new Headers(init.headers).get("authorization") !== `Bearer ${options.apiKey}`) {
      throw new Error("Budget guard accepts only fixed Nebius JSON chat requests.");
    }
    const request = RequestSchema.parse(JSON.parse(init.body));
    if (request.model !== quote.id) throw new Error("Unpriced model rejected before dispatch.");
    const maximum = quote.context_length * inputRate + request.max_tokens * outputRate;
    const record = await serial(async () => {
      if (closed || init.signal?.aborted) throw new Error("Inference batch is closed or cancelled.");
      if (requests.length >= options.maxRequests || charged + reserved + maximum > cap) throw new Error("Inference batch budget exhausted before dispatch.");
      const item: RequestRecord = { sequence: requests.length + 1, maximumUsd: usd(maximum), status: "pending" };
      reserved += maximum;
      requests.push(item);
      try { await persist(); }
      catch { closed = true; haltedReason = "Ledger persistence failed"; throw new Error("Cannot persist reservation; inference was not dispatched."); }
      return item;
    });
    const started = performance.now();
    try {
      const response = await rawFetch(input, init);
      record.httpStatus = response.status;
      if (!response.ok) throw new Error("Unknown cost after provider HTTP failure.");
      const usage = UsageSchema.parse(await response.clone().json());
      if (usage.model !== quote.id || usage.usage.prompt_tokens > quote.context_length || usage.usage.completion_tokens > request.max_tokens) {
        throw new Error("Resolved model or usage exceeds the priced reservation.");
      }
      const actual = usage.usage.prompt_tokens * inputRate + usage.usage.completion_tokens * outputRate;
      await serial(async () => {
        reserved -= maximum;
        charged += actual;
        Object.assign(record, { status: "completed", httpStatus: response.status, inputTokens: usage.usage.prompt_tokens,
          outputTokens: usage.usage.completion_tokens, latencyMs: Math.round(performance.now() - started), estimatedUsd: usd(actual) });
        await persist();
      });
      return response;
    } catch {
      await serial(async () => {
        if (record.status === "pending") record.status = "unknown";
        closed = true;
        haltedReason = "Unknown provider cost or settlement persistence failure; no retry";
        await persist();
      });
      throw new Error("Inference stopped; reservation retained for any unaccounted request.");
    }
  };
  return {
    fetch: guardedFetch, snapshot,
    close: () => serial(async () => { closed = true; await persist(); })
  };
}
