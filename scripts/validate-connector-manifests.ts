import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { validateConnectorManifest } from "../packages/connector-manifest/src/index.js";

/** CI gate: every connector manifest in the workspace must be valid. */
const paths: string[] = [];
for await (const entry of glob("packages/*/connector.manifest.json")) paths.push(entry);
paths.sort();

if (paths.length === 0) {
  console.error("No connector manifests found. Expected packages/*/connector.manifest.json");
  process.exit(1);
}

let failed = false;
for (const path of paths) {
  const result = validateConnectorManifest(JSON.parse(await readFile(path, "utf8")));
  if (result.valid) {
    console.log(`ok    ${path}  (${result.manifest.level}, tier ${result.manifest.requires.minimumTier}, ${result.manifest.setup.steps} steps)`);
    continue;
  }
  failed = true;
  console.error(`FAIL  ${path}`);
  for (const issue of result.issues) console.error(`        ${issue.path}: ${issue.message}`);
}
if (failed) process.exit(1);
console.log(`\n${paths.length} connector manifests valid.`);
