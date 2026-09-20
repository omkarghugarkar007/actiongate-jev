import type { AuthorizationRequest } from "./contracts.js";
import type { ToolPolicy } from "./policy.js";
import { FACT_NAMES, type DeterministicFacts, type FactName, type ResolvedFactSet, type TrustedFactProvider } from "./facts.js";

export interface FunctionFactProviderOptions {
  name: string;
  resolve(input: { request: AuthorizationRequest; tool: ToolPolicy | undefined }): Promise<DeterministicFacts | undefined> | DeterministicFacts | undefined;
}

/** Wraps an in-process function that already has access to trusted state. */
export class FunctionFactProvider implements TrustedFactProvider {
  readonly name: string;
  constructor(private readonly options: FunctionFactProviderOptions) {
    this.name = options.name;
  }
  async resolve(input: { request: AuthorizationRequest; tool: ToolPolicy | undefined }): Promise<ResolvedFactSet | undefined> {
    const facts = await this.options.resolve(input);
    if (!facts) return undefined;
    return { provider: this.name, facts: pickFacts(facts) };
  }
}

export interface HttpFactProviderOptions {
  name?: string;
  /** A service the deployment operates. It must not be reachable by the agent. */
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Only ask about tools this provider actually knows. Omit to ask about all. */
  tools?: readonly string[];
}

/**
 * Asks a deployment-owned HTTP service for the facts behind a proposed action.
 *
 * The request carries only what the service needs to answer: tenant,
 * environment, actor, tool, operation, risk, and the canonical arguments. The
 * service replies with `{ facts, observedAt? }`. Anything it returns that is not
 * a known fact name is dropped, so a compromised or sloppy service cannot inject
 * fields into the authorization request.
 */
export class HttpFactProvider implements TrustedFactProvider {
  readonly name: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: HttpFactProviderOptions) {
    this.name = options.name ?? "http-facts";
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async resolve({ request, tool }: { request: AuthorizationRequest; tool: ToolPolicy | undefined }): Promise<ResolvedFactSet | undefined> {
    if (this.options.tools && !this.options.tools.includes(request.proposedAction.tool)) return undefined;
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 1500);
    const response = await this.fetcher(this.options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...this.options.headers },
      body: JSON.stringify({
        tenantId: request.tenantId,
        environment: request.environment,
        actor: request.actor,
        proposedAction: request.proposedAction,
        riskClass: tool?.riskClass ?? request.proposedAction.riskClass
      }),
      signal
    });
    if (!response.ok) throw new Error(`fact service returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) throw new Error("fact service returned a malformed response");
    const payload = body as { facts?: unknown; observedAt?: unknown };
    if (typeof payload.facts !== "object" || payload.facts === null) throw new Error("fact service returned no facts object");
    return {
      provider: this.name,
      facts: pickFacts(payload.facts as Record<string, unknown>),
      ...(typeof payload.observedAt === "string" ? { observedAt: payload.observedAt } : {})
    };
  }
}

/** Keeps only known fact names with the right primitive type. */
function pickFacts(source: Record<string, unknown>): DeterministicFacts {
  const result: Record<string, unknown> = {};
  for (const name of FACT_NAMES) {
    const value = source[name];
    if (value === undefined || value === null) continue;
    if (!isValidFact(name, value)) continue;
    result[name] = value;
  }
  return result as DeterministicFacts;
}

function isValidFact(name: FactName, value: unknown): boolean {
  if (name === "amountCents") return typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (name === "currency") return typeof value === "string" && value.length === 3;
  return typeof value === "boolean";
}
