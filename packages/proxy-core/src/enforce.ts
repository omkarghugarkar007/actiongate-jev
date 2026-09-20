import { randomUUID } from "node:crypto";
import type { AuthorizationRequest, AuthorizationResponse, Reason } from "@actiongate/core";
import type { ActionGateEnforcementClient, ProxyPrincipal, RegistryTool } from "./types.js";

export interface EnforceInput {
  principal: ProxyPrincipal;
  tool: RegistryTool;
  arguments: Record<string, unknown>;
  userIntent: AuthorizationRequest["userIntent"];
  requestId?: string;
  idempotencyKey?: string;
}

export type EnforcementResult =
  | { ok: true; decisionId: string; riskClass: AuthorizationResponse["riskClass"]; response: AuthorizationResponse }
  | { ok: false; kind: "denied"; decision: "REVIEW" | "BLOCK"; decisionId: string; riskClass: AuthorizationResponse["riskClass"]; reasons: Reason[] }
  | { ok: false; kind: "no_grant"; decisionId: string }
  | { ok: false; kind: "consume_failed"; message: string }
  | { ok: false; kind: "unavailable"; message: string };

/**
 * The one enforcement path every proxy shares: authorize with registry-owned
 * metadata, then consume the grant. It returns only after consumption succeeds,
 * so a caller that acts on `ok: true` is acting on a spent permit.
 *
 * Deterministic facts are deliberately absent. A proxy is a client from the
 * API's perspective, so anything it asserted would be caller provenance; facts
 * belong to a server-side provider on the API.
 */
export async function authorizeAndConsume(
  client: ActionGateEnforcementClient,
  input: EnforceInput
): Promise<EnforcementResult> {
  const request: AuthorizationRequest = {
    requestId: input.requestId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    tenantId: input.principal.tenantId,
    environment: input.principal.environment,
    mode: "enforce",
    actor: input.principal.actor,
    userIntent: input.userIntent,
    // Operation and risk come from the registry. A caller cannot propose a
    // safer classification than the one the tenant registered.
    proposedAction: {
      tool: input.tool.name,
      operation: input.tool.operation,
      arguments: input.arguments,
      riskClass: input.tool.riskClass
    }
  };

  let decision: AuthorizationResponse;
  try {
    decision = await client.authorize(request);
  } catch (error) {
    return { ok: false, kind: "unavailable", message: error instanceof Error ? error.message : "ActionGate is unreachable" };
  }

  if (decision.decision !== "ALLOW") {
    return {
      ok: false,
      kind: "denied",
      decision: decision.decision,
      decisionId: decision.decisionId,
      riskClass: decision.riskClass,
      reasons: decision.reasons
    };
  }
  if (!decision.grant) return { ok: false, kind: "no_grant", decisionId: decision.decisionId };

  try {
    await client.consumeGrant({
      token: decision.grant.token,
      tenantId: request.tenantId,
      environment: request.environment,
      actor: request.actor,
      proposedAction: request.proposedAction
    });
  } catch (error) {
    return { ok: false, kind: "consume_failed", message: error instanceof Error ? error.message : "grant consumption failed" };
  }

  return { ok: true, decisionId: decision.decisionId, riskClass: decision.riskClass, response: decision };
}

/**
 * User intent relayed by a caller is evidence, not trusted input. When nothing is
 * relayed the proxy says so plainly instead of inventing intent; the policy's
 * missing-intent thresholds then decide what the absence is worth for the risk.
 */
export function relayedIntent(text: unknown, absenceNote: string): AuthorizationRequest["userIntent"] {
  if (typeof text === "string" && text.trim().length > 0) {
    return { text: text.trim().slice(0, 16_000), source: "user_message" };
  }
  return { text: absenceNote, source: "workflow" };
}

/** Finds an enabled registry tool by name. Unknown and disabled look identical to
 * a caller, so probing does not reveal which tools a tenant has turned off. */
export function findEnabledTool(tools: readonly RegistryTool[], name: string): RegistryTool | undefined {
  const normalized = name.trim().toLowerCase();
  const tool = tools.find((candidate) => candidate.name.toLowerCase() === normalized);
  return tool?.enabled ? tool : undefined;
}
