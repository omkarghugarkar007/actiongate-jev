import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Local files and Git only: this command cannot invoke a provider or submit an entry.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "demos/nvidia-nebius/submission");
const output = resolve(directory, "dist");
const httpsUrl = z.url().refine((value) => new URL(value).protocol === "https:", "Use an HTTPS URL");
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  tagline: z.string().min(1),
  eventUrl: httpsUrl,
  track: z.literal("Best Apps and Agents"),
  repositoryUrl: httpsUrl,
  testBuild: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), url: httpsUrl, mode: z.string().min(1) }).strict(),
  video: z.object({
    url: httpsUrl.refine((value) => ["youtube.com", "www.youtube.com", "youtu.be"].includes(new URL(value).hostname), "Use a YouTube URL").nullable(),
    durationSeconds: z.number().positive().lt(180).nullable()
  }).strict(),
  entrant: z.object({
    displayName: z.string().min(1).nullable(),
    devpostProfileUrl: httpsUrl.refine((value) => new URL(value).hostname === "devpost.com", "Use a Devpost profile URL").nullable(),
    teamMembers: z.array(z.string().min(1)),
    eligibilityConfirmed: z.boolean(),
    ownershipConfirmed: z.boolean()
  }).strict(),
  publicAccess: z.object({
    repositoryCheckedSignedOut: z.boolean(),
    testBuildCheckedSignedOut: z.boolean(),
    videoCheckedSignedOut: z.boolean()
  }).strict(),
  submittedProjectUrl: httpsUrl.nullable()
}).strict();
const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(directory, "submission.json"), "utf8")));
const expectedBuildUrl = `${manifest.repositoryUrl}/archive/${manifest.testBuild.commit}.zip`;
if (manifest.testBuild.url !== expectedBuildUrl) throw new Error("Test-build URL must name the pinned source commit.");

const materials = [
  "APPLY.md",
  ...["APPLICATION.md", "JUDGING.md", "VIDEO.md", "VOICEOVER.txt", "FEEDBACK.md", "CHANGES.md", "MEDIA.md", "REVIEW.md", "submission.json", "assets/cover.svg", "assets/cover.png", "assets/evidence-workbench.png"].map((file) => `demos/nvidia-nebius/submission/${file}`),
  "demos/nvidia-nebius/assets/refund-lab.png",
  ...["README.md", "WORKBENCH.md", "public-access-2026-10-06.json", "nebius-workbench-2026-10-06.json", "nebius-live-2026-10-06.json", "nvidia-live-2026-10-06.json"].map((file) => `demos/nvidia-nebius/verification/${file}`),
  "demos/nvidia-nebius/IMPROVEMENT_PLAN.md",
  "demos/nvidia-nebius/SERVICE_EXPANSION.md",
  "demos/nvidia-nebius/verification/TAVILY.md",
  "demos/nvidia-nebius/verification/tavily-usage-2026-10-07.json",
  ...["tavily-refund", "tavily-limit", "tavily-jev-first", "tavily-jev"].map((name) => `demos/nvidia-nebius/verification/${name}-2026-10-07.json`),
  "demos/nvidia-nebius/submission/assets/research-lab.png",
  "packages/evals/datasets/hackathon-refund-v1.json"
];
for (const path of materials) await readFile(resolve(root, path));

const missing: string[] = [];
if (!manifest.entrant.displayName) missing.push("Entrant display name");
if (!manifest.entrant.devpostProfileUrl) missing.push("Entrant Devpost profile URL");
if (!manifest.entrant.eligibilityConfirmed) missing.push("Entrant's eligibility confirmation");
if (!manifest.entrant.ownershipConfirmed) missing.push("Entrant's ownership confirmation");
if (!manifest.video.url) missing.push("Actual public YouTube video URL");
if (!manifest.video.durationSeconds) missing.push("Actual video duration under 180 seconds");
for (const [name, checked] of Object.entries(manifest.publicAccess)) {
  if (!checked) missing.push(`Signed-out public access check: ${name}`);
}
console.log(`Application materials found: ${materials.length}. No inference or uploads performed.`);
for (const item of missing) console.log(`TODO: ${item}`);

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) throw new Error("Supported option: --check");
if (args.includes("--check")) {
  if (missing.length) process.exitCode = 1;
  else console.log("Required preparation fields are complete. The entrant must still submit on Devpost.");
} else {
  await mkdir(output, { recursive: true });
  // Archive committed source, never the working directory or .env. Keep examples.
  const committedPaths = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", manifest.testBuild.commit], { cwd: root }).toString().split("\0").filter(Boolean);
  const sourcePaths = committedPaths.filter((path) =>
    !(path.split("/").some((part) => part.startsWith(".env") && part !== ".env.example")) &&
    !path.includes("__pycache__/") && !path.endsWith(".pyc")
  );
  const archive = execFileSync("git", ["archive", "--format=zip", "--prefix=actiongate-refund-lab/", manifest.testBuild.commit, "--", ...sourcePaths], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const archiveName = `actiongate-test-build-${manifest.testBuild.commit.slice(0, 7)}.zip`;
  await writeFile(resolve(output, archiveName), archive);

  const hashes = [`${createHash("sha256").update(archive).digest("hex")}  ${archiveName}`];
  for (const path of materials) {
    const target = resolve(output, "materials", path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(resolve(root, path), target);
    hashes.push(`${createHash("sha256").update(await readFile(target)).digest("hex")}  materials/${path}`);
  }
  await writeFile(resolve(output, "SHA256SUMS.txt"), `${hashes.join("\n")}\n`);
  await writeFile(resolve(output, "submission-status.json"), `${JSON.stringify({ preparedSourceCommit: manifest.testBuild.commit, archive: archiveName, applicationFieldsComplete: missing.length === 0, missing, manifest }, null, 2)}\n`);
  await writeFile(resolve(output, "README.txt"), [
    "ActionGate hackathon preparation package",
    `Source test build: ${archiveName}`,
    "Extract the ZIP, open its root, run pnpm install --frozen-lockfile, then pnpm demo:nvidia.",
    "Open http://127.0.0.1:8095. This uses offline fixtures and makes no model calls.",
    "materials/ contains copy-paste application/media files in their original paths.",
    "For their full relative-link context, use the public repository or extracted source tree.",
    `Public source: ${manifest.repositoryUrl}`,
    "submission-status.json lists required entrant/video fields still missing.",
    "Nothing in this command uploads files or submits an entry."
  ].join("\n") + "\n");
  console.log(`Prepared ${basename(output)}/${archiveName}, materials, checksums and readiness report.`);
}
