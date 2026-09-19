import type { AuthorizationRequest, AuthorizationResponse, RiskClass } from "@actiongate/core";
import { ActionBlockedError, ActionGateApiError } from "./errors.js";

export interface ActionGateOptions { apiKey: string; baseUrl: string; fetch?: typeof globalThis.fetch }
export class ActionGate {
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: ActionGateOptions) { this.fetcher = options.fetch ?? globalThis.fetch; }
  async authorize(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/v1/authorize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
      body: JSON.stringify(request)
    });
    const body = await response.json() as any;
    if (!response.ok) throw new ActionGateApiError(response.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "ActionGate request failed");
    return body as AuthorizationResponse;
  }
  wrapTool<Input, Output, Runtime>(definition: {
    name: string;
    operation: string;
    riskClass: RiskClass;
    execute: (input: Input, runtime: Runtime) => Promise<Output>;
    buildRequest: (args: { input: Input; runtime: Runtime }) => Promise<Omit<AuthorizationRequest, "proposedAction"> & { proposedAction?: Partial<AuthorizationRequest["proposedAction"]> }>;
  }) {
    return async (input: Input, runtime: Runtime): Promise<Output> => {
      const base = await definition.buildRequest({ input, runtime });
      const request = {
        ...base,
        proposedAction: { tool: definition.name, operation: definition.operation, arguments: input as Record<string, unknown>, riskClass: definition.riskClass, ...base.proposedAction }
      } as AuthorizationRequest;
      const authorization = await this.authorize(request);
      if (authorization.decision !== "ALLOW") throw new ActionBlockedError(authorization);
      return definition.execute(input, runtime);
    };
  }
}

