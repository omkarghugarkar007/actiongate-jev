import type {
  ActionGrantConsumeRequest,
  ActionGrantConsumeResponse,
  AuthorizationRequest,
  AuthorizationResponse,
  RiskClass
} from "@actiongate/core";

/**
 * Reserved `_meta` keys. The proxy reads these from the downstream request and
 * strips the whole `_meta` object before forwarding, so a model can never smuggle
 * a grant, a tenant, or an actor past the boundary.
 */
export const ACTIONGATE_INTENT_META_KEY = "actiongate/intent";

export interface ActionGateEnforcementClient {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
  consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse>;
}

/** Server-owned tool metadata, read from the ActionGate registry. */
export interface RegistryTool {
  name: string;
  operation: string;
  riskClass: RiskClass;
  enabled: boolean;
  description?: string;
  argumentSchema?: Record<string, unknown>;
}

export interface ProxyRegistry {
  /** Tools the authenticated tenant owns. Called per request; implementations may cache. */
  listTools(principal: ProxyPrincipal): Promise<RegistryTool[]>;
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * The upstream MCP server. The implementation owns the upstream credential; it is
 * never given to the downstream caller, which is what makes this an Isolate boundary.
 */
export interface McpUpstream {
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Identity derived from the downstream access token, never from the request body. */
export interface ProxyPrincipal {
  tenantId: string;
  environment: AuthorizationRequest["environment"];
  actor: AuthorizationRequest["actor"];
}

export interface ProxyPrincipalResolver {
  (token: string | undefined): Promise<ProxyPrincipal | undefined>;
}

/**
 * Deterministic facts come from trusted server-side services, never from the
 * caller. Without a provider the proxy asserts nothing, so any tool carrying hard
 * rules fails closed.
 */
export interface DeterministicFactProvider {
  (input: {
    principal: ProxyPrincipal;
    tool: RegistryTool;
    arguments: Record<string, unknown>;
  }): Promise<AuthorizationRequest["deterministicFacts"]>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC reserved range plus ActionGate-specific codes. */
export const JSON_RPC = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  ACTION_DENIED: -32002,
  UPSTREAM_ERROR: -32003
} as const;
