import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { assertPublicEvidence, RecordingSchema } from "../demos/nvidia-nebius/src/recording.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "demos/nvidia-nebius/workbench");
const output = resolve(root, "demos/nvidia-nebius/submission/dist/workbench");
const recording = RecordingSchema.parse(JSON.parse(await readFile(resolve(root, "demos/nvidia-nebius/verification/nebius-workbench-2026-10-06.json"), "utf8")));
assertPublicEvidence(recording);
await mkdir(output, { recursive: true });
for (const file of ["index.html", "style.css", "app.js"]) await copyFile(resolve(source, file), resolve(output, file));
await writeFile(resolve(output, "recording.json"), JSON.stringify(recording) + "\n");
await writeFile(resolve(output, ".nojekyll"), "");
console.log(`Built key-free recorded evidence page with all ${recording.runs.length} planned runs. No inference performed.`);
