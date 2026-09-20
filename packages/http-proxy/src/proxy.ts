import {
  authorizeAndConsume,
  findEnabledTool,
  relayedIntent,
  type ActionGateEnforcementClient,
  type ProxyPrincipal,
  type ProxyPrincipalResolver,
  type ProxyRegistry
} from "@actiongate/proxy-core";
import { RouteTable, defaultArguments } from "./routes.js";
import { UpstreamError } from "./upstream.js";
import {
  ACTIONGATE_INTENT_HEADER,
  type HttpUpstream,
  type ProxyHttpRequest,
  type ProxyHttpResponse,
  type ProxyRoute
} from "./types.js";

export interface ActionGateHttpProxyOptions {
  client: ActionGateEnforcementClient;
  registry: ProxyRegistry;
  upstream: HttpUpstream;
  resolvePrincipal: ProxyPrincipalResolver;
  routes: readonly ProxyRoute[];
}

/**
 * A reverse proxy for applications that cannot embed the SDK. Every mapped route
 * is authorized and its grant consumed before the request reaches the upstream
 * service, and only mapped routes exist at all: an unmapped path is a 404 here,
 * never a pass-through, so nothing reaches upstream without a tool behind it.
 */
export class ActionGateHttpProxy {
  private readonly table: RouteTable;

  constructor(private readonly options: ActionGateHttpProxyOptions) {
    this.table = new RouteTable(options.routes);
  }

  async handle(request: ProxyHttpRequest, token: string | undefined): Promise<ProxyHttpResponse> {
    let principal: ProxyPrincipal | undefined;
    try {
      principal = await this.options.resolvePrincipal(token);
    } catch { principal = undefined; }
    if (!principal) return error(401, "UNAUTHORIZED", "A valid ActionGate proxy token is required");

    const matched = this.table.match(request.method, request.path);
    // Unmapped routes do not exist. The proxy is an allowlist, not a pass-through.
    if (!matched) return error(404, "ROUTE_NOT_MAPPED", "No ActionGate-guarded route matches this request");

    const tool = findEnabledTool(await this.options.registry.listTools(principal), matched.route.tool);
    if (!tool) return error(404, "TOOL_NOT_AVAILABLE", `Tool ${matched.route.tool} is not available`);

    const match = { params: matched.params, request };
    const args = matched.route.arguments ? matched.route.arguments(match) : defaultArguments(match);

    const result = await authorizeAndConsume(this.options.client, {
      principal,
      tool,
      arguments: args,
      userIntent: relayedIntent(header(request, ACTIONGATE_INTENT_HEADER), "No user intent was relayed with this HTTP call.")
    });

    if (!result.ok) {
      if (result.kind === "denied") {
        return error(403, "ACTION_DENIED", `ActionGate returned ${result.decision}`, {
          decision: result.decision,
          decisionId: result.decisionId,
          riskClass: result.riskClass,
          reasons: result.reasons.map((reason) => ({ code: reason.code, message: reason.message, source: reason.source }))
        });
      }
      if (result.kind === "no_grant") return error(403, "GRANT_MISSING", "Enforced allow did not include an Action Grant");
      if (result.kind === "consume_failed") return error(409, "GRANT_NOT_CONSUMED", result.message);
      return error(503, "ACTIONGATE_UNAVAILABLE", "ActionGate could not authorize this request");
    }

    // The permit is spent. Forward the exact arguments that were authorized.
    const upstreamPath = matched.route.upstreamPath ? matched.route.upstreamPath(match) : request.path;
    try {
      const response = await this.options.upstream.send({
        method: request.method.toUpperCase(),
        path: upstreamPath,
        query: request.query,
        body: request.method.toUpperCase() === "GET" ? undefined : args
      });
      return {
        ...response,
        headers: {
          ...response.headers,
          // Correlation only. The grant is never echoed back to the caller.
          "x-actiongate-decision-id": result.decisionId,
          "x-actiongate-risk-class": result.riskClass
        }
      };
    } catch (upstreamError) {
      const message = upstreamError instanceof UpstreamError ? upstreamError.message : "Upstream service failed";
      return error(502, "UPSTREAM_FAILED", message, { decisionId: result.decisionId });
    }
  }
}

function header(request: ProxyHttpRequest, name: string): string | undefined {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function error(status: number, code: string, message: string, data?: Record<string, unknown>): ProxyHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { error: { code, message, ...(data ? { data } : {}) } }
  };
}
