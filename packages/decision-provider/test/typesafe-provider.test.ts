import { describe, expect, it } from "vitest";
import { buildSemanticBattery } from "@actiongate/core";
import { ProviderError, TypeSafeJevProvider } from "../src/index.js";

const request = { state: { text: "hello" }, questions: buildSemanticBattery() };
const valid = {
  model: "jev-1.13.0",
  answers: {
    alignment: { type: "choice", choice: "exact", probabilities: { exact: .9, narrower: .02, ambiguous: .03, unrelated: .03, conflicting: .02 }, confidence: .9 },
    target_matches_intent: { type: "noul", noul: .9 },
    violates_semantic_policy: { type: "noul", noul: .1 },
    unnecessary_sensitive_exposure: { type: "noul", noul: .1 },
    materially_expands_scope: { type: "noul", noul: .1 },
    missing_required_intent: { type: "noul", noul: .1 }
  },
  usage: { input_tokens: 10, output_tokens: 1 }
};

describe("direct TypeSafe provider", () => {
  it("sends the documented System One request and normalizes its response", async () => {
    let url = "";
    let headers: Headers | undefined;
    let body: Record<string, any> = {};
    const provider = new TypeSafeJevProvider({
      apiKey: "ts_test_secret",
      fetch: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(valid), { status: 200 });
      }
    });

    const response = await provider.evaluate(request);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(headers?.get("authorization")).toBe("Bearer ts_test_secret");
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toEqual(request.state);
    // Unlike the OpenRouter adapter, the direct API accepts structured criteria.
    expect(body.questions.alignment.criteria.exact).toEqual(request.questions.alignment?.type === "choice"
      ? request.questions.alignment.criteria.exact
      : undefined);
    expect(response).toMatchObject({ provider: "typesafe", requestedModel: "jev-1.13.0", model: "jev-1.13.0", usage: { inputTokens: 10, outputTokens: 1 } });
    expect(response.usage?.costUsd).toBeUndefined();
  });

  it("retries documented transient statuses and honors retry-after", async () => {
    let calls = 0;
    const provider = new TypeSafeJevProvider({
      apiKey: "test",
      retryBaseMs: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("overloaded", { status: 529, headers: { "retry-after": "0" } });
        return new Response(JSON.stringify(valid), { status: 200 });
      }
    });
    await expect(provider.evaluate(request)).resolves.toMatchObject({ provider: "typesafe" });
    expect(calls).toBe(2);
  });

  it.each([
    [401, "JEV_AUTH_ERROR"],
    [402, "JEV_PAYMENT_REQUIRED"],
    [422, "JEV_REQUEST_INVALID"],
    [429, "JEV_RATE_LIMITED"],
    [529, "JEV_PROVIDER_OVERLOADED"],
    [500, "JEV_PROVIDER_ERROR"]
  ])("maps HTTP %i to %s without exposing the response body", async (status, code) => {
    const provider = new TypeSafeJevProvider({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => new Response("upstream secret", { status })
    });
    const error = await provider.evaluate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain("upstream secret");
  });

  it("requires a key and rejects malformed responses", async () => {
    expect(() => new TypeSafeJevProvider({ apiKey: "" })).toThrow(ProviderError);
    expect(() => new TypeSafeJevProvider({ apiKey: "test", maxRetries: 6 })).toThrowError(/JEV_CONFIG_ERROR/);
    const provider = new TypeSafeJevProvider({ apiKey: "test", fetch: async () => new Response("not-json", { status: 200 }) });
    await expect(provider.evaluate(request)).rejects.toMatchObject({ code: "JEV_MALFORMED_RESPONSE" });
  });
});
