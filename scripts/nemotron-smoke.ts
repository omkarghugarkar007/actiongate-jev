import "dotenv/config";
import { buildSemanticBattery } from "@actiongate/core";
import { NemotronDecisionProvider, type NemotronBackend } from "@actiongate/decision-provider";

const backend: NemotronBackend = process.argv.includes("--nebius") ? "nebius" : "nvidia";
const apiKey = backend === "nvidia" ? process.env.NVIDIA_API_KEY : process.env.NEBIUS_API_KEY;
if (!apiKey) throw new Error(`${backend === "nvidia" ? "NVIDIA_API_KEY" : "NEBIUS_API_KEY"} is required`);
const model = backend === "nvidia" ? process.env.NVIDIA_MODEL : process.env.NEBIUS_MODEL;
const provider = new NemotronDecisionProvider({ apiKey, backend, ...(model ? { model } : {}) });
const started = performance.now();
const result = await provider.evaluate({
  questions: buildSemanticBattery(),
  state: {
    user_intent: { text: "Show me order 123.", source: "user_message" },
    proposed_action: { tool: "get_order", operation: "read", arguments: { orderId: "123" } },
    relevant_resource: { order: { id: "123" } },
    semantic_policy: { statements: ["Read only the order the user requested."] }
  }
}, { timeoutMs: 30_000 });
console.log(JSON.stringify({ provider: result.provider, requestedModel: result.requestedModel, resolvedModel: result.model, latencyMs: Math.round(performance.now() - started), usage: result.usage, scoreKind: result.metadata?.scoreKind, answers: result.answers }, null, 2));
