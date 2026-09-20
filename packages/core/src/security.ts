import { createHash } from "node:crypto";
import type { ActionGrantConsumeRequest, AuthorizationRequest } from "./contracts.js";

const SECRET_KEY = /^(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)$/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)]));
  }
  return value;
}

/**
 * Stable JSON used for action fingerprints.
 *
 * Keys sort by code point, not `localeCompare`. `localeCompare` is
 * locale-dependent, so two runtimes with different ICU data could order
 * mixed-case keys differently and produce different fingerprints for the same
 * action. Code-point order is the same everywhere, and is what the Python
 * implementation produces, so a grant fingerprints identically in both.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ActionBinding {
  tenantId: string;
  environment: AuthorizationRequest["environment"];
  agentId: string;
  userId?: string;
  sessionId?: string;
  proposedAction: AuthorizationRequest["proposedAction"];
}

export function actionBindingFingerprint(binding: ActionBinding, policyVersion: string): string {
  return createHash("sha256").update(canonicalJson({
    tenantId: binding.tenantId,
    environment: binding.environment,
    agentId: binding.agentId,
    userId: binding.userId ?? null,
    sessionId: binding.sessionId ?? null,
    tool: binding.proposedAction.tool.trim().toLowerCase(),
    operation: binding.proposedAction.operation.trim().toLowerCase(),
    arguments: binding.proposedAction.arguments,
    riskClass: binding.proposedAction.riskClass,
    policyVersion
  })).digest("hex");
}

export function authorizationRequestBinding(req: AuthorizationRequest): ActionBinding {
  return {
    tenantId: req.tenantId,
    environment: req.environment,
    agentId: req.actor.agentId,
    ...(req.actor.userId ? { userId: req.actor.userId } : {}),
    ...(req.actor.sessionId ? { sessionId: req.actor.sessionId } : {}),
    proposedAction: req.proposedAction
  };
}

export function grantConsumeBinding(req: ActionGrantConsumeRequest): ActionBinding {
  return {
    tenantId: req.tenantId,
    environment: req.environment,
    agentId: req.actor.agentId,
    ...(req.actor.userId ? { userId: req.actor.userId } : {}),
    ...(req.actor.sessionId ? { sessionId: req.actor.sessionId } : {}),
    proposedAction: req.proposedAction
  };
}

export function actionFingerprint(req: AuthorizationRequest, policyVersion: string): string {
  return actionBindingFingerprint(authorizationRequestBinding(req), policyVersion);
}
