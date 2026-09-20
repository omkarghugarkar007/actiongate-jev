import type { McpUpstream, UpstreamTool } from "./types.js";

export interface HttpMcpUpstreamOptions {
  url: string;
  /**
   * The upstream credential. It stays inside the proxy process: it is never
   * returned to the downstream caller and never appears in a JSON-RPC result.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  protocolVersion?: string;
}

/** Speaks JSON-RPC over HTTP to an upstream MCP server. */
export class HttpMcpUpstream implements McpUpstream {
  private readonly fetcher: typeof globalThis.fetch;
  private nextId = 1;

  constructor(private readonly options: HttpMcpUpstreamOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async listTools(): Promise<UpstreamTool[]> {
    const result = await this.send("tools/list", {});
    const tools = isPlainObject(result) ? result.tools : undefined;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (!isPlainObject(tool) || typeof tool.name !== "string") return [];
      return [{
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(isPlainObject(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {})
      }];
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // `_meta` is deliberately not forwarded. Reserved ActionGate keys stay on
    // this side of the boundary, and the upstream server sees only the exact
    // arguments that were authorized.
    return this.send("tools/call", { name, arguments: args });
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.fetcher(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "MCP-Protocol-Version": this.options.protocolVersion ?? "2025-06-18",
          ...this.options.headers
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal
      });
    } catch (error) {
      if (signal.aborted) throw new UpstreamError("Upstream MCP server timed out");
      throw new UpstreamError(error instanceof Error ? error.message : "Upstream MCP server is unreachable");
    }
    if (!response.ok) throw new UpstreamError(`Upstream MCP server returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UpstreamError("Upstream MCP server returned a non-JSON response");
    }
    if (!isPlainObject(body)) throw new UpstreamError("Upstream MCP server returned a malformed response");
    if (isPlainObject(body.error)) {
      const message = typeof body.error.message === "string" ? body.error.message : "Upstream MCP server returned an error";
      throw new UpstreamError(message);
    }
    return body.result;
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
