import type { DecisionProvider, DecisionProviderRequest, DecisionProviderResponse } from "@actiongate/core";
import { ProviderError } from "./errors.js";
import { parseJevResponse } from "./schemas.js";

export interface TypeSafeJevOptions {
  apiKey: string;
  /** Pin a version in production; `jev-latest` is useful only for exploration. */
  model?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  /** Retries after the first request for documented transient statuses. */
  maxRetries?: number;
  retryBaseMs?: number;
}

/** Direct adapter for TypeSafe's System One API. It supplies evidence only;
 * ActionGate remains responsible for policy composition and grant issuance. */
export class TypeSafeJevProvider implements DecisionProvider {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly options: TypeSafeJevOptions) {
    if (!options.apiKey) throw new ProviderError("JEV_AUTH_ERROR", "TypeSafe API key is required");
    this.model = options.model ?? "jev-1.13.0";
    this.endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) {
      throw new ProviderError("JEV_CONFIG_ERROR", "TypeSafe maxRetries must be an integer from 0 to 5");
    }
    if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0) {
      throw new ProviderError("JEV_CONFIG_ERROR", "TypeSafe retryBaseMs must be non-negative");
    }
  }

  async evaluate(request: DecisionProviderRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DecisionProviderResponse> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 2000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, state: request.state, questions: request.questions }),
          signal
        });
      } catch (error) {
        if (signal.aborted) throw new ProviderError("JEV_TIMEOUT", "request timed out");
        throw new ProviderError("JEV_PROVIDER_ERROR", error instanceof Error ? error.message : "network error");
      }

      if (response.ok) {
        let raw: unknown;
        try { raw = await response.json(); }
        catch { throw new ProviderError("JEV_MALFORMED_RESPONSE", "response was not JSON", response.status); }
        return { ...parseJevResponse(raw, request, "typesafe"), requestedModel: this.model };
      }

      if ((response.status === 429 || response.status === 529) && attempt < this.maxRetries) {
        await waitBeforeRetry(response.headers.get("retry-after"), this.retryBaseMs * 2 ** attempt, signal);
        continue;
      }

      const code = response.status === 401
        ? "JEV_AUTH_ERROR"
        : response.status === 402
          ? "JEV_PAYMENT_REQUIRED"
          : response.status === 422
            ? "JEV_REQUEST_INVALID"
            : response.status === 429
              ? "JEV_RATE_LIMITED"
              : response.status === 529
                ? "JEV_PROVIDER_OVERLOADED"
                : "JEV_PROVIDER_ERROR";
      throw new ProviderError(code, `TypeSafe returned HTTP ${response.status}`, response.status);
    }
  }
}

async function waitBeforeRetry(retryAfter: string | null, fallbackMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ProviderError("JEV_TIMEOUT", "request timed out");
  const numericSeconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  const dateMs = retryAfter && !Number.isFinite(numericSeconds) ? Date.parse(retryAfter) - Date.now() : Number.NaN;
  const delayMs = Number.isFinite(numericSeconds)
    ? Math.max(0, numericSeconds * 1000)
    : Number.isFinite(dateMs)
      ? Math.max(0, dateMs)
      : fallbackMs;
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("JEV_TIMEOUT", "request timed out"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
