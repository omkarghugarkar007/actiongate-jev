import type {
  ActionGrantConsumeRequest,
  ActionGrantConsumeResponse,
  AuthorizationRequest,
  AuthorizationResponse,
  RiskClass
} from "@actiongate/core";

export const ACTIONGATE_GRANT_META_KEY = "actiongate/grant";

export interface ActionGateEnforcementClient {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
  consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse>;
}

export interface McpToolCallRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

export interface McpAuthorizationContext {
  tenantId: string;
  environment: AuthorizationRequest["environment"];
  actor: AuthorizationRequest["actor"];
}

export type AuthorizationReceipt = Omit<AuthorizationResponse, "grant">;

export interface GuardedMcpTool<Input extends Record<string, unknown>, Result, Runtime> {
  name: string;
  description?: string;
  operation?: string;
  riskClass: RiskClass;
  parseArguments?: (value: Record<string, unknown>) => Input;
  execute: (input: Input, runtime: Runtime) => Promise<Result>;
}

type RegisteredTool<Runtime> = GuardedMcpTool<Record<string, unknown>, unknown, Runtime>;

export class ActionGateMcpGateway<Runtime> {
  private readonly tools = new Map<string, RegisteredTool<Runtime>>();

  constructor(private readonly client: ActionGateEnforcementClient) {}

  register<Input extends Record<string, unknown>, Result>(tool: GuardedMcpTool<Input, Result, Runtime>) {
    const name = normalizeName(tool.name);
    if (this.tools.has(name)) throw new McpGatewayError("TOOL_ALREADY_REGISTERED", `Tool ${name} is already registered`);
    this.tools.set(name, { ...tool, name } as RegisteredTool<Runtime>);
    return this;
  }

  listTools() {
    return [...this.tools.values()].map(({ name, description, operation = "call", riskClass }) => ({
      name,
      ...(description ? { description } : {}),
      operation,
      riskClass
    }));
  }

  proposedAction(name: string, rawArguments: Record<string, unknown> = {}) {
    const { tool, input } = this.resolve(name, rawArguments);
    return {
      tool: tool.name,
      operation: tool.operation ?? "call",
      arguments: input,
      riskClass: tool.riskClass
    } satisfies AuthorizationRequest["proposedAction"];
  }

  async authorizeAndCall(
    request: McpToolCallRequest,
    authorization: Omit<AuthorizationRequest, "proposedAction">,
    runtime: Runtime
  ): Promise<{ authorization: AuthorizationReceipt; result: unknown }> {
    if (authorization.mode !== "enforce") throw new McpGatewayError("ENFORCEMENT_REQUIRED", "Gateway execution requires enforce mode");
    const { tool, input } = this.resolveRequest(request);
    const authorizationRequest: AuthorizationRequest = {
      ...authorization,
      proposedAction: {
        tool: tool.name,
        operation: tool.operation ?? "call",
        arguments: input,
        riskClass: tool.riskClass
      }
    };
    const decision = await this.client.authorize(authorizationRequest);
    if (decision.decision !== "ALLOW") throw new McpAuthorizationDeniedError(decision);
    if (!decision.grant) throw new McpGatewayError("GRANT_MISSING", "Enforced allow did not include an Action Grant");
    await this.consume(decision.grant.token, authorizationRequest);
    const receipt = structuredClone(decision);
    delete receipt.grant;
    return { authorization: receipt, result: await tool.execute(input, runtime) };
  }

  async callWithGrant(request: McpToolCallRequest, context: McpAuthorizationContext, runtime: Runtime): Promise<unknown> {
    const { tool, input } = this.resolveRequest(request);
    const token = request.params._meta?.[ACTIONGATE_GRANT_META_KEY];
    if (typeof token !== "string" || token.length === 0) throw new McpGatewayError("GRANT_MISSING", `MCP _meta.${ACTIONGATE_GRANT_META_KEY} is required`);
    await this.client.consumeGrant({
      token,
      tenantId: context.tenantId,
      environment: context.environment,
      actor: context.actor,
      proposedAction: {
        tool: tool.name,
        operation: tool.operation ?? "call",
        arguments: input,
        riskClass: tool.riskClass
      }
    });
    return tool.execute(input, runtime);
  }

  private async consume(token: string, request: AuthorizationRequest) {
    return this.client.consumeGrant({
      token,
      tenantId: request.tenantId,
      environment: request.environment,
      actor: request.actor,
      proposedAction: request.proposedAction
    });
  }

  private resolveRequest(request: McpToolCallRequest) {
    if (request.jsonrpc !== "2.0" || request.method !== "tools/call") throw new McpGatewayError("INVALID_MCP_REQUEST", "Expected a JSON-RPC tools/call request");
    return this.resolve(request.params.name, request.params.arguments ?? {});
  }

  private resolve(name: string, rawArguments: Record<string, unknown>) {
    if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) throw new McpGatewayError("INVALID_ARGUMENTS", "Tool arguments must be an object");
    const tool = this.tools.get(normalizeName(name));
    if (!tool) throw new McpGatewayError("TOOL_NOT_REGISTERED", `Tool ${name} is not registered`);
    try {
      const input = tool.parseArguments ? tool.parseArguments(rawArguments) : rawArguments;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must resolve to an object");
      assertJsonSafe(input, "arguments", new Set());
      return { tool, input };
    } catch (error) {
      throw new McpGatewayError("INVALID_ARGUMENTS", error instanceof Error ? error.message : "Tool arguments are invalid");
    }
  }
}

export type McpGatewayErrorCode =
  | "TOOL_ALREADY_REGISTERED"
  | "TOOL_NOT_REGISTERED"
  | "INVALID_MCP_REQUEST"
  | "INVALID_ARGUMENTS"
  | "ENFORCEMENT_REQUIRED"
  | "GRANT_MISSING";

export class McpGatewayError extends Error {
  constructor(public readonly code: McpGatewayErrorCode, message: string) {
    super(message);
    this.name = "McpGatewayError";
  }
}

export class McpAuthorizationDeniedError extends Error {
  constructor(public readonly authorization: AuthorizationResponse) {
    super(`ActionGate returned ${authorization.decision}`);
    this.name = "McpAuthorizationDeniedError";
  }
}

function normalizeName(name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized.length > 128) throw new McpGatewayError("TOOL_NOT_REGISTERED", "Tool name is invalid");
  return normalized;
}

function assertJsonSafe(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`${path} contains a non-plain object`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`, seen));
  else Object.entries(value).forEach(([key, item]) => assertJsonSafe(item, `${path}.${key}`, seen));
  seen.delete(value);
}
