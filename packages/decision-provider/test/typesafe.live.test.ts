import "dotenv/config";
import { describe, expect, it } from "vitest";
import { TypeSafeJevProvider } from "../src/index.js";

const enabled = process.env.RUN_LIVE_TYPESAFE_TESTS === "true";

describe.skipIf(!enabled)("direct TypeSafe Jev @live", () => {
  it("answers multiple typed questions through the System One endpoint", async () => {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("TYPESAFE_API_KEY is required");
    const response = await new TypeSafeJevProvider({
      apiKey: key,
      model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0"
    }).evaluate({
      state: { message: "Please refund the duplicate charge." },
      questions: {
        wants_refund: { type: "noul", instructions: "Does the user explicitly request a refund?" },
        intent: { type: "choice", instructions: "What is the requested outcome?", criteria: { refund: "Refund a charge", explain: "Explain a charge", other: null } }
      }
    }, { timeoutMs: 10_000 });
    expect(response.provider).toBe("typesafe");
    expect(response.model).toMatch(/^jev-/);
    expect(response.answers.wants_refund?.type).toBe("noul");
    expect(response.answers.intent?.type).toBe("choice");
  });
});
