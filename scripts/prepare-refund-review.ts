import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DatasetSchema } from "../packages/evals/src/schema.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = await readFile(resolve(root, "packages/evals/datasets/hackathon-refund-v1.json"));
const dataset = DatasetSchema.parse(JSON.parse(source.toString()));
if (dataset.cases.some((item) => item.annotation.status !== "generated")) {
  throw new Error("Use a separate version for reviewed labels; preserve this frozen draft corpus.");
}
const directory = resolve(root, "demos/nvidia-nebius/submission/dist/review");
await mkdir(directory, { recursive: true });
// No kinds, draft labels, difficulty hints or model predictions in the reviewer packet.
const packet = { dataset: dataset.name, version: dataset.version, guideline: dataset.guideline,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  cases: dataset.cases.map(({ id, input }) => ({ id, input, review: {
    reviewerId: "", decision: "", acceptableDecisions: [], rationale: "", dissent: "", reviewedAt: ""
  } }))
};
const csv = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
const headers = ["id", "userIntent", "proposedAction", "resources", "deterministicFacts", "reviewerId", "decision", "acceptableDecisions", "rationale", "dissent", "reviewedAt"];
const rows = packet.cases.map(({ id, input }) => [id, input.userIntent, JSON.stringify(input.proposedAction), JSON.stringify(input.resources ?? {}), JSON.stringify(input.deterministicFacts ?? {}), "", "", "", "", "", ""]);
await writeFile(resolve(directory, "blind-review.json"), JSON.stringify(packet, null, 2) + "\n");
await writeFile(resolve(directory, "blind-review.csv"), [headers, ...rows].map((row) => row.map(csv).join(",")).join("\n") + "\n");
await writeFile(resolve(directory, "source-sha256.txt"), packet.sourceSha256 + "\n");
await writeFile(resolve(directory, "ANNOTATOR_GUIDE.md"), await readFile(resolve(root, "docs/annotation-guide.md")));
await writeFile(resolve(directory, "README.md"), await readFile(resolve(root, "demos/nvidia-nebius/submission/REVIEW.md")));
console.log(`Prepared ${packet.cases.length} blind review cases with a frozen source hash. No predictions, inference, uploads or reviewed labels created.`);
