import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";

/**
 * Builds publishable packages in dependency order. Each package resolves its
 * siblings through their published `exports`, so a dependency must be built
 * before anything that imports it.
 */
const ORDER = [
  "core",
  "decision-provider",
  "connector-manifest",
  "proxy-core",
  "sdk-js",
  "mcp-gateway",
  "mcp-proxy",
  "http-proxy"
];

for (const name of ORDER) {
  await rm(new URL(`../packages/${name}/dist/`, import.meta.url), { recursive: true, force: true });
}

for (const name of ORDER) {
  process.stdout.write(`building @actiongate/${name} ... `);
  execFileSync("npx", ["tsc", "-p", `packages/${name}/tsconfig.build.json`], { stdio: "pipe" });
  console.log("ok");
}
console.log(`\n${ORDER.length} packages built.`);
