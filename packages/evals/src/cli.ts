import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FakeDecisionProvider, OpenRouterJevProvider } from "@actiongate/decision-provider";
import type { DecisionProvider } from "@actiongate/core";
import { calibrate, hashDataset, type CalibrationReport } from "./calibrate.js";
import { detectDrift } from "./drift.js";
import { DatasetSchema, summarizeDataset, type Dataset } from "./schema.js";

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "validate";
const flags = new Map<string, string>();
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index]!;
  if (!value.startsWith("--")) continue;
  const next = argv[index + 1];
  flags.set(value.slice(2), next && !next.startsWith("--") ? next : "true");
}

const datasetName = flags.get("dataset") ?? "core-v2";
const reportsDir = new URL("../reports/", import.meta.url);
await mkdir(reportsDir, { recursive: true });

switch (command) {
  case "validate": await validate(); break;
  case "calibrate": await runCalibration(); break;
  case "drift": await runDrift(); break;
  default:
    console.error(`Unknown command "${command}". Use validate, calibrate, or drift.`);
    process.exit(1);
}

async function loadDataset(): Promise<{ dataset: Dataset; raw: string }> {
  const raw = await readFile(new URL(`../datasets/${datasetName}.json`, import.meta.url), "utf8");
  const parsed = DatasetSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`Dataset ${datasetName} is invalid:`);
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    process.exit(1);
  }
  return { dataset: parsed.data, raw };
}

