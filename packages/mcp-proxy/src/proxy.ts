import { randomUUID } from "node:crypto";
import type { AuthorizationRequest, AuthorizationResponse } from "@actiongate/core";
import {
  ACTIONGATE_INTENT_META_KEY,
  JSON_RPC,
  type ActionGateEnforcementClient,
  type DeterministicFactProvider,
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
  deterministicFacts?: DeterministicFactProvider;
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
    const userIntent = relayedIntent(params);
    const deterministicFacts = this.options.deterministicFacts
      ? await this.options.deterministicFacts({ principal, tool, arguments: rawArguments })
      : undefined;

    const authorizationRequest: AuthorizationRequest = {
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      tenantId: principal.tenantId,
      environment: principal.environment,
      mode: "enforce",
      actor: principal.actor,
      userIntent,
      // Operation and risk come from the registry. A caller cannot propose a
      // safer classification than the one the tenant registered.
      proposedAction: {
        tool: tool.name,
        operation: tool.operation,
        arguments: rawArguments,
        riskClass: tool.riskClass
      },
      ...(deterministicFacts ? { deterministicFacts } : {})
    };

    const decision = await this.options.client.authorize(authorizationRequest);
    if (decision.decision !== "ALLOW") throw deniedError(decision);
    if (!decision.grant) {
      throw new ProxyError(JSON_RPC.ACTION_DENIED, "Enforced allow did not include an Action Grant");
    }

    // Consume before forwarding. If consumption fails for any reason the upstream
    // tool is never called.
    await this.options.client.consumeGrant({
      token: decision.grant.token,
      tenantId: authorizationRequest.tenantId,
      environment: authorizationRequest.environment,
      actor: authorizationRequest.actor,
      proposedAction: authorizationRequest.proposedAction
    });

    let result: unknown;
    try {
      result = await this.options.upstream.callTool(tool.name, rawArguments);
    } catch (error) {
      throw new ProxyError(
        JSON_RPC.UPSTREAM_ERROR,
        error instanceof Error ? error.message : "Upstream MCP server failed",
        { decisionId: decision.decisionId }
      );
    }

    return success(id, {
      ...(isPlainObject(result) ? result : { content: [{ type: "text", text: String(result) }] }),
      // The grant token is deliberately absent. Only non-secret decision identity
      // is returned so an operator can correlate the call with its audit record.
      _meta: { "actiongate/decisionId": decision.decisionId, "actiongate/riskClass": decision.riskClass }
    });
  }

  private async resolveTool(principal: ProxyPrincipal, name: string): Promise<RegistryTool> {
    const normalized = name.trim().toLowerCase();
    const tools = await this.options.registry.listTools(principal);
    const tool = tools.find((candidate) => candidate.name.toLowerCase() === normalized);
    // Unknown and disabled tools give the same answer, so probing the proxy does
    // not reveal which tools a tenant has registered but turned off.
    if (!tool || !tool.enabled) {
      throw new ProxyError(JSON_RPC.METHOD_NOT_FOUND, `Tool ${name} is not available`);
    }
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

function deniedError(decision: AuthorizationResponse) {
  return new ProxyError(JSON_RPC.ACTION_DENIED, `ActionGate returned ${decision.decision}`, {
    decision: decision.decision,
    decisionId: decision.decisionId,
    riskClass: decision.riskClass,
    reasons: decision.reasons.map((reason) => ({ code: reason.code, message: reason.message, source: reason.source }))
  });
}

/**
 * User intent is relayed by the calling agent, so it is evidence rather than
 * trusted input. When nothing is relayed the proxy says so plainly instead of
 * inventing intent; the policy's missing-intent thresholds then decide what that
 * absence is worth for the tool's risk class.
 */
function relayedIntent(params: Record<string, unknown>): AuthorizationRequest["userIntent"] {
  const meta = params._meta;
  const relayed = isPlainObject(meta) ? meta[ACTIONGATE_INTENT_META_KEY] : undefined;
  if (typeof relayed === "string" && relayed.trim().length > 0) {
    return { text: relayed.trim().slice(0, 16_000), source: "user_message" };
  }
  return {
    text: "No user intent was relayed with this MCP tool call.",
    source: "workflow"
  };
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
