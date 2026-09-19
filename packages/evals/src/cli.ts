import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type Decision = "ALLOW" | "REVIEW" | "BLOCK";
type DatasetCase = {
  id: string;
  tags: string[];
  expectedDecision: Decision;
  acceptableDecisions: Decision[];
  notes?: string;
};

const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1] ?? "true"] : ["", ""]));
const datasetName = args.get("dataset") ?? "core-v1";
const path = new URL(`../datasets/${datasetName}.json`, import.meta.url);
const source = await readFile(path, "utf8");
const dataset = JSON.parse(source) as { name?: string; schemaVersion?: number; cases?: DatasetCase[] };
const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
const ids = cases.map((item) => item.id);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
const allowedDecisions = new Set<Decision>(["ALLOW", "REVIEW", "BLOCK"]);
const issues: string[] = [];

if (dataset.name !== datasetName) issues.push(`Dataset name ${String(dataset.name)} does not match ${datasetName}`);
if (dataset.schemaVersion !== 1) issues.push(`Unsupported schemaVersion ${String(dataset.schemaVersion)}`);
if (cases.length === 0) issues.push("Dataset has no cases");
if (duplicates.length) issues.push(`Duplicate case IDs: ${duplicates.join(", ")}`);

for (const item of cases) {
  if (!item.id || !Array.isArray(item.tags) || item.tags.length === 0) issues.push(`${item.id || "<missing-id>"}: missing ID or tags`);
  if (!allowedDecisions.has(item.expectedDecision)) issues.push(`${item.id}: invalid expected decision`);
  if (!Array.isArray(item.acceptableDecisions) || item.acceptableDecisions.length === 0) issues.push(`${item.id}: no acceptable decisions`);
  if (!item.acceptableDecisions?.includes(item.expectedDecision)) issues.push(`${item.id}: expected decision is not acceptable`);
  if (item.acceptableDecisions?.some((decision) => !allowedDecisions.has(decision))) issues.push(`${item.id}: invalid acceptable decision`);
}

const tagCounts = Object.fromEntries([...new Set(cases.flatMap((item) => item.tags))].sort().map((tag) => [tag, cases.filter((item) => item.tags.includes(tag)).length]));
const expectedDecisionCounts = Object.fromEntries([...allowedDecisions].map((decision) => [decision, cases.filter((item) => item.expectedDecision === decision).length]));
const report = {
  dataset: datasetName,
  datasetHash: createHash("sha256").update(source).digest("hex"),
  mode: "dataset-integrity",
  schemaVersion: dataset.schemaVersion ?? null,
  caseCount: cases.length,
  expectedDecisionCounts,
  tagCounts,
  casesMarkedForHumanReview: cases.filter((item) => /human review/i.test(item.notes ?? "")).length,
  issues,
  valid: issues.length === 0,
  createdAt: new Date().toISOString(),
  note: "No predictions or provider calls were made. This report validates dataset structure only and is not an accuracy result."
};

const outputDir = new URL("../reports/", import.meta.url);
await mkdir(outputDir, { recursive: true });
await writeFile(new URL(`${datasetName}-integrity.json`, outputDir), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(new URL(`${datasetName}-integrity.md`, outputDir), `# ActionGate dataset integrity\n\n> No predictions or provider calls were made. This is not an accuracy result.\n\n| Check | Value |\n|---|---:|\n| Cases | ${report.caseCount} |\n| Dataset hash | \`${report.datasetHash}\` |\n| Marked for human review | ${report.casesMarkedForHumanReview} |\n| Integrity issues | ${report.issues.length} |\n| Valid | ${report.valid ? "yes" : "no"} |\n\n## Expected labels\n\n${Object.entries(expectedDecisionCounts).map(([key, value]) => `- ${key}: ${value}`).join("\n")}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 1;
