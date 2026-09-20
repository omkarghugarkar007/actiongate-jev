import { authorizeAndConsume, findEnabledTool, relayedIntent } from "@actiongate/proxy-core";
import {
  ACTIONGATE_INTENT_META_KEY,
  JSON_RPC,
  type ActionGateEnforcementClient,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpUpstream,
  type ProxyPrincipal,
  type ProxyPrincipalResolver,
  type ProxyRegistry,
  type RegistryTool
} from "./types.js";

/**
 * Methods the proxy is willing to handle. Anything else is rejected rather than
 * forwarded: an unrecognized method could reach a side effect or read a resource
 * that never passed through authorization.
 */
const HANDLED_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);

export interface ActionGateMcpProxyOptions {
  client: ActionGateEnforcementClient;
  registry: ProxyRegistry;
  upstream: McpUpstream;
  resolvePrincipal: ProxyPrincipalResolver;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
}

export class ActionGateMcpProxy {
  constructor(private readonly options: ActionGateMcpProxyOptions) {}

  async handle(request: unknown, token: string | undefined): Promise<JsonRpcResponse> {
    const id = extractId(request);
    if (!isJsonRpcRequest(request)) {
      return failure(id, JSON_RPC.INVALID_REQUEST, "Expected a JSON-RPC 2.0 request object");
    }
    if (!HANDLED_METHODS.has(request.method)) {
      // Fail closed. Unhandled methods are never passed through to the upstream server.
      return failure(id, JSON_RPC.METHOD_NOT_FOUND, `Method ${request.method} is not available through ActionGate`);
    }

    let principal: ProxyPrincipal | undefined;
    try {
      principal = await this.options.resolvePrincipal(token);
    } catch {
      principal = undefined;
    }
    if (!principal) return failure(id, JSON_RPC.UNAUTHORIZED, "A valid ActionGate proxy token is required");

    try {
      switch (request.method) {
        case "initialize":
          return success(id, this.initializeResult());
        case "ping":
          return success(id, {});
        case "tools/list":
          return success(id, { tools: await this.listTools(principal) });
        case "tools/call":
          return await this.callTool(id, request, principal);
        default:
          return failure(id, JSON_RPC.METHOD_NOT_FOUND, `Method ${request.method} is not available through ActionGate`);
      }
    } catch (error) {
      if (error instanceof ProxyError) return failure(id, error.code, error.message, error.data);
      return failure(id, JSON_RPC.INTERNAL_ERROR, "ActionGate proxy failed to complete the request");
    }
  }

  private initializeResult() {
    return {
      protocolVersion: this.options.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.options.serverName ?? "actiongate-mcp-proxy",
        version: this.options.serverVersion ?? "0.1.0"
      }
    };
  }

  /**
   * Only tools that exist upstream *and* are enabled in the tenant registry are
   * advertised. A tool the registry does not know cannot be described, so a model
   * never learns it exists. Metadata comes from the registry, not from upstream,
   * so the schema shown is the schema ActionGate validates against.
   */
  private async listTools(principal: ProxyPrincipal) {
    const [upstreamTools, registryTools] = await Promise.all([
      this.options.upstream.listTools(),
      this.options.registry.listTools(principal)
    ]);
    const upstreamByName = new Map(upstreamTools.map((tool) => [tool.name, tool]));
    return registryTools
      .filter((tool) => tool.enabled && upstreamByName.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? upstreamByName.get(tool.name)?.description ?? `${tool.operation} (${tool.riskClass})`,
        inputSchema: tool.argumentSchema ?? { type: "object" }
      }));
  }

  private async callTool(id: string | number | null, request: JsonRpcRequest, principal: ProxyPrincipal): Promise<JsonRpcResponse> {
    const params = request.params ?? {};
    const name = params.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return failure(id, JSON_RPC.INVALID_PARAMS, "params.name must be a non-empty string");
    }
    const rawArguments = params.arguments ?? {};
    if (!isPlainObject(rawArguments)) {
      return failure(id, JSON_RPC.INVALID_PARAMS, "params.arguments must be an object");
    }

    const tool = await this.resolveTool(principal, name);
    const meta = isPlainObject(params._meta) ? params._meta : undefined;
    const result = await authorizeAndConsume(this.options.client, {
      principal,
      tool,
      arguments: rawArguments,
      userIntent: relayedIntent(meta?.[ACTIONGATE_INTENT_META_KEY], "No user intent was relayed with this MCP tool call.")
    });

    if (!result.ok) throw enforcementError(result);

    // Consumption succeeded, so the permit is spent before the upstream call.
    let upstreamResult: unknown;
    try {
      upstreamResult = await this.options.upstream.callTool(tool.name, rawArguments);
    } catch (error) {
      throw new ProxyError(
        JSON_RPC.UPSTREAM_ERROR,
        error instanceof Error ? error.message : "Upstream MCP server failed",
        { decisionId: result.decisionId }
      );
    }

    return success(id, {
      ...(isPlainObject(upstreamResult) ? upstreamResult : { content: [{ type: "text", text: String(upstreamResult) }] }),
      // The grant token is deliberately absent. Only non-secret decision identity
      // is returned so an operator can correlate the call with its audit record.
      _meta: { "actiongate/decisionId": result.decisionId, "actiongate/riskClass": result.riskClass }
    });
  }

  private async resolveTool(principal: ProxyPrincipal, name: string): Promise<RegistryTool> {
    const tool = findEnabledTool(await this.options.registry.listTools(principal), name);
    // Unknown and disabled tools give the same answer, so probing the proxy does
    // not reveal which tools a tenant has registered but turned off.
    if (!tool) throw new ProxyError(JSON_RPC.METHOD_NOT_FOUND, `Tool ${name} is not available`);
    return tool;
  }
}

export class ProxyError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

function enforcementError(result: Extract<Awaited<ReturnType<typeof authorizeAndConsume>>, { ok: false }>): ProxyError {
  if (result.kind === "denied") {
    return new ProxyError(JSON_RPC.ACTION_DENIED, `ActionGate returned ${result.decision}`, {
      decision: result.decision,
      decisionId: result.decisionId,
      riskClass: result.riskClass,
      reasons: result.reasons.map((reason) => ({ code: reason.code, message: reason.message, source: reason.source }))
    });
  }
  if (result.kind === "no_grant") {
    return new ProxyError(JSON_RPC.ACTION_DENIED, "Enforced allow did not include an Action Grant", { decisionId: result.decisionId });
  }
  if (result.kind === "consume_failed") {
    return new ProxyError(JSON_RPC.ACTION_DENIED, `Action Grant could not be consumed: ${result.message}`);
  }
  return new ProxyError(JSON_RPC.INTERNAL_ERROR, "ActionGate proxy failed to complete the request");
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isPlainObject(value)) return false;
  if (value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string" || value.method.length === 0) return false;
  return value.params === undefined || isPlainObject(value.params);
}

function extractId(value: unknown): string | number | null {
  if (!isPlainObject(value)) return null;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: string | number | null, code: number, message: string, data?: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}
