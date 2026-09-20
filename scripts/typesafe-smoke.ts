import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TypeSafeJevProvider } from "../packages/decision-provider/src/index.js";

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("Set TYPESAFE_API_KEY before running the direct TypeSafe smoke test.");
  process.exit(1);
}

const fixturePath = new URL("../fixtures/typesafe/jev-1.13-smoke.request.json", import.meta.url);
const payload = JSON.parse(await readFile(fixturePath, "utf8"));
const requestedModel = process.env.TYPESAFE_MODEL ?? payload.model ?? "jev-1.13.0";
const provider = new TypeSafeJevProvider({ apiKey: key, model: requestedModel });
const started = performance.now();

try {
  const response = await provider.evaluate(
    { state: payload.state, questions: payload.questions },
    { timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 10_000) }
  );
  const latencyMs = Math.round(performance.now() - started);
  const sanitized = {
    ...response,
    metadata: {
      ...response.metadata,
      endpoint: "https://api.typesafe.ai/v1/systemone",
      capturedAt: new Date().toISOString(),
      latencyMs
    }
  };
  const responsePath = new URL("../fixtures/typesafe/jev-1.13-smoke.response.json", import.meta.url);
  await mkdir(new URL("../fixtures/typesafe/", import.meta.url), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    latencyMs,
    requestedModel,
    resolvedModel: response.model,
    gateway: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    fixture: "fixtures/typesafe/jev-1.13-smoke.response.json"
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
