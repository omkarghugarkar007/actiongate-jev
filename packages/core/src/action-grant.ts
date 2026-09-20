import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ActionGrantConsumeRequestSchema, RiskClassSchema, type ActionGrant, type ActionGrantConsumeRequest, type AuthorizationRequest, type AuthorizationResponse } from "./contracts.js";
import { actionBindingFingerprint, authorizationRequestBinding, grantConsumeBinding } from "./security.js";

const ActionGrantClaimsSchema = z.object({
  v: z.literal(1),
  issuer: z.literal("actiongate"),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
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
  | "GRANT_REVOKED"
  | "GRANT_ALREADY_CONSUMED";

export class ActionGrantError extends Error {
  constructor(public readonly code: ActionGrantErrorCode, message: string = code) {
    super(message);
    this.name = "ActionGrantError";
  }
}

export interface ActionGrantSignerOptions {
  secret?: string | Buffer;
  keys?: ReadonlyArray<{ id: string; secret: string | Buffer }>;
  activeKeyId?: string;
  ttlSeconds?: number;
  clock?: () => number;
  maxClockSkewSeconds?: number;
}

export class ActionGrantSigner {
  private readonly legacySecret?: Buffer;
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId?: string;
  private readonly ttlSeconds: number;
  private readonly clock: () => number;
  private readonly maxClockSkewSeconds: number;

  constructor(options: ActionGrantSignerOptions) {
    if (options.keys?.length) {
      for (const entry of options.keys) {
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(entry.id)) throw new Error("Action Grant key ID is invalid");
        if (this.keys.has(entry.id)) throw new Error(`Duplicate Action Grant key ID: ${entry.id}`);
        this.keys.set(entry.id, checkedSecret(entry.secret));
      }
      this.activeKeyId = options.activeKeyId ?? options.keys[0]!.id;
      if (!this.keys.has(this.activeKeyId)) throw new Error("Active Action Grant key ID was not provided");
    } else {
      if (!options.secret) throw new Error("An Action Grant signing secret or key ring is required");
      this.legacySecret = checkedSecret(options.secret);
    }
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
      ...(this.activeKeyId ? { keyId: this.activeKeyId } : {}),
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
    let payload: string;
    let signature: string;
    let signingInput: string;
    let secret: Buffer | undefined;
    let tokenKeyId: string | undefined;
    if (parts.length === 3 && parts[0] === "ag1" && parts[1] && parts[2]) {
      payload = parts[1];
      signature = parts[2];
      signingInput = `ag1.${payload}`;
      secret = this.legacySecret;
    } else if (parts.length === 4 && parts[0] === "ag2" && parts[1] && parts[2] && parts[3]) {
      tokenKeyId = parts[1];
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(tokenKeyId)) throw new ActionGrantError("GRANT_MALFORMED");
      payload = parts[2];
      signature = parts[3];
      signingInput = `ag2.${tokenKeyId}.${payload}`;
      secret = this.keys.get(tokenKeyId);
    } else {
      throw new ActionGrantError("GRANT_MALFORMED");
    }
    if (!secret) throw new ActionGrantError("GRANT_INVALID_SIGNATURE", "The signing key is unknown or retired");
    const suppliedSignature = decodeBase64Url(signature, "GRANT_MALFORMED");
    const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();
    if (suppliedSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new ActionGrantError("GRANT_INVALID_SIGNATURE");
    }
    let json: unknown;
    try {
      json = JSON.parse(decodeBase64Url(payload, "GRANT_MALFORMED").toString("utf8"));
    } catch {
      throw new ActionGrantError("GRANT_MALFORMED");
    }
    const result = ActionGrantClaimsSchema.safeParse(json);
    if (!result.success) throw new ActionGrantError("GRANT_MALFORMED");
    if (result.data.keyId !== tokenKeyId) throw new ActionGrantError("GRANT_MALFORMED", "Grant key ID does not match its protected header");
    const now = Math.floor(this.clock() / 1000);
    if (result.data.issuedAt > now + this.maxClockSkewSeconds || result.data.expiresAt <= result.data.issuedAt) throw new ActionGrantError("GRANT_MALFORMED");
    if (now >= result.data.expiresAt) throw new ActionGrantError("GRANT_EXPIRED");
    return result.data;
  }

  signClaims(claims: ActionGrantClaims): string {
    const checked = ActionGrantClaimsSchema.parse(claims);
    const payload = Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
    const keyId = checked.keyId;
    const secret = keyId ? this.keys.get(keyId) : this.legacySecret;
    if (!secret) throw new ActionGrantError("GRANT_INVALID_SIGNATURE", "The signing key is unknown or retired");
    const signingInput = keyId ? `ag2.${keyId}.${payload}` : `ag1.${payload}`;
    const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
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

function checkedSecret(value: string | Buffer): Buffer {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (secret.byteLength < 32) throw new Error("Action Grant signing secret must be at least 32 bytes");
  return secret;
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
