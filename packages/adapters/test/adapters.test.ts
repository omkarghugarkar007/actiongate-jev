import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRefusedError, WebhookRefusedError, guardFunction, guardToolCalls, guardWebhook, toToolMessages } from "@actiongate/adapters";
import type { ProxyPrincipal, ProxyRegistry, RegistryTool } from "@actiongate/proxy-core";
import type { AuthorizationRequest, AuthorizationResponse } from "@actiongate/core";

const PRINCIPAL: ProxyPrincipal = { tenantId: "acme", environment: "development", actor: { agentId: "agent" } };
const TOOLS: RegistryTool[] = [
  { name: "get_order", operation: "read", riskClass: "READ_ONLY", enabled: true },
  { name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", enabled: true },
  { name: "delete_record", operation: "delete", riskClass: "DESTRUCTIVE", enabled: false }
];
const registry: ProxyRegistry = { listTools: async () => TOOLS };
const SECRET = "webhook-secret-at-least-32-characters-long";

let authorize: ReturnType<typeof vi.fn>;
let consumeGrant: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;

function allow(request: AuthorizationRequest): AuthorizationResponse {
  return {
    requestId: request.requestId, decisionId: "00000000-0000-4000-8000-000000000000",
    decision: "ALLOW", mode: "enforce", riskClass: request.proposedAction.riskClass,
    reasons: [], signals: { deterministic: {} }, timing: { totalMs: 1, deterministicMs: 1 },
    policy: { id: "p", version: "1.0.0" }, createdAt: new Date().toISOString(),
    grant: { token: "grant", grantId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 30_000).toISOString() }
  };
}

function deny(decision: "BLOCK" | "REVIEW", request: AuthorizationRequest): AuthorizationResponse {
  const response = allow(request);
  delete response.grant;
  return { ...response, decision, reasons: [{ code: "RBAC_DENIED", message: "denied", source: "DETERMINISTIC" }] };
}

const client = () => ({ authorize, consumeGrant }) as never;

beforeEach(() => {
  authorize = vi.fn(async (request: AuthorizationRequest) => allow(request));
  consumeGrant = vi.fn(async () => ({ grantId: "g", decisionId: "d", status: "CONSUMED" as const, consumedAt: new Date().toISOString() }));
  dispatch = vi.fn(async () => ({ ok: true }));
});

