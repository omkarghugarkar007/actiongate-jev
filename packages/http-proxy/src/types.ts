export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The header a caller uses to relay user intent. It is evidence, not trusted input. */
export const ACTIONGATE_INTENT_HEADER = "x-actiongate-intent";

export interface ProxyHttpRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ProxyHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface RouteMatch {
  params: Record<string, string>;
  request: ProxyHttpRequest;
}

export interface ProxyRoute {
  method: HttpMethod;
  /** Express-style path with `:name` segments, e.g. `/refunds/:transactionId`. */
  path: string;
  /** The registry tool this route maps to. The registry owns its operation and risk. */
  tool: string;
  /**
   * Canonical arguments to authorize. These are the exact values bound into the
   * grant, so they must be what the upstream call actually uses. Defaults to
   * path params merged with the query string and a JSON object body.
   */
  arguments?: (match: RouteMatch) => Record<string, unknown>;
  /** Upstream path to call. Defaults to the incoming path. */
  upstreamPath?: (match: RouteMatch) => string;
}

export interface HttpUpstream {
  send(input: {
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    body: unknown;
  }): Promise<ProxyHttpResponse>;
}
