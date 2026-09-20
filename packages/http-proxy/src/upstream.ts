import type { HttpUpstream, ProxyHttpResponse } from "./types.js";

export interface HttpUpstreamOptions {
  baseUrl: string;
  /**
   * The downstream credential. It stays in the proxy process: the caller never
   * receives it, which is what makes this an Isolate boundary.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class FetchHttpUpstream implements HttpUpstream {
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: HttpUpstreamOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async send(input: { method: string; path: string; query: Record<string, string | string[]>; body: unknown }): Promise<ProxyHttpResponse> {
    const url = new URL(input.path.replace(/^\//, ""), `${this.options.baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries(input.query)) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
    }
    const hasBody = input.body !== undefined && input.method !== "GET";
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...this.options.headers
        },
        ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
        signal
      });
    } catch (error) {
      if (signal.aborted) throw new UpstreamError("Upstream service timed out");
      throw new UpstreamError(error instanceof Error ? error.message : "Upstream service is unreachable");
    }
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
    return {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      body: parsed
    };
  }
}

export class UpstreamError extends Error {
  constructor(message: string) { super(message); this.name = "UpstreamError"; }
}
