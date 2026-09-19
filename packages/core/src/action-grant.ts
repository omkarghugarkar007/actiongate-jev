import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ActionGrantConsumeRequestSchema, RiskClassSchema, type ActionGrant, type ActionGrantConsumeRequest, type AuthorizationRequest, type AuthorizationResponse } from "./contracts.js";
import { actionBindingFingerprint, authorizationRequestBinding, grantConsumeBinding } from "./security.js";

const ActionGrantClaimsSchema = z.object({
  v: z.literal(1),
  issuer: z.literal("actiongate"),
  grantId: z.string().uuid(),
  decisionId: z.string().uuid(),
  requestId: z.string().min(1).max(128),
  tenantId: z.string().min(1).max(128),
  environment: z.enum(["development", "staging", "production"]),
  agentId: z.string().min(1).max(128),
  tool: z.string().min(1).max(128),
  operation: z.string().min(1).max(128),
  riskClass: RiskClassSchema,
  actionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.object({ id: z.string().min(1).max(128), version: z.string().min(1).max(64) }).strict(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive()
}).strict();

export type ActionGrantClaims = z.infer<typeof ActionGrantClaimsSchema>;

export type ActionGrantErrorCode =
  | "GRANT_MALFORMED"
  | "GRANT_INVALID_SIGNATURE"
  | "GRANT_EXPIRED"
  | "GRANT_BINDING_MISMATCH"
  | "GRANT_NOT_FOUND"
  | "GRANT_ALREADY_CONSUMED";

export class ActionGrantError extends Error {
  constructor(public readonly code: ActionGrantErrorCode, message: string = code) {
    super(message);
    this.name = "ActionGrantError";
  }
}

export interface ActionGrantSignerOptions {
  secret: string | Buffer;
  ttlSeconds?: number;
  clock?: () => number;
  maxClockSkewSeconds?: number;
}

export class ActionGrantSigner {
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  private readonly clock: () => number;
  private readonly maxClockSkewSeconds: number;

  constructor(options: ActionGrantSignerOptions) {
    this.secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(options.secret, "utf8");
    if (this.secret.byteLength < 32) throw new Error("Action Grant signing secret must be at least 32 bytes");
    this.ttlSeconds = options.ttlSeconds ?? 30;
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1 || this.ttlSeconds > 300) throw new Error("Action Grant TTL must be an integer from 1 to 300 seconds");
    this.clock = options.clock ?? Date.now;
    this.maxClockSkewSeconds = options.maxClockSkewSeconds ?? 5;
  }

  issue(request: AuthorizationRequest, response: AuthorizationResponse): { grant: ActionGrant; claims: ActionGrantClaims } {
    if (response.decision !== "ALLOW" || response.mode !== "enforce") throw new Error("Action Grants require an enforced ALLOW decision");
    const issuedAt = Math.floor(this.clock() / 1000);
    const claims: ActionGrantClaims = {
      v: 1,
      issuer: "actiongate",
      grantId: randomUUID(),
      decisionId: response.decisionId,
      requestId: response.requestId,
      tenantId: request.tenantId,
      environment: request.environment,
      agentId: request.actor.agentId,
      tool: request.proposedAction.tool.trim().toLowerCase(),
      operation: request.proposedAction.operation.trim().toLowerCase(),
      riskClass: request.proposedAction.riskClass,
      actionFingerprint: actionBindingFingerprint(authorizationRequestBinding(request), response.policy.version),
      policy: response.policy,
      issuedAt,
      expiresAt: issuedAt + this.ttlSeconds
    };
    return { grant: this.toPublicGrant(claims), claims };
  }

  verify(token: string, request: ActionGrantConsumeRequest): ActionGrantClaims {
    const parsedRequest = ActionGrantConsumeRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new ActionGrantError("GRANT_MALFORMED", "Grant consumption request is malformed");
    const claims = this.verifyToken(token);
    const expected = actionBindingFingerprint(grantConsumeBinding(parsedRequest.data), claims.policy.version);
    if (!safeStringEqual(expected, claims.actionFingerprint)) throw new ActionGrantError("GRANT_BINDING_MISMATCH", "Grant does not authorize this exact action");
    return claims;
  }

  verifyToken(token: string): ActionGrantClaims {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "ag1" || !parts[1] || !parts[2]) throw new ActionGrantError("GRANT_MALFORMED");
    const signingInput = `${parts[0]}.${parts[1]}`;
    const suppliedSignature = decodeBase64Url(parts[2], "GRANT_MALFORMED");
    const expectedSignature = createHmac("sha256", this.secret).update(signingInput).digest();
    if (suppliedSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new ActionGrantError("GRANT_INVALID_SIGNATURE");
    }
    let json: unknown;
    try {
      json = JSON.parse(decodeBase64Url(parts[1], "GRANT_MALFORMED").toString("utf8"));
    } catch {
      throw new ActionGrantError("GRANT_MALFORMED");
    }
    const result = ActionGrantClaimsSchema.safeParse(json);
    if (!result.success) throw new ActionGrantError("GRANT_MALFORMED");
    const now = Math.floor(this.clock() / 1000);
    if (result.data.issuedAt > now + this.maxClockSkewSeconds || result.data.expiresAt <= result.data.issuedAt) throw new ActionGrantError("GRANT_MALFORMED");
    if (now >= result.data.expiresAt) throw new ActionGrantError("GRANT_EXPIRED");
    return result.data;
  }

  signClaims(claims: ActionGrantClaims): string {
    const checked = ActionGrantClaimsSchema.parse(claims);
    const payload = Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
    const signingInput = `ag1.${payload}`;
    const signature = createHmac("sha256", this.secret).update(signingInput).digest("base64url");
    return `${signingInput}.${signature}`;
  }

  toPublicGrant(claims: ActionGrantClaims): ActionGrant {
    return {
      token: this.signClaims(claims),
      grantId: claims.grantId,
      expiresAt: new Date(claims.expiresAt * 1000).toISOString()
    };
  }
}

function decodeBase64Url(value: string, code: ActionGrantErrorCode): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ActionGrantError(code);
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new ActionGrantError(code);
    return decoded;
  } catch {
    throw new ActionGrantError(code);
  }
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}
