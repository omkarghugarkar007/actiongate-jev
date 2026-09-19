import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OpenRouterJevProvider } from "../packages/decision-provider/src/index.js";

const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
if (!key) { console.error("Set OPENROUTER_API_KEY in .env (OPENROUTER_KEY is accepted for local compatibility)."); process.exit(1); }
const fixturePath = new URL("../fixtures/openrouter/jev-1.13-smoke.request.json", import.meta.url);
const payload = JSON.parse(await readFile(fixturePath, "utf8"));
const provider = new OpenRouterJevProvider({ apiKey: key, model: "typesafe/jev-1.13", appTitle: "ActionGate Jev smoke test" });
const started = performance.now();
try {
  const response = await provider.evaluate({ state: payload.state, questions: payload.questions }, { timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 10_000) });
  const latencyMs = Math.round(performance.now() - started);
  const sanitized = { ...response, metadata: { ...response.metadata, endpoint: "https://openrouter.ai/api/alpha/decisions", capturedAt: new Date().toISOString(), latencyMs } };
  const responsePath = new URL("../fixtures/openrouter/jev-1.13-smoke.response.json", import.meta.url);
  await mkdir(new URL("../fixtures/openrouter/", import.meta.url), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, latencyMs, requestedModel: "typesafe/jev-1.13", resolvedModel: response.model, gateway: response.provider, upstreamProvider: response.metadata?.upstreamProvider, fixture: "fixtures/openrouter/jev-1.13-smoke.response.json" }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
