import { createHmac, timingSafeEqual } from "node:crypto";
import {
  authorizeAndConsume,
  findEnabledTool,
  relayedIntent,
  type ActionGateEnforcementClient,
  type ProxyPrincipal,
  type ProxyRegistry
} from "@actiongate/proxy-core";

/**
 * Inbound webhook and workflow-automation connector.
 *
 * Automation platforms fire an action at you over HTTP. Two things have to hold
 * before that action reaches a side effect: the caller must be who they claim,
 * and the action must be authorized. This handles both, in that order — an
 * unverified payload is never authorized, so a forged webhook costs no provider
 * spend and produces no decision record.
 *
 * **Guard** level. It protects the handler it dispatches to, not the wider
 * system: anything else able to call that handler is unguarded.
 */
export interface InboundWebhook {
  headers: Record<string, string | string[] | undefined>;
  /** The exact bytes received. Re-serialising before verification breaks the signature. */
  rawBody: string;
}

export interface GuardWebhookOptions {
  client: ActionGateEnforcementClient;
  registry: ProxyRegistry;
  principal: ProxyPrincipal;
  /** Shared with the sending platform only. */
  secret: string;
  signatureHeader?: string;
  timestampHeader?: string;
  /** How far out of date a delivery may be. Bounds replay. */
  toleranceSeconds?: number;
  /** Maps a verified payload to a registry tool and its canonical arguments. */
  route(payload: unknown): { tool: string; arguments: Record<string, unknown>; intent?: string } | undefined;
  dispatch(tool: string, args: Record<string, unknown>): Promise<unknown>;
  clock?: () => number;
}

export class WebhookRefusedError extends Error {
  constructor(
    public readonly code: "BAD_SIGNATURE" | "STALE_DELIVERY" | "MALFORMED" | "UNROUTED" | "TOOL_NOT_AVAILABLE" | "ACTION_DENIED" | "GRANT_MISSING" | "GRANT_NOT_CONSUMED" | "ACTIONGATE_UNAVAILABLE",
    public readonly detail?: unknown
  ) {
    super(`Webhook refused: ${code}`);
    this.name = "WebhookRefusedError";
  }
}

export async function guardWebhook(webhook: InboundWebhook, options: GuardWebhookOptions): Promise<{ tool: string; result: unknown }> {
  const now = options.clock?.() ?? Date.now();
  const signature = header(webhook, options.signatureHeader ?? "x-signature");
  const timestamp = header(webhook, options.timestampHeader ?? "x-timestamp");
  if (!signature || !timestamp) throw new WebhookRefusedError("BAD_SIGNATURE");

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) throw new WebhookRefusedError("BAD_SIGNATURE");
  // Checked before the signature so a replayed-but-valid delivery is still refused.
  if (Math.abs(Math.floor(now / 1000) - seconds) > (options.toleranceSeconds ?? 300)) {
    throw new WebhookRefusedError("STALE_DELIVERY");
  }

  const expected = Buffer.from(createHmac("sha256", options.secret).update(`${seconds}.${webhook.rawBody}`).digest("hex"));
  const provided = Buffer.from(signature.replace(/^v1=/, ""));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WebhookRefusedError("BAD_SIGNATURE");
  }

  let payload: unknown;
  try { payload = JSON.parse(webhook.rawBody); } catch { throw new WebhookRefusedError("MALFORMED"); }

  const routed = options.route(payload);
  // An unrouted payload is not an error to retry; it is simply not an action here.
  if (!routed) throw new WebhookRefusedError("UNROUTED");

  const tool = findEnabledTool(await options.registry.listTools(options.principal), routed.tool);
  if (!tool) throw new WebhookRefusedError("TOOL_NOT_AVAILABLE");

  const outcome = await authorizeAndConsume(options.client, {
    principal: options.principal,
    tool,
    arguments: routed.arguments,
    userIntent: relayedIntent(routed.intent, "This action arrived from an automation webhook with no user intent.")
  });

  if (!outcome.ok) {
    if (outcome.kind === "denied") throw new WebhookRefusedError("ACTION_DENIED", { decision: outcome.decision, reasons: outcome.reasons });
    throw new WebhookRefusedError(outcome.kind === "no_grant" ? "GRANT_MISSING" : outcome.kind === "consume_failed" ? "GRANT_NOT_CONSUMED" : "ACTIONGATE_UNAVAILABLE");
  }

  return { tool: tool.name, result: await options.dispatch(tool.name, routed.arguments) };
}

function header(webhook: InboundWebhook, name: string): string | undefined {
  const value = webhook.headers[name] ?? webhook.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
