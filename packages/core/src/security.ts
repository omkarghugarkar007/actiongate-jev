import { createHash } from "node:crypto";
import type { AuthorizationRequest } from "./contracts.js";

const SECRET_KEY = /^(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)$/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function actionFingerprint(req: AuthorizationRequest, policyVersion: string): string {
  return createHash("sha256").update(canonicalJson({
    tenantId: req.tenantId,
    environment: req.environment,
    agentId: req.actor.agentId,
    tool: req.proposedAction.tool.trim().toLowerCase(),
    operation: req.proposedAction.operation.trim().toLowerCase(),
    arguments: req.proposedAction.arguments,
    policyVersion
  })).digest("hex");
}

