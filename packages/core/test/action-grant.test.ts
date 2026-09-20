import { describe, expect, it } from "vitest";
import { ActionGrantError, ActionGrantSigner, actionFingerprint, type ActionGrantConsumeRequest, type AuthorizationRequest, type AuthorizationResponse } from "../src/index.js";

const secret = "test-action-grant-secret-with-at-least-32-bytes";
const now = Date.parse("2026-09-19T10:00:00.000Z");

const request: AuthorizationRequest = {
  requestId: "req-grant-1",
  idempotencyKey: "idem-grant-0001",
  tenantId: "tenant-a",
  environment: "production",
  mode: "enforce",
  actor: { agentId: "refund-agent", userId: "user-42", sessionId: "session-7" },
  userIntent: { text: "Refund transaction txn-1", source: "user_message" },
  proposedAction: {
    tool: "refund_payment",
    operation: "refund",
    arguments: { transactionId: "txn-1", amountCents: 4900 },
    riskClass: "FINANCIAL"
  }
};

const response: AuthorizationResponse = {
  requestId: request.requestId,
  decisionId: "5f2220e8-dd1c-4b51-a494-3d3c18ec2601",
  decision: "ALLOW",
  mode: "enforce",
  riskClass: "FINANCIAL",
  reasons: [],
  signals: { deterministic: {} },
  timing: { totalMs: 10, deterministicMs: 1, semanticMs: 9 },
  policy: { id: "default", version: "1.0.0" },
  createdAt: new Date(now).toISOString()
};

function consumeRequest(token: string): ActionGrantConsumeRequest {
  return {
    token,
    tenantId: request.tenantId,
    environment: request.environment,
    actor: { agentId: request.actor.agentId, userId: "user-42", sessionId: "session-7" },
    proposedAction: structuredClone(request.proposedAction)
  };
}

