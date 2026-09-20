import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * CycloneDX SBOM for the production dependency tree.
 *
 * Built from the lockfile via `pnpm list --prod`, so it describes what actually
 * ships rather than what package.json asks for.
 */
interface PnpmNode { version?: string; resolved?: string; dependencies?: Record<string, PnpmNode> }
interface PnpmProject { name?: string; version?: string; dependencies?: Record<string, PnpmNode> }

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string; license?: string };
const listed = JSON.parse(execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json", "-r"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as PnpmProject[];

const components = new Map<string, { name: string; version: string; purl: string }>();
const walk = (dependencies: Record<string, PnpmNode> | undefined) => {
  for (const [name, node] of Object.entries(dependencies ?? {})) {
    const version = node.version ?? "0.0.0";
    // Workspace packages are the subject of the SBOM, not third-party components.
    if (version.startsWith("link:") || name.startsWith("@actiongate/")) { walk(node.dependencies); continue; }
    const key = `${name}@${version}`;
    if (!components.has(key)) components.set(key, { name, version, purl: `pkg:npm/${name.replace("@", "%40")}@${version}` });
    walk(node.dependencies);
  }
};
for (const project of listed) walk(project.dependencies);

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "ActionGate", name: "generate-sbom", version: root.version }],
    component: { type: "application", "bom-ref": `${root.name}@${root.version}`, name: root.name, version: root.version, ...(root.license ? { licenses: [{ license: { id: root.license } }] } : {}) }
  },
  components: [...components.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
    .map((component) => ({ type: "library", "bom-ref": component.purl, name: component.name, version: component.version, purl: component.purl }))
};

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/sbom.cdx.json", import.meta.url), `${JSON.stringify(sbom, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, components: sbom.components.length, output: "dist/sbom.cdx.json" }, null, 2));