describe("guardToolCalls", () => {
  const base = () => ({ client: client(), registry, principal: PRINCIPAL, dispatch: dispatch as never, userIntent: "Show me order 1." });

  it("dispatches an allowed call with the arguments it authorized", async () => {
    const results = await guardToolCalls([{ id: "c1", name: "get_order", arguments: '{"orderId":"1"}' }], base());
    expect(results[0]).toMatchObject({ id: "c1", executed: true });
    expect(dispatch).toHaveBeenCalledWith("get_order", { orderId: "1" });
    expect((authorize.mock.calls[0]?.[0] as AuthorizationRequest).proposedAction.arguments).toEqual({ orderId: "1" });
  });

  it("accepts arguments as a string or an object", async () => {
    await guardToolCalls([
      { id: "c1", name: "get_order", arguments: '{"orderId":"1"}' },
      { id: "c2", name: "get_order", arguments: { orderId: "2" } }
    ], base());
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("runs calls in order by default, since later calls often assume earlier ones", async () => {
    const order: string[] = [];
    dispatch.mockImplementation(async (name: string, args: Record<string, unknown>) => { order.push(String(args.orderId)); return {}; });
    await guardToolCalls([
      { id: "c1", name: "get_order", arguments: { orderId: "1" } },
      { id: "c2", name: "get_order", arguments: { orderId: "2" } },
      { id: "c3", name: "get_order", arguments: { orderId: "3" } }
    ], base());
    expect(order).toEqual(["1", "2", "3"]);
  });

  it("refuses one call without aborting the others", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) =>
      request.proposedAction.tool === "refund_payment" ? deny("BLOCK", request) : allow(request));
    const results = await guardToolCalls([
      { id: "c1", name: "refund_payment", arguments: { amountCents: 4900 } },
      { id: "c2", name: "get_order", arguments: { orderId: "1" } }
    ], base());
    expect(results[0]).toMatchObject({ executed: false, refusal: { code: "ACTION_DENIED", decision: "BLOCK" } });
    expect(results[1]?.executed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["BLOCK", "REVIEW"] as const)("never dispatches on %s", async (decision) => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => deny(decision, request));
    const results = await guardToolCalls([{ id: "c1", name: "refund_payment", arguments: {} }], base());
    expect(results[0]?.executed).toBe(false);
    expect(consumeGrant).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never dispatches when consumption fails or ActionGate is unreachable", async () => {
    consumeGrant.mockRejectedValue(new Error("spent"));
    expect((await guardToolCalls([{ id: "c1", name: "get_order", arguments: {} }], base()))[0]).toMatchObject({ executed: false, refusal: { code: "GRANT_NOT_CONSUMED" } });
    authorize.mockRejectedValue(new Error("down"));
    expect((await guardToolCalls([{ id: "c2", name: "get_order", arguments: {} }], base()))[0]).toMatchObject({ executed: false, refusal: { code: "ACTIONGATE_UNAVAILABLE" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("gives unknown and disabled tools the same refusal, so probing reveals nothing", async () => {
    const [unknown, disabled] = await guardToolCalls([
      { id: "c1", name: "drop_database", arguments: {} },
      { id: "c2", name: "delete_record", arguments: {} }
    ], base());
    expect(unknown?.refusal?.code).toBe("TOOL_NOT_AVAILABLE");
    expect(disabled?.refusal?.code).toBe("TOOL_NOT_AVAILABLE");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses malformed arguments before authorizing", async () => {
    const results = await guardToolCalls([{ id: "c1", name: "get_order", arguments: "not json" }], base());
    expect(results[0]).toMatchObject({ executed: false, refusal: { code: "INVALID_ARGUMENTS" } });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("turns refusals into tool messages the model can read", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => deny("REVIEW", request));
    const results = await guardToolCalls([{ id: "c1", name: "refund_payment", arguments: {} }], base());
    const messages = toToolMessages(results);
    expect(messages[0]?.tool_call_id).toBe("c1");
    const content = JSON.parse(messages[0]!.content);
    expect(content).toMatchObject({ ok: false, refused: "ACTION_DENIED", decision: "REVIEW" });
    expect(content.reasons[0].code).toBe("RBAC_DENIED");
    // The grant is never surfaced to the model.
    expect(messages[0]!.content).not.toContain("grant");
  });
});

describe("guardFunction", () => {
  const options = () => ({ client: client(), registry, principal: PRINCIPAL, tool: "refund_payment" });

  it("runs the function only after a grant is consumed", async () => {
    const order: string[] = [];
    consumeGrant.mockImplementation(async () => { order.push("consume"); return { grantId: "g", decisionId: "d", status: "CONSUMED" as const, consumedAt: "" }; });
    const guarded = guardFunction(async () => { order.push("execute"); return "done"; }, options());
    expect(await guarded({ amountCents: 4900 })).toBe("done");
    expect(order).toEqual(["consume", "execute"]);
  });

  it("throws with the decision and reasons instead of running", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => deny("BLOCK", request));
    let ran = false;
    const guarded = guardFunction(async () => { ran = true; return "done"; }, options());
    await expect(guarded({ amountCents: 4900 })).rejects.toBeInstanceOf(ActionRefusedError);
    expect(ran).toBe(false);
  });

  it("refuses a tool the registry does not enable", async () => {
    const guarded = guardFunction(async () => "done", { ...options(), tool: "delete_record" });
    await expect(guarded({})).rejects.toMatchObject({ code: "TOOL_NOT_AVAILABLE" });
  });
});

describe("guardWebhook", () => {
  function signed(body: unknown, at = Math.floor(Date.now() / 1000), secret = SECRET) {
    const rawBody = JSON.stringify(body);
    return {
      headers: {
        "x-timestamp": String(at),
        "x-signature": `v1=${createHmac("sha256", secret).update(`${at}.${rawBody}`).digest("hex")}`
      },
      rawBody
    };
  }

  const options = () => ({
    client: client(), registry, principal: PRINCIPAL, secret: SECRET,
    route: (payload: unknown) => {
      const event = payload as { type?: string; orderId?: string };
      return event.type === "order.refund_requested" ? { tool: "get_order", arguments: { orderId: String(event.orderId) }, intent: "Automation requested an order lookup." } : undefined;
    },
    dispatch: dispatch as never
  });

  it("verifies, authorizes, consumes, then dispatches", async () => {
    const result = await guardWebhook(signed({ type: "order.refund_requested", orderId: "1" }), options());
    expect(result).toMatchObject({ tool: "get_order" });
    expect(dispatch).toHaveBeenCalledWith("get_order", { orderId: "1" });
  });

  it("refuses a forged signature without spending anything on the provider", async () => {
    const webhook = signed({ type: "order.refund_requested", orderId: "1" }, undefined, "the-wrong-secret-at-least-32-chars");
    await expect(guardWebhook(webhook, options())).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    expect(authorize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a replayed delivery outside the tolerance window", async () => {
    const stale = signed({ type: "order.refund_requested", orderId: "1" }, Math.floor(Date.now() / 1000) - 3600);
    await expect(guardWebhook(stale, options())).rejects.toMatchObject({ code: "STALE_DELIVERY" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses a tampered body even when the signature header is intact", async () => {
    const webhook = signed({ type: "order.refund_requested", orderId: "1" });
    webhook.rawBody = JSON.stringify({ type: "order.refund_requested", orderId: "999" });
    await expect(guardWebhook(webhook, options())).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("treats an unrouted payload as not-an-action rather than an error to retry", async () => {
    await expect(guardWebhook(signed({ type: "something.else" }), options())).rejects.toBeInstanceOf(WebhookRefusedError);
    await expect(guardWebhook(signed({ type: "something.else" }), options())).rejects.toMatchObject({ code: "UNROUTED" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("does not dispatch when the action is denied", async () => {
    authorize.mockImplementation(async (request: AuthorizationRequest) => deny("BLOCK", request));
    await expect(guardWebhook(signed({ type: "order.refund_requested", orderId: "1" }), options())).rejects.toMatchObject({ code: "ACTION_DENIED" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
