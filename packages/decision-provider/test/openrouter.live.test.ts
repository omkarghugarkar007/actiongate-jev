import "dotenv/config";
import { describe, expect, it } from "vitest";
import { OpenRouterJevProvider } from "../src/index.js";

const enabled = process.env.RUN_LIVE_JEV_TESTS === "true";
describe.skipIf(!enabled)("OpenRouter Jev @live", () => {
  it("answers multiple typed questions", async () => {
    const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is required");
    const response = await new OpenRouterJevProvider({ apiKey: key, model: "typesafe/jev-1.13" }).evaluate({
      state: { message: "Please refund the duplicate charge." },
      questions: {
        wants_refund: { type: "noul", instructions: "Does the user explicitly request a refund?" },
        intent: { type: "choice", instructions: "What is the requested outcome?", criteria: { refund: "Refund a charge", explain: "Explain a charge", other: null } }
      }
    }, { timeoutMs: 10_000 });
    expect(response.answers.wants_refund?.type).toBe("noul");
    expect(response.answers.intent?.type).toBe("choice");
  });
});
