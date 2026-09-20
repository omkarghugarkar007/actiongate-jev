import { randomUUID } from "node:crypto";
import {
  ActionGrantSigner,
  AuthorizationEngine,
  DEFAULT_POLICY,
  type ActionGrantClaims,
  type ActionGrantConsumeRequest,
  type ActionGrantConsumeResponse,
  type AuthorizationRequest,
  type AuthorizationResponse,
  type DecisionProvider,
  type Policy,
  type TrustedFactProvider
} from "@actiongate/core";
import { FakeDecisionProvider, OpenRouterJevProvider, TypeSafeJevProvider } from "@actiongate/decision-provider";

/**
 * Runs the whole decision path inside your process: no server, no API key, no
 * base URL.
 *
 * The semantics are the same as the hosted mode — a grant is issued only for an
 * enforced ALLOW and consumed exactly once before the handler runs — so code
 * written against `wrapTool` works unchanged when you later point it at a
 * server.
 *
 * What embedding costs you, stated plainly:
 *
 *  - **One process.** Grants live in memory. They do not survive a restart and
 *    do not coordinate across replicas, so two processes cannot prevent each
 *    other from consuming the same logical action.
 *  - **One tenant.** There is no tenant isolation because there is nothing to
 *    isolate from.
 *  - **No durable evidence.** Decisions are returned, not stored. There is no
 *    audit trail, review queue, retention, or key rotation.
 *  - **A weaker boundary.** The policy object lives in the same process as the
 *    agent. Code that can edit the policy can raise its own limits. Hosted mode
 *    exists precisely so the registry and policy are somewhere the agent cannot
 *    reach.
 *
 * For a single-process agent guarding its own tools, that is usually the right
 * trade. For anything multi-tenant, audited, or adversarial, run the server.
 */
export interface EmbeddedOptions {
  /** Supply a provider, or let it pick one from the environment. */
  provider?: DecisionProvider;
  /** Enables Jev through OpenRouter. Falls back to `OPENROUTER_API_KEY`. */
  openRouterApiKey?: string;
  /** Enables Jev through the direct TypeSafe API. Falls back to `TYPESAFE_API_KEY` and takes precedence over OpenRouter. */
  typeSafeApiKey?: string;
  model?: string;
  typeSafeModel?: string;
  /** Defaults to the bundled support-agent policy. Yours replaces it entirely. */
  policy?: Policy;
  /** Resolve RBAC, spend, and duplicate facts from trusted local state. */
  factProviders?: readonly TrustedFactProvider[];
  grantTtlSeconds?: number;
  timeoutMs?: number;
  failOpenReadOnly?: boolean;
  clock?: () => number;
}

interface StoredGrant {
  claims: ActionGrantClaims;
  consumedAt?: string;
}

/** The two calls `ActionGate` needs, however they are served. */
export interface ActionGateTransport {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
  consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse>;
}

export class EmbeddedTransport implements ActionGateTransport {
  private readonly engine: AuthorizationEngine;
  private readonly signer: ActionGrantSigner;
  private readonly policy: Policy;
  private readonly clock: () => number;
  private readonly grants = new Map<string, StoredGrant>();
  private readonly byDecision = new Map<string, string>();
  /** Idempotent replay of an identical request, matching the hosted behaviour. */
  private readonly decisions = new Map<string, AuthorizationResponse>();

  readonly usingLiveProvider: boolean;