/** Structure and provenance only. Produces no predictions and calls no provider. */
async function validate() {
  const { dataset, raw } = await loadDataset();
  const summary = summarizeDataset(dataset);
  const ids = dataset.cases.map((item) => item.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const issues: string[] = [];
  if (duplicates.length) issues.push(`Duplicate case IDs: ${duplicates.join(", ")}`);

  // Structural validity and quality-readiness are different questions. An
  // unreviewed dataset is well-formed; it just cannot back a quality claim, and
  // the calibration command is where that is enforced.
  const warnings: string[] = [];
  if (summary.reviewed === 0) warnings.push("No case carries a reviewed label, so this dataset cannot support a quality claim");
  if (summary.disputed > 0) warnings.push(`${summary.disputed} disputed cases are excluded from every report until resolved`);

  const report = {
    dataset: dataset.name,
    datasetVersion: dataset.version,
    guideline: dataset.guideline,
    datasetHash: createHash("sha256").update(raw).digest("hex"),
    mode: "dataset-integrity",
    summary,
    issues,
    warnings,
    valid: issues.length === 0,
    qualityClaimSupported: summary.reviewed > 0,
    createdAt: new Date().toISOString(),
    note: "No predictions or provider calls were made. This validates structure and provenance only, and is not an accuracy result."
  };
  await writeFile(new URL(`${dataset.name}-integrity.json`, reportsDir), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

async function runCalibration() {
  const { dataset } = await loadDataset();
  const includeUnreviewed = flags.get("include-unreviewed") === "true";
  const reviewed = dataset.cases.filter((item) => item.annotation.status === "reviewed").length;
  if (reviewed === 0 && !includeUnreviewed) {
    console.error(`No reviewed cases in ${dataset.name}. Review labels first, or pass --include-unreviewed to measure plumbing only.`);
    process.exit(1);
  }

  const report = await calibrate({
    dataset,
    provider: buildProvider(),
    includeUnreviewed,
    ...(flags.get("concurrency") ? { concurrency: Number(flags.get("concurrency")) } : {})
  });
  const base = `${dataset.name}-calibration`;
  await writeFile(new URL(`${base}.json`, reportsDir), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(new URL(`${base}.md`, reportsDir), renderMarkdown(report));
  console.log(JSON.stringify({
    runId: report.runId,
    evaluated: report.evaluated,
    excludedUnreviewed: report.excludedUnreviewed,
    qualityClaimSupported: report.qualityClaimSupported,
    profiles: report.profiles.map((profile) => ({
      profile: profile.profile,
      unsafeAllow: profile.overall.unsafeAllow.rate,
      autoAllowPrecision: profile.overall.autoAllowPrecision.rate,
      reviewRate: profile.overall.reviewRate.rate,
      falseBlock: profile.overall.falseBlock.rate
    })),
    note: report.note
  }, null, 2));
}

async function runDrift() {
  const baselinePath = flags.get("baseline") ?? `${datasetName}-calibration.json`;
  const candidatePath = flags.get("candidate") ?? `${datasetName}-calibration.json`;
  const baseline = JSON.parse(await readFile(new URL(baselinePath, reportsDir), "utf8")) as CalibrationReport;
  const candidate = JSON.parse(await readFile(new URL(candidatePath, reportsDir), "utf8")) as CalibrationReport;
  const report = detectDrift(baseline, candidate);
  await writeFile(new URL(`${datasetName}-drift.json`, reportsDir), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.promotable) process.exitCode = 1;
}

function buildProvider(): DecisionProvider {
  const wanted = flags.get("provider") ?? process.env.DECISION_PROVIDER ?? "fake";
  if (wanted !== "openrouter") return FakeDecisionProvider.allow();
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required for a provider-backed calibration run.");
    process.exit(1);
  }
  return new OpenRouterJevProvider({ apiKey, model: process.env.JEV_MODEL ?? "typesafe/jev-1.13", appTitle: "ActionGate calibration" });
}

function renderMarkdown(report: CalibrationReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const band = (rate: { rate: number; interval: { low: number; high: number } }) =>
    `${pct(rate.rate)} (${pct(rate.interval.low)}–${pct(rate.interval.high)})`;

  const lines = [
    "# ActionGate calibration report",
    "",
    report.qualityClaimSupported
      ? "> Every case carries a reviewed label."
      : "> **This run included labels no person reviewed. It measures plumbing and cost, not semantic quality.**",
    "",
    "| Pinned version | Value |",
    "|---|---|",
    `| Dataset | ${report.versions.datasetName}@${report.versions.dataset} |`,
    `| Dataset hash | \`${report.versions.datasetHash.slice(0, 16)}…\` |`,
    `| Policy | ${report.versions.policy} |`,
    `| Battery | ${report.versions.battery} |`,
    `| Model requested | ${report.versions.requestedModel} |`,
    `| Model resolved | ${report.versions.resolvedModel ?? "n/a"} |`,
    "",
    `Evaluated ${report.evaluated} cases (${report.excludedUnreviewed} excluded as unreviewed or disputed). `
      + `p50 ${report.latencyMs.p50}ms, p95 ${report.latencyMs.p95}ms. Provider cost $${report.cost.costUsd.toFixed(6)}.`,
    ""
  ];

  for (const profile of report.profiles) {
    lines.push(`## Threshold profile: ${profile.profile}`, "");
    lines.push("| Metric | Value (95% CI) |", "|---|---|");
    lines.push(`| **Unsafe allow** | **${band(profile.overall.unsafeAllow)}** |`);
    lines.push(`| Auto-allow precision | ${band(profile.overall.autoAllowPrecision)} |`);
    lines.push(`| Safe coverage | ${band(profile.overall.safeCoverage)} |`);
    lines.push(`| False block | ${band(profile.overall.falseBlock)} |`);
    lines.push(`| Review rate | ${band(profile.overall.reviewRate)} |`);
    lines.push(`| Block rate | ${band(profile.overall.blockRate)} |`);
    lines.push("", "### By risk class", "", "| Risk | Cases | Unsafe allow | Coverage |", "|---|---:|---|---|");
    for (const [risk, metrics] of Object.entries(profile.byRisk)) {
      lines.push(`| ${risk} | ${metrics.count} | ${band(metrics.unsafeAllow)} | ${band(metrics.safeCoverage)} |`);
    }
    lines.push("", "### By action type", "", "| Tool | Cases | Unsafe allow | Auto-allow precision | Review rate | False block |", "|---|---:|---|---|---|---|");
    for (const [tool, metrics] of Object.entries(profile.byTool)) {
      lines.push(`| ${tool} | ${metrics.count} | ${band(metrics.unsafeAllow)} | ${band(metrics.autoAllowPrecision)} | ${band(metrics.reviewRate)} | ${band(metrics.falseBlock)} |`);
    }
    lines.push("", "### By case kind", "", "| Kind | Cases | Unsafe allow | Agreement |", "|---|---:|---|---|");
    for (const [kind, metrics] of Object.entries(profile.byKind)) {
      lines.push(`| ${kind} | ${metrics.count} | ${band(metrics.unsafeAllow)} | ${band(metrics.agreement)} |`);
    }
    lines.push("");
  }

  lines.push("---", "", report.note, "",
    "Unsafe-allow rate is the safety number and is never averaged with the others.",
    "See [annotator guidance](../../../docs/annotation-guide.md) for what these labels mean.", "");
  return lines.join("\n");
}

void hashDataset;
