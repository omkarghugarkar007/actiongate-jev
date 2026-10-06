import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// Finite public queries prevent customer intent, ticket text or ledger data from
// being sent to the search vendor. These constraints belong to the executor.
export const PUBLIC_REFUND_QUERY = "Stripe refund processing times and idempotent refund requests documentation";
export const ResearchArgumentsSchema = z.object({
  query: z.literal(PUBLIC_REFUND_QUERY), domains: z.tuple([z.literal("docs.stripe.com")]),
  searchDepth: z.literal("basic"), maxResults: z.literal(3)
}).strict();
export type ResearchArguments = z.infer<typeof ResearchArgumentsSchema>;
export const researchArguments = (): ResearchArguments => ({ query: PUBLIC_REFUND_QUERY, domains: ["docs.stripe.com"], searchDepth: "basic", maxResults: 3 });
export const ResearchEvidenceSchema = z.object({
  schemaVersion: z.literal(1), provider: z.enum(["tavily", "offline-fixture"]),
  trust: z.literal("untrusted public documentation; never authorization or ledger facts"),
  requestId: z.string().min(1).max(128), credits: z.number().int().min(0).max(1),
  sources: z.array(z.object({ title: z.string().min(1).max(200), url: z.string().url().max(2048), snippet: z.string().min(1).max(1200) }).strict()).min(1).max(3)
}).strict();
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
const UsageSchema = z.object({
  key: z.object({ usage: z.number().int().nonnegative(), limit: z.number().int().nonnegative().nullable() }),
  account: z.object({ current_plan: z.literal("Researcher"), plan_usage: z.number().int().nonnegative(),
    plan_limit: z.literal(1000), paygo_usage: z.literal(0), paygo_limit: z.number().int().nonnegative().nullable() })
});
type FreeUsage = z.infer<typeof UsageSchema>;
async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Empty provider response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Provider response exceeds evidence limit.");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
const SearchResponseSchema = z.object({
  request_id: z.string().min(1).max(128), usage: z.object({ credits: z.literal(1) }),
  results: z.array(z.object({ title: z.string().min(1).max(10_000), url: z.string().url().max(2048), content: z.string().min(1).max(100_000) })).min(1).max(3)
});

export function offlineResearchEvidence(): ResearchEvidence {
  return { schemaVersion: 1, provider: "offline-fixture", trust: "untrusted public documentation; never authorization or ledger facts",
    requestId: "scripted-public-documentation", credits: 0, sources: [{ title: "Offline fixture: refund reference", url: "https://docs.stripe.com/refunds",
      snippet: "Scripted source for local plumbing. Refund processing may take time; this snippet does not establish ownership or permission." }] };
}

/** Executor-owned, one-shot free-credit batch. Not a provider account billing limit. */
export async function createTavilyBatch(options: {
  apiKey: string; confirmedPaygoDisabled: boolean; maxCredits: number; ledgerPath: string; fetch?: typeof globalThis.fetch;
}) {
  if (!options.apiKey.trim() || options.confirmedPaygoDisabled !== true) throw new Error("A Tavily key and confirmation that paid overflow is disabled are required.");
  z.number().int().min(1).max(5).parse(options.maxCredits);
  const fetcher = options.fetch ?? globalThis.fetch;
  const month = () => new Date().toISOString().slice(0, 7);
  const startedMonth = month();
  let closed = false;
  let haltedReason: string | null = null;
  let lastUsage: FreeUsage;
  const calls: { sequence: number; status: "reserved" | "completed" | "unknown"; credits: number; latencyMs?: number }[] = [];
  let queue = Promise.resolve();
  function serial<T>(fn: () => Promise<T>) { const task = queue.then(fn); queue = task.then(() => {}, () => {}); return task; }
  async function usage(): Promise<FreeUsage> {
    try {
      const response = await fetcher("https://api.tavily.com/usage", { headers: { Authorization: `Bearer ${options.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error();
      const state = UsageSchema.parse(await boundedJson(response, 16_384));
      // null is unspecified, not zero: owner confirmation is still required.
      if (state.account.paygo_limit !== null && state.account.paygo_limit !== 0) throw new Error();
      const remaining = Math.min(state.account.plan_limit - state.account.plan_usage, state.key.limit === null ? Infinity : state.key.limit - state.key.usage);
      if (remaining < 100 + options.maxCredits || state.account.plan_usage > 500) throw new Error();
      return state;
    } catch { throw new Error("Cannot establish sufficient free-only Tavily usage; no search dispatched."); }
  }
  const initialUsage = lastUsage = await usage();
  function snapshot() {
    return { schemaVersion: 1, provider: "tavily", month: startedMonth,
      confirmationSource: "Owner confirmed pay-as-you-go disabled; usage API does not prove that setting",
      maximumCredits: options.maxCredits, reservedCredits: calls.filter((call) => call.status !== "completed").length,
      completedCredits: calls.filter((call) => call.status === "completed").reduce((sum, call) => sum + call.credits, 0),
      closed, haltedReason, initialUsage: structuredClone(initialUsage), lastUsage: structuredClone(lastUsage), calls: structuredClone(calls) };
  }
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  await writeFile(options.ledgerPath, JSON.stringify(snapshot(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  async function persist() {
    await writeFile(options.ledgerPath + ".tmp", JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 });
    await rename(options.ledgerPath + ".tmp", options.ledgerPath);
  }
  return {
    snapshot,
    close: () => serial(async () => { closed = true; await persist(); }),
    search: (input: unknown): Promise<ResearchEvidence> => serial(async () => {
      // Do not include rejected arguments in error messages (they may be private).
      const parsed = ResearchArgumentsSchema.safeParse(input);
      if (!parsed.success) throw new Error("Only the executor-owned public documentation query is supported.");
      if (closed || month() !== startedMonth || calls.length >= options.maxCredits) throw new Error("Tavily batch is closed or exhausted; no search dispatched.");
      lastUsage = await usage();
      const call: typeof calls[number] = { sequence: calls.length + 1, status: "reserved", credits: 1 };
      calls.push(call);
      try { await persist(); }
      catch { closed = true; haltedReason = "Reservation persistence failed"; throw new Error("Cannot persist search reservation; no search dispatched."); }
      const started = performance.now();
      try {
        const response = await fetcher("https://api.tavily.com/search", {
          method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ query: parsed.data.query, include_domains: parsed.data.domains, include_domains_mode: "restrict", topic: "general",
            search_depth: "basic", max_results: 3, auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_usage: true })
        });
        if (!response.ok) throw new Error();
        const raw = SearchResponseSchema.parse(await boundedJson(response, 262_144));
        const sources = raw.results.map((source) => {
          const url = new URL(source.url);
          if (url.protocol !== "https:" || url.hostname !== "docs.stripe.com" || url.port || url.username || url.password) throw new Error();
          return { title: source.title.slice(0, 200), url: url.href, snippet: source.content.slice(0, 1200) };
        });
        const evidence = ResearchEvidenceSchema.parse({ schemaVersion: 1, provider: "tavily", trust: "untrusted public documentation; never authorization or ledger facts", requestId: raw.request_id, credits: 1, sources });
        call.status = "completed";
        call.latencyMs = Math.round(performance.now() - started);
        await persist();
        return evidence;
      } catch {
        // A lost response may still have cost a credit; never retry or reuse it.
        if (call.status === "reserved") call.status = "unknown";
        closed = true; haltedReason = "Unknown usage, invalid source evidence or persistence failure; no retry";
        await persist();
        throw new Error("Tavily search stopped; any unknown reservation is retained and the batch is closed.");
      }
    })
  };
}
