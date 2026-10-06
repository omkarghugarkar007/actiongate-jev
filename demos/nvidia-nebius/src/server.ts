import "dotenv/config";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";
import { createDemoModel, runDemo, ScenarioSchema } from "./runtime.js";

if (process.env.NODE_ENV === "production") throw new Error("The sandbox demo is local-only. Use the hardened API deployment for production.");
const backend = z.enum(["fake", "nvidia", "nebius"]).parse(process.env.DEMO_BACKEND ?? "fake");
const model = createDemoModel(backend);
const page = await readFile(new URL("../frontend/index.html", import.meta.url), "utf8");
const app = Fastify({ logger: false, bodyLimit: 2048 });
let running = false;
let lastLiveRun = 0;
app.get("/", async (_request, reply) => reply.type("text/html").send(page));
app.get("/health", async () => ({ status: "ok", backend, live: backend !== "fake" }));
app.get("/api/config", async () => ({ backend, live: backend !== "fake", model: model.planner?.model ?? "Offline fixtures", boundary: "Sandbox ledger; no money moves. Run state is in memory." }));
app.post("/api/runs", async (request, reply) => {
  const input = z.object({ scenario: ScenarioSchema }).strict().safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: "Choose a supported scenario." });
  const origin = request.headers.origin;
  if (!["127.0.0.1", "localhost"].some((host) => request.headers.host === `${host}:${port}`)) return reply.code(403).send({ error: "Runs require the local demo host." });
  // Browsers cannot spend the local key through a foreign site's form or fetch.
  if (origin && origin !== `http://${request.headers.host}`) return reply.code(403).send({ error: "Cross-origin runs are forbidden." });
  if (running || (backend !== "fake" && Date.now() - lastLiveRun < 15_000)) return reply.code(429).send({ error: "A run is active or cooling down. Try again shortly." });
  running = true;
  if (backend !== "fake") lastLiveRun = Date.now();
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const write = (value: unknown) => { if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n"); };
  try {
    const result = await runDemo(input.data.scenario, model, (event) => write({ type: "event", event }));
    write({ type: "result", result });
  } catch {
    write({ type: "error", error: "Run stopped because a dependency failed. Check the provider key, model and availability; no unconsumed action is executed." });
  } finally { running = false; reply.raw.end(); }
});
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.NVIDIA_DEMO_PORT ?? 8095);
await app.listen({ host: "127.0.0.1", port });
console.log(`ActionGate refund lab: http://127.0.0.1:${port} (${backend === "fake" ? "offline fixtures" : `live ${backend} Nemotron`})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
