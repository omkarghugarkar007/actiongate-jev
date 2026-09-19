import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
if (!key) { console.error("Set OPENROUTER_API_KEY before running cost tracking."); process.exit(1); }
const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
if (!response.ok) { console.error(`OpenRouter cost query failed with HTTP ${response.status}`); process.exit(1); }
const raw = await response.json() as { data?: { usage?: number; usage_daily?: number; usage_weekly?: number; usage_monthly?: number; limit?: number | null; limit_remaining?: number | null } };
const current = {
  capturedAt: new Date().toISOString(),
  usageUsd: raw.data?.usage ?? 0,
  dailyUsageUsd: raw.data?.usage_daily ?? 0,
  weeklyUsageUsd: raw.data?.usage_weekly ?? 0,
  monthlyUsageUsd: raw.data?.usage_monthly ?? 0,
  limitUsd: raw.data?.limit ?? null,
  remainingUsd: raw.data?.limit_remaining ?? null
};
const stateDir = new URL("../.actiongate/", import.meta.url);
const snapshotPath = new URL("openrouter-cost.json", stateDir);
let previous: typeof current | undefined;
try { previous = JSON.parse(await readFile(snapshotPath, "utf8")) as typeof current; } catch { /* first snapshot */ }
await mkdir(stateDir, { recursive: true });
await writeFile(snapshotPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ...current,
  deltaSinceLastSnapshotUsd: previous ? current.usageUsd - previous.usageUsd : null,
  snapshot: ".actiongate/openrouter-cost.json"
}, null, 2));
