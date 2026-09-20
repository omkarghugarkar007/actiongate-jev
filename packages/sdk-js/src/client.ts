import type { ActionGrantConsumeRequest, ActionGrantConsumeResponse, AuthorizationRequest, AuthorizationResponse, RiskClass } from "@actiongate/core";
import { ActionBlockedError, ActionGateApiError, ActionGrantMissingError } from "./errors.js";
import { EmbeddedTransport, type ActionGateTransport, type EmbeddedOptions } from "./embedded.js";

export interface ActionGateOptions { apiKey: string; baseUrl: string; fetch?: typeof globalThis.fetch }

export class ActionGate {
  private readonly fetcher: typeof globalThis.fetch;
  /** Set when running in-process; when absent, calls go over HTTP. */
  private readonly transport: ActionGateTransport | undefined;

  constructor(options: ActionGateOptions);
  constructor(options: ActionGateOptions | { transport: ActionGateTransport });
  constructor(options: ActionGateOptions | { transport: ActionGateTransport }) {
    if ("transport" in options) {
      this.transport = options.transport;
      this.options = { apiKey: "embedded", baseUrl: "embedded" };
      this.fetcher = globalThis.fetch;
      return;
    }
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private readonly options!: ActionGateOptions;

  /**
   * Runs everything in this process: no server, no API key, no base URL.
   *
   * The guarantees are the same as hosted mode — a grant is issued only for an
   * enforced ALLOW and consumed once before the handler runs — so `wrapTool`
   * code is identical either way and graduating to a server changes only this
   * line. See EmbeddedOptions for what embedding costs you.
   */
  static embedded(options: EmbeddedOptions = {}): ActionGate {
    return new ActionGate({ transport: new EmbeddedTransport(options) });
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    if (this.transport) return this.transport.authorize(request);
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/v1/authorize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
      body: JSON.stringify(request)
    });
    const body = await response.json() as any;
    if (!response.ok) throw new ActionGateApiError(response.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "ActionGate request failed");
    return body as AuthorizationResponse;
  }

  async consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse> {
    if (this.transport) return this.transport.consumeGrant(request);
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/v1/grants/consume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    const body = await response.json() as any;
    if (!response.ok) throw new ActionGateApiError(response.status, body?.error?.code ?? "INTERNAL_ERROR", body?.error?.message ?? "Action Grant consumption failed");
    return body as ActionGrantConsumeResponse;
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
      if (request.mode === "enforce") {
        if (!authorization.grant) throw new ActionGrantMissingError(authorization);
        await this.consumeGrant({
          token: authorization.grant.token,
          tenantId: request.tenantId,
          environment: request.environment,
          actor: {
            agentId: request.actor.agentId,
            ...(request.actor.userId ? { userId: request.actor.userId } : {}),
            ...(request.actor.sessionId ? { sessionId: request.actor.sessionId } : {})
          },
          proposedAction: request.proposedAction
        });
      }
      return definition.execute(input, runtime);
    };
  }
}
