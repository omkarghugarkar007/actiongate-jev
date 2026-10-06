import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NEMOTRON_PRESETS } from "@actiongate/decision-provider";
import { createNebiusBudget } from "../demos/nvidia-nebius/src/budget.js";
import { createDemoModel, ScenarioSchema } from "../demos/nvidia-nebius/src/runtime.js";
import { runResearchWorkflow } from "../demos/nvidia-nebius/src/research.js";
import { assertPublicEvidence } from "../demos/nvidia-nebius/src/recording.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowed = /^(--live|--paygo-disabled|--confirmed-free-credit|--seeded-snippet-attack|--balance-usd=\d+(?:\.\d+)?|--scenario=(refund|injection|limit|missing)|--output=[a-zA-Z0-9_./-]+)$/;
if (args.some((arg) => !allowed.test(arg)) || new Set(args.map((arg) => arg.split("=")[0])).size !== args.length) throw new Error("Unknown or duplicate research capture option.");
const option = (name: string, fallback: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const live = args.includes("--live");
if (live && (!args.includes("--paygo-disabled") || !args.includes("--confirmed-free-credit"))) throw new Error("Live mode requires --paygo-disabled --confirmed-free-credit --balance-usd=<confirmed promotional balance>.");
const scenario = ScenarioSchema.parse(option("scenario", "refund"));
const output = resolve(option("output", `.actiongate/research-${randomUUID()}.json`));
try { await access(output); throw new Error("Output exists; preserve the evidence and choose a new path."); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
const nebiusKey = process.env.NEBIUS_API_KEY;
const tavilyKey = process.env.TAVILY_API_KEY;
if (live && (!nebiusKey || !tavilyKey)) throw new Error("NEBIUS_API_KEY and TAVILY_API_KEY are required; no inference or search dispatched.");
const budget = live ? await createNebiusBudget({ apiKey: nebiusKey!, model: process.env.NEBIUS_MODEL ?? NEMOTRON_PRESETS.nebius.model,
  confirmedFreeBalanceUsd: Number(option("balance-usd", "0")), capUsd: 0.25, maxRequests: 8, ledgerPath: resolve(`.actiongate/research-inference-${randomUUID()}.json`) }) : undefined;
const model = createDemoModel(live ? "nebius" : "fake", process.env, budget?.fetch);
const events: unknown[] = [];
let result: Awaited<ReturnType<typeof runResearchWorkflow>> | null = null;
let error: string | null = null;
try {
  result = await runResearchWorkflow(scenario, model, { seededSnippetAttack: args.includes("--seeded-snippet-attack"), onEvent: (event) => events.push(event),
    ...(live ? { tavily: { apiKey: tavilyKey!, confirmedPaygoDisabled: true, maxCredits: 1, ledgerPath: resolve(`.actiongate/research-search-${randomUUID()}.json`) } } : {}) });
} catch { error = "Research workflow stopped; partial trace retained. Inspect dependency/budget state locally; no retry."; }
finally { await budget?.close(); }
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), mode: live ? "live" : "offline",
  dimension: "research integration and enforcement observation; not semantic accuracy", regressionStatus: "See separate Jev regression evidence in verification/TAVILY.md",
  result, partialEvents: result ? [] : events, error, inferenceBudget: budget?.snapshot() ?? null };
assertPublicEvidence(report, [nebiusKey ?? "", tavilyKey ?? "", process.env.NVIDIA_API_KEY ?? ""]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(`Saved ${live ? "live" : "offline"} research evidence: ${output}`);
console.log(`Search: ${result?.research?.provider ?? "not completed"}; credits ${result?.budget?.completedCredits ?? 0}; inference estimate $${budget?.snapshot().chargedEstimateUsd ?? 0}; sandbox refunds ${result?.refund?.executions ?? 0}.`);
if (error || !result?.research || !result.refund) process.exitCode = 1;
