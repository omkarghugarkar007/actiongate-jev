import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Publish gate: every publishable package must declare what it ships and have
 * built output matching those declarations. Catches a package that would publish
 * an empty tarball or point at a file that does not exist.
 */
const PACKAGES = ["core", "decision-provider", "connector-manifest", "proxy-core", "sdk-js", "mcp-gateway", "mcp-proxy", "http-proxy"];
let failed = false;

for (const name of PACKAGES) {
  const manifest = JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  const issues: string[] = [];

  for (const field of ["description", "license", "repository", "publishConfig", "files", "main", "types", "exports", "version"]) {
    if (!manifest[field]) issues.push(`missing ${field}`);
  }
  for (const relative of ["dist/index.js", "dist/index.d.ts"]) {
    if (!existsSync(new URL(`../packages/${name}/${relative}`, import.meta.url))) issues.push(`missing built ${relative}`);
  }
  const deps = (manifest.dependencies ?? {}) as Record<string, string>;
  for (const [dependency, range] of Object.entries(deps)) {
    // A workspace range must resolve to a real published version at pack time.
    if (range.startsWith("workspace:") && !dependency.startsWith("@actiongate/")) {
      issues.push(`${dependency} uses a workspace range but is not an ActionGate package`);
    }
  }

  if (issues.length) {
    failed = true;
    console.error(`FAIL  ${manifest.name ?? name}  (packages/${name})`);
    for (const issue of issues) console.error(`        ${issue}`);
  } else {
    console.log(`ok    ${manifest.name}@${manifest.version}  (packages/${name})`);
  }
}

if (failed) process.exit(1);
console.log(`\n${PACKAGES.length} packages ready to publish.`);
