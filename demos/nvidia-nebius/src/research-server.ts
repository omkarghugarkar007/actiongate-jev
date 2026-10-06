import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";
import { createDemoModel, ScenarioSchema } from "./runtime.js";
import { runResearchWorkflow } from "./research.js";

// This recording/rehearsal server is always offline, even with keys in .env.
if (process.env.NODE_ENV === "production") throw new Error("Research lab is local-only.");
const model = createDemoModel("fake", {});
const app = Fastify({ logger: false, bodyLimit: 2048 });
const port = 8097;
let running = false;
const page = await readFile(new URL("../frontend/research.html", import.meta.url), "utf8");
app.get("/", async (_request, reply) => reply.type("text/html").send(page));
app.get("/health", async () => ({ status: "ok", mode: "offline", credits: 0 }));
app.post("/api/runs", async (request, reply) => {
  const input = z.object({ scenario: ScenarioSchema, seededSnippetAttack: z.boolean() }).strict().safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: "Choose a supported scenario and attack setting." });
  if (!["127.0.0.1:8097", "localhost:8097"].includes(request.headers.host ?? "") || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) return reply.code(403).send({ error: "Runs require the local research lab." });
  if (running) return reply.code(429).send({ error: "A research run is active." });
  running = true;
  try { return await runResearchWorkflow(input.data.scenario, model, { seededSnippetAttack: input.data.seededSnippetAttack }); }
  catch { return reply.code(503).send({ error: "Workflow stopped after dependency failure." }); }
  finally { running = false; }
});
await app.listen({ host: "127.0.0.1", port });
console.log(`ActionGate research lab: http://127.0.0.1:${port} (offline fixtures; zero provider/search credits)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