  constructor(options: EmbeddedOptions = {}) {
    const typeSafeApiKey = options.typeSafeApiKey ?? process.env.TYPESAFE_API_KEY;
    const openRouterApiKey = options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
    const provider = options.provider
      ?? (typeSafeApiKey
        ? new TypeSafeJevProvider({ apiKey: typeSafeApiKey, model: options.typeSafeModel ?? process.env.TYPESAFE_MODEL ?? "jev-1.13.0" })
        : openRouterApiKey
          ? new OpenRouterJevProvider({ apiKey: openRouterApiKey, model: options.model ?? process.env.JEV_MODEL ?? "typesafe/jev-1.13", appTitle: "ActionGate embedded" })
          : FakeDecisionProvider.allow());

    this.usingLiveProvider = Boolean(options.provider) || Boolean(typeSafeApiKey) || Boolean(openRouterApiKey);
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.clock = options.clock ?? Date.now;
    this.engine = new AuthorizationEngine(provider, {
      timeoutMs: options.timeoutMs ?? 10_000,
      failOpenReadOnly: options.failOpenReadOnly ?? false,
      ...(options.factProviders ? { factProviders: options.factProviders } : {})
    });
    // Ephemeral: a grant is only meaningful inside this process, so a
    // process-lifetime secret is exactly the right scope. It also means a grant
    // cannot be replayed against a restarted process.
    this.signer = new ActionGrantSigner({
      keys: [{ id: "embedded", secret: randomUUID() + randomUUID() }],
      activeKeyId: "embedded",
      ttlSeconds: options.grantTtlSeconds ?? 30,
      clock: this.clock
    });
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    const idempotencyKey = `${request.tenantId}:${request.environment}:${request.idempotencyKey}`;
    const existing = this.decisions.get(idempotencyKey);
    if (existing) return existing;

    // The policy is the registry here: a caller cannot propose a softer
    // operation or risk than the policy records for that tool.
    const tool = this.policy.tools[request.proposedAction.tool];
    if (!tool) throw new EmbeddedPolicyError("TOOL_NOT_REGISTERED", `Tool ${request.proposedAction.tool} is not in the policy`);
    if (!tool.enabled) throw new EmbeddedPolicyError("TOOL_DISABLED", `Tool ${request.proposedAction.tool} is disabled`);
    if (tool.operation !== request.proposedAction.operation || tool.riskClass !== request.proposedAction.riskClass) {
      throw new EmbeddedPolicyError("TOOL_METADATA_MISMATCH", `Tool ${request.proposedAction.tool} is ${tool.operation}/${tool.riskClass}`);
    }

    const response = await this.engine.authorize(request, this.policy);
    const withGrant = this.attachGrant(request, response);
    this.decisions.set(idempotencyKey, withGrant);
    return withGrant;
  }

  async consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse> {
    // Verification checks the signature and every bound field, so a mutated
    // action fails here exactly as it would against the server.
    const claims = this.signer.verify(request.token, request);
    const stored = this.grants.get(claims.grantId);
    if (!stored) throw new EmbeddedPolicyError("GRANT_NOT_FOUND", "This grant is not known to this process");
    if (stored.consumedAt) throw new EmbeddedPolicyError("GRANT_ALREADY_CONSUMED", "This grant has already been consumed");
    const consumedAt = new Date(this.clock()).toISOString();
    stored.consumedAt = consumedAt;
    return { grantId: claims.grantId, decisionId: claims.decisionId, status: "CONSUMED", consumedAt };
  }

  /** Grants issued but not yet consumed. Useful in tests and shutdown checks. */
  outstandingGrants(): number {
    return [...this.grants.values()].filter((grant) => !grant.consumedAt).length;
  }

  private attachGrant(request: AuthorizationRequest, response: AuthorizationResponse): AuthorizationResponse {
    if (response.decision !== "ALLOW" || response.mode !== "enforce") return response;
    const existingId = this.byDecision.get(response.decisionId);
    if (existingId) {
      const existing = this.grants.get(existingId)!;
      return { ...response, grant: this.signer.toPublicGrant(existing.claims) };
    }
    const issued = this.signer.issue(request, response);
    this.grants.set(issued.claims.grantId, { claims: issued.claims });
    this.byDecision.set(response.decisionId, issued.claims.grantId);
    return { ...response, grant: issued.grant };
  }
}

export class EmbeddedPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EmbeddedPolicyError";
  }
}