describe("ActionGrantSigner", () => {
  it("issues and verifies an exact-action grant", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now, ttlSeconds: 30 });
    const issued = signer.issue(request, response);
    expect(issued.grant).toMatchObject({ grantId: issued.claims.grantId, expiresAt: "2026-09-19T10:00:30.000Z" });
    expect(signer.verify(issued.grant.token, consumeRequest(issued.grant.token))).toEqual(issued.claims);
    expect(issued.grant.token).toMatch(/^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a changed signature", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    const { grant } = signer.issue(request, response);
    const [prefix, payload, signature] = grant.token.split(".") as [string, string, string];
    const tampered = `${prefix}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expectGrantError(() => signer.verify(tampered, consumeRequest(tampered)), "GRANT_INVALID_SIGNATURE");
  });

  it("rejects malformed, non-canonical, and wrong-key tokens", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    const { grant } = signer.issue(request, response);
    for (const token of ["", "ag1.only-two", "ag2.payload.signature", "ag1.***.***", `${grant.token}=`]) {
      expectGrantError(() => signer.verifyToken(token), "GRANT_MALFORMED");
    }
    const otherSigner = new ActionGrantSigner({ secret: "different-test-secret-that-is-at-least-32-bytes", clock: () => now });
    expectGrantError(() => otherSigner.verifyToken(grant.token), "GRANT_INVALID_SIGNATURE");
  });

  it("rotates signing keys while verifying grants from the overlap window", () => {
    const oldKey = { id: "2026-09-a", secret: "old-rotation-secret-that-is-at-least-32-bytes" };
    const nextKey = { id: "2026-09-b", secret: "next-rotation-secret-that-is-at-least-32-bytes" };
    const oldSigner = new ActionGrantSigner({ keys: [oldKey], activeKeyId: oldKey.id, clock: () => now });
    const oldGrant = oldSigner.issue(request, response).grant;
    expect(oldGrant.token).toMatch(/^ag2\.2026-09-a\./);

    const overlapSigner = new ActionGrantSigner({ keys: [oldKey, nextKey], activeKeyId: nextKey.id, clock: () => now });
    expect(overlapSigner.verify(oldGrant.token, consumeRequest(oldGrant.token)).keyId).toBe(oldKey.id);
    const nextGrant = overlapSigner.issue(request, response).grant;
    expect(nextGrant.token).toMatch(/^ag2\.2026-09-b\./);

    const retiredSigner = new ActionGrantSigner({ keys: [nextKey], activeKeyId: nextKey.id, clock: () => now });
    expectGrantError(() => retiredSigner.verifyToken(oldGrant.token), "GRANT_INVALID_SIGNATURE");
    expect(retiredSigner.verify(nextGrant.token, consumeRequest(nextGrant.token)).keyId).toBe(nextKey.id);
  });

  it("keeps action arguments and user intent out of token claims", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    const { grant } = signer.issue(request, response);
    const payload = JSON.parse(Buffer.from(grant.token.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload).not.toHaveProperty("arguments");
    expect(payload).not.toHaveProperty("userIntent");
    expect(JSON.stringify(payload)).not.toContain("txn-1");
  });

  it("accepts semantically identical argument objects with a different key order", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    const { grant } = signer.issue(request, response);
    const reordered = consumeRequest(grant.token);
    reordered.proposedAction.arguments = { amountCents: 4900, transactionId: "txn-1" };
    expect(signer.verify(grant.token, reordered).grantId).toBe(grant.grantId);
  });

  it("rejects expired grants", () => {
    let clock = now;
    const signer = new ActionGrantSigner({ secret, clock: () => clock, ttlSeconds: 10 });
    const { grant } = signer.issue(request, response);
    clock += 10_000;
    expectGrantError(() => signer.verify(grant.token, consumeRequest(grant.token)), "GRANT_EXPIRED");
  });

  it.each([
    ["tenant", (value: ActionGrantConsumeRequest) => { value.tenantId = "tenant-b"; }],
    ["environment", (value: ActionGrantConsumeRequest) => { value.environment = "staging"; }],
    ["agent", (value: ActionGrantConsumeRequest) => { value.actor.agentId = "other-agent"; }],
    ["user", (value: ActionGrantConsumeRequest) => { value.actor.userId = "other-user"; }],
    ["session", (value: ActionGrantConsumeRequest) => { value.actor.sessionId = "other-session"; }],
    ["tool", (value: ActionGrantConsumeRequest) => { value.proposedAction.tool = "issue_credit"; }],
    ["operation", (value: ActionGrantConsumeRequest) => { value.proposedAction.operation = "void"; }],
    ["arguments", (value: ActionGrantConsumeRequest) => { value.proposedAction.arguments.amountCents = 49000; }],
    ["risk class", (value: ActionGrantConsumeRequest) => { value.proposedAction.riskClass = "REVERSIBLE_WRITE"; }]
  ])("rejects a changed %s", (_name, mutate) => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    const { grant } = signer.issue(request, response);
    const changed = consumeRequest(grant.token);
    mutate(changed);
    expectGrantError(() => signer.verify(grant.token, changed), "GRANT_BINDING_MISMATCH");
  });

  it("includes risk class in idempotency fingerprints", () => {
    const lowerRisk: AuthorizationRequest = { ...request, proposedAction: { ...request.proposedAction, riskClass: "REVERSIBLE_WRITE" } };
    expect(actionFingerprint(lowerRisk, "1.0.0")).not.toBe(actionFingerprint(request, "1.0.0"));
  });

  it("refuses to issue grants for shadow or non-allow decisions", () => {
    const signer = new ActionGrantSigner({ secret, clock: () => now });
    expect(() => signer.issue({ ...request, mode: "shadow" }, { ...response, mode: "shadow" })).toThrow(/enforced ALLOW/);
    expect(() => signer.issue(request, { ...response, decision: "REVIEW" })).toThrow(/enforced ALLOW/);
  });
});

function expectGrantError(work: () => unknown, code: string) {
  try {
    work();
    throw new Error("Expected an ActionGrantError");
  } catch (error) {
    expect(error).toBeInstanceOf(ActionGrantError);
    expect((error as ActionGrantError).code).toBe(code);
  }
}
