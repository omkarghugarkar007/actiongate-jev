import { readFile, writeFile } from "node:fs/promises";
import { DatasetSchema, type EvalCase } from "../packages/evals/src/schema.js";

/**
 * Migrates the v1 generated set to the v2 schema. Nothing is relabelled: every
 * case keeps its label and becomes `generated`, which is what it always was.
 * The migration only makes the provenance explicit.
 */
const TOOL_RISK: Record<string, EvalCase["riskClass"]> = {
  refund_payment: "FINANCIAL",
  get_order: "READ_ONLY",
  send_email: "EXTERNAL_COMMUNICATION",
  delete_record: "DESTRUCTIVE"
};

const KIND_BY_TAG: [string, EvalCase["kind"]][] = [
  ["injection", "injection"],
  ["multilingual", "multilingual"],
  ["scope", "scope-creep"],
  ["target", "target-swap"],
  ["ambiguous", "ambiguous"],
  ["hard", "hard-negative"],
  ["paraphrase", "paraphrase"],
  ["supported", "supported"]
];

const raw = JSON.parse(await readFile(new URL("../packages/evals/datasets/core-v1.json", import.meta.url), "utf8")) as {
  cases: { id: string; tags: string[]; input: { userIntent: string; proposedAction: { tool: string; operation: string; arguments: Record<string, unknown> } }; expectedDecision: EvalCase["expectedDecision"]; acceptableDecisions: EvalCase["acceptableDecisions"]; notes?: string }[];
};

const cases: EvalCase[] = raw.cases.map((item) => {
  const kind = KIND_BY_TAG.find(([tag]) => item.tags.some((value) => value.includes(tag)))?.[1] ?? "supported";
  return {
    id: item.id,
    kind,
    riskClass: TOOL_RISK[item.input.proposedAction.tool] ?? "REVERSIBLE_WRITE",
    difficulty: "medium",
    tags: item.tags.slice(0, 20),
    input: item.input,
    expectedDecision: item.expectedDecision,
    acceptableDecisions: item.acceptableDecisions,
    annotation: { status: "generated", annotators: [] },
    notes: item.notes ?? "Migrated from core-v1. Generated label; awaiting independent review."
  } as EvalCase;
});

const dataset = DatasetSchema.parse({
  name: "core-v1",
  schemaVersion: 2,
  version: "1.0.0",
  description: "Procedurally generated calibration cases migrated from schema v1. Labels are generated and carry no authority.",
  guideline: "annotator-v1",
  cases
});

await writeFile(new URL("../packages/evals/datasets/core-v1.json", import.meta.url), `${JSON.stringify(dataset, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, cases: dataset.cases.length, reviewed: 0, note: "Labels unchanged; provenance now explicit." }, null, 2));
