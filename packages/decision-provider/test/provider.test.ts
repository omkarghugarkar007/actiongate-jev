import { describe, expect, it } from "vitest";
import { buildSemanticBattery } from "@actiongate/core";
import { OpenRouterJevProvider, parseProviderResponse } from "../src/index.js";

const request = { state: { text: "hello" }, questions: buildSemanticBattery() };
const valid = {
  model: "typesafe/jev-1.13", provider: "TypeSafe",
  answers: {
    alignment: { type: "choice", choice: "exact", probabilities: { exact: .9, narrower: .02, ambiguous: .03, unrelated: .03, conflicting: .02 }, confidence: .9 },
    target_matches_intent: { type: "noul", noul: .9 }, violates_semantic_policy: { type: "noul", noul: .1 },
    unnecessary_sensitive_exposure: { type: "noul", noul: .1 }, materially_expands_scope: { type: "noul", noul: .1 }, missing_required_intent: { type: "noul", noul: .1 }
  }, usage: { input_tokens: 10, output_tokens: 1 }
};

describe("provider contract", () => {
  it("parses a valid fixture", () => expect(parseProviderResponse(valid, request).usage?.inputTokens).toBe(10));
  it("accepts optional usage and records the resolved model", () => {
    const parsed = parseProviderResponse({ model: "typesafe/jev-1.13-20260917", answers: valid.answers }, request);
    expect(parsed.usage).toBeUndefined();
    expect(parsed.model).toBe("typesafe/jev-1.13-20260917");
  });
  it("rejects missing answers", () => expect(() => parseProviderResponse({ ...valid, answers: {} }, request)).toThrow("JEV_MISSING_ANSWER"));
  it("rejects invalid probability", () => expect(() => parseProviderResponse({ ...valid, answers: { ...valid.answers, target_matches_intent: { type: "noul", noul: 2 } } }, request)).toThrow("JEV_MALFORMED_RESPONSE"));
  it("rejects an unknown answer type", () => expect(() => parseProviderResponse({ ...valid, answers: { ...valid.answers, target_matches_intent: { type: "text", value: "yes" } } }, request)).toThrow("JEV_MALFORMED_RESPONSE"));
  it("rejects non-numeric confidence", () => expect(() => parseProviderResponse({ ...valid, answers: { ...valid.answers, alignment: { ...valid.answers.alignment, confidence: "high" } } }, request)).toThrow("JEV_MALFORMED_RESPONSE"));
  it("rejects choice distributions with missing options", () => expect(() => parseProviderResponse({ ...valid, answers: { ...valid.answers, alignment: { ...valid.answers.alignment, probabilities: { exact: 1 } } } }, request)).toThrow("probability options mismatch"));
  it.each([[401, "JEV_AUTH_ERROR"], [402, "JEV_PAYMENT_REQUIRED"], [429, "JEV_RATE_LIMITED"], [500, "JEV_PROVIDER_ERROR"], [503, "JEV_PROVIDER_ERROR"]])("maps HTTP %i to %s without leaking bodies", async (status, code) => {
    const provider = new OpenRouterJevProvider({ apiKey: "test", fetch: async () => new Response("secret upstream body", { status }) });
    await expect(provider.evaluate(request)).rejects.toThrow(code);
  });
  it("maps aborts to typed timeouts", async () => {
    const provider = new OpenRouterJevProvider({ apiKey: "test", fetch: async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
    await expect(provider.evaluate(request, { timeoutMs: 5 })).rejects.toThrow("JEV_TIMEOUT");
  });
  it("normalizes object criteria only inside the provider wire payload", async () => {
    let body: any;
    const provider = new OpenRouterJevProvider({ apiKey: "test", fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(valid), { status: 200, headers: { "Content-Type": "application/json" } });
    } });
    await provider.evaluate(request);
    expect(typeof body.questions.alignment.criteria.exact).toBe("string");
    expect(request.questions.alignment && typeof request.questions.alignment === "object" && request.questions.alignment.type).toBe("choice");
  });
});
