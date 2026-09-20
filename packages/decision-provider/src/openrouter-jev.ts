import type { DecisionProvider, DecisionProviderRequest, DecisionProviderResponse, DecisionQuestion } from "@actiongate/core";
import { ProviderError } from "./errors.js";
import { parseProviderResponse } from "./schemas.js";

export interface OpenRouterJevOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  appUrl?: string;
  appTitle?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenRouterJevProvider implements DecisionProvider {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: OpenRouterJevOptions) {
    if (!options.apiKey) throw new ProviderError("JEV_AUTH_ERROR", "OpenRouter API key is required");
    this.model = options.model ?? "typesafe/jev-1.13";
    this.endpoint = options.endpoint ?? "https://openrouter.ai/api/alpha/decisions";
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async evaluate(request: DecisionProviderRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DecisionProviderResponse> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 2000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.appUrl ? { "HTTP-Referer": this.options.appUrl } : {}),
          "X-OpenRouter-Title": this.options.appTitle ?? "ActionGate"
        },
        body: JSON.stringify({ model: this.model, state: request.state, questions: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, toWireQuestion(question)])) }),
        signal
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("JEV_TIMEOUT", "request timed out");
      throw new ProviderError("JEV_PROVIDER_ERROR", error instanceof Error ? error.message : "network error");
    }
    if (!response.ok) {
      const code = response.status === 401 ? "JEV_AUTH_ERROR" : response.status === 402 ? "JEV_PAYMENT_REQUIRED" : response.status === 429 ? "JEV_RATE_LIMITED" : "JEV_PROVIDER_ERROR";
      throw new ProviderError(code, `OpenRouter returned HTTP ${response.status}`, response.status);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new ProviderError("JEV_MALFORMED_RESPONSE", "response was not JSON", response.status); }
    return { ...parseProviderResponse(raw, request), requestedModel: this.model };
  }
}

// OpenRouter's Decisions API currently accepts structured instructions, while
// criteria descriptions use strings. This translation stays provider-local.
function toWireQuestion(question: DecisionQuestion): unknown {
  if (question.type === "choice") return { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, value == null || typeof value === "string" ? value : JSON.stringify(value)])) };
  if (question.type === "score") return { ...question, criteria: question.criteria.map((value) => typeof value === "string" ? value : JSON.stringify(value)) };
  if (!question.criteria) return question;
  return { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, value == null || typeof value === "string" ? value : JSON.stringify(value)])) };
}
