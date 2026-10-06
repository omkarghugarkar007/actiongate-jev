import "dotenv/config";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { NEMOTRON_PRESETS } from "@actiongate/decision-provider";
import { createNebiusBudget } from "../demos/nvidia-nebius/src/budget.js";
import { createDemoModel, runDemo, type DemoEvent } from "../demos/nvidia-nebius/src/runtime.js";
import { assertPublicEvidence, inspectRun, RecordedResultSchema, RecordingSchema, type Recording } from "../demos/nvidia-nebius/src/recording.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowed = /^(--confirmed-free-credit|--balance-usd=\d+(?:\.\d+)?|--cap-usd=\d+(?:\.\d+)?|--rounds=[1-5]|--output=[a-zA-Z0-9_./-]+)$/;
if (args.some((arg) => !allowed.test(arg)) || !args.includes("--confirmed-free-credit")) {
  throw new Error("Use --confirmed-free-credit --balance-usd=<verified free balance> [--cap-usd=1] [--rounds=3] [--output=path]. This opt-in command spends inference credit.");
}
const option = (name: string, fallback: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const balance = z.coerce.number().positive().parse(option("balance-usd", "0"));
const cap = z.coerce.number().positive().max(1).parse(option("cap-usd", "1"));
const rounds = z.coerce.number().int().min(1).max(5).parse(option("rounds", "3"));
const output = resolve(option("output", "demos/nvidia-nebius/verification/nebius-workbench-2026-10-06.json"));
try { await access(output); throw new Error("Capture output exists; preserve it and choose a new output path."); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) throw new Error("NEBIUS_API_KEY is required; no inference dispatched.");
const requestedModel = process.env.NEBIUS_MODEL ?? NEMOTRON_PRESETS.nebius.model;
const ledgerPath = resolve(`.actiongate/nebius-batch-${randomUUID()}.json`);
const budget = await createNebiusBudget({ apiKey, model: requestedModel, confirmedFreeBalanceUsd: balance, capUsd: cap, maxRequests: 40, ledgerPath });
const model = createDemoModel("nebius", process.env, budget.fetch);
const runs: Recording["runs"] = [];
try {
  for (let round = 1; round <= rounds; round++) {
    for (const scenario of ["injection", "refund", "limit", "missing"] as const) {
      const id = `${scenario}-r${round}`;
      const partialEvents: DemoEvent[] = [];
      if (budget.snapshot().closed) {
        runs.push({ id, round, scenario, status: "not-run", result: null, partialEvents, error: "Batch closed after unknown provider accounting.", assertions: { wrongTargetUnchanged: null, policyOrIntentHeld: null, consumedBeforeExecution: null, replayRejected: null, desiredOutcomeObserved: null } });
        continue;
      }
      try {
        const result = RecordedResultSchema.parse(await runDemo(scenario, model, (event) => partialEvents.push(event)));
        assertPublicEvidence(result, [apiKey, process.env.NVIDIA_API_KEY ?? ""]);
        const assertions = inspectRun(result);
        runs.push({ id, round, scenario, status: "completed", result, partialEvents: [], error: null, assertions });
        console.log(`${id}: ${result.executions} sandbox executions; expected demonstration outcome ${assertions.desiredOutcomeObserved ? "observed" : "not observed"}.`);
      } catch {
        assertPublicEvidence(partialEvents, [apiKey]);
        runs.push({ id, round, scenario, status: "failed", result: null, partialEvents, error: "Run failed; partial trace retained, complete ledger unavailable.", assertions: { wrongTargetUnchanged: null, policyOrIntentHeld: null, consumedBeforeExecution: null, replayRejected: null, desiredOutcomeObserved: null } });
        console.log(`${id}: failed; retained partial evidence.`);
      }
    }
  }
} finally { await budget.close(); }
const recording = RecordingSchema.parse({ schemaVersion: 1, createdAt: new Date().toISOString(), provider: "nebius", requestedModel,
  dimension: "repeated integration and enforcement observations; not semantic accuracy", labelStatus: "synthetic scenarios; no independent semantic review",
  rounds, budget: budget.snapshot(), runs });
assertPublicEvidence(recording, [apiKey, process.env.NVIDIA_API_KEY ?? ""]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(recording, null, 2) + "\n", { flag: "wx" });
const expected = runs.filter((run) => run.assertions.desiredOutcomeObserved).length;
console.log(`Saved all ${runs.length} planned cases; ${expected} desired outcomes; ${recording.budget.requests.length} calls; estimated $${recording.budget.chargedEstimateUsd}; batch closed.`);
if (runs.some((run) => run.status !== "completed" || Object.values(run.assertions).some((value) => value === false))) process.exitCode = 1;
