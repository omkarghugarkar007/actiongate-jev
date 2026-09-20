import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ActionGrantClaims } from "./action-grant.js";

export interface CredentialRequest {
  claims: ActionGrantClaims;
  /** Seconds the credential stays valid. The broker clamps this to its maximum. */
  ttlSeconds: number;
  /** Which downstream system the caller intends to reach. */
  audience?: string;
}

export interface IssuedCredential {
  /** `bearer` hands back a token; `signed_request` hands back headers to replay. */
  type: "bearer" | "signed_request";
  issuer: string;
  expiresAt: string;
  audience?: string;
  /** Present for `bearer`. */
  token?: string;
  /** Present for `signed_request`: headers the caller attaches to the downstream call. */
  headers?: Record<string, string>;
}

export interface CredentialIssuer {
  readonly name: string;
  issue(request: CredentialRequest): Promise<IssuedCredential>;
}

export interface SignedRequestIssuerOptions {
  name?: string;
  /** Independent of the grant-signing key. Shared with the downstream verifier only. */
  secret: string | Buffer;
  keyId: string;
  maxTtlSeconds?: number;
  clock?: () => number;
}

/**
 * Turns a consumed Action Grant into a short-lived signature the downstream
 * service can verify on its own, without calling ActionGate and without the
 * caller ever holding a long-lived credential.
 *
 * The signature covers the exact action, so a caller that alters the request
 * after the exchange produces a signature that no longer verifies.
 */
export class SignedRequestIssuer implements CredentialIssuer {
  readonly name: string;
  private readonly clock: () => number;

  constructor(private readonly options: SignedRequestIssuerOptions) {
    this.name = options.name ?? "signed-request";
    this.clock = options.clock ?? Date.now;
    if (!options.keyId) throw new Error("A credential key ID is required");
    if (Buffer.byteLength(options.secret as string) < 32) throw new Error("A credential signing secret must be at least 32 bytes");
  }

  async issue(request: CredentialRequest): Promise<IssuedCredential> {
    const maxTtl = this.options.maxTtlSeconds ?? 120;
    const ttl = Math.max(1, Math.min(request.ttlSeconds, maxTtl));
    const issuedAt = this.clock();
    const expiresAt = new Date(issuedAt + ttl * 1000).toISOString();
    const nonce = randomUUID();
    const payload = canonicalPayload(request.claims.grantId, request.claims.actionFingerprint, expiresAt, nonce, request.audience);
    const signature = createHmac("sha256", this.options.secret).update(payload).digest("base64url");
    return {
      type: "signed_request",
      issuer: this.name,
      expiresAt,
      ...(request.audience ? { audience: request.audience } : {}),
      headers: {
        "x-actiongate-key-id": this.options.keyId,
        "x-actiongate-grant-id": request.claims.grantId,
        "x-actiongate-fingerprint": request.claims.actionFingerprint,
        "x-actiongate-expires-at": expiresAt,
        "x-actiongate-nonce": nonce,
        ...(request.audience ? { "x-actiongate-audience": request.audience } : {}),
        "x-actiongate-signature": signature
      }
    };
  }
}

export interface VerifySignedRequestInput {
  headers: Record<string, string | string[] | undefined>;
  secrets: Readonly<Record<string, string | Buffer>>;
  now?: number;
}

export type SignedRequestVerification =
  | { valid: true; grantId: string; fingerprint: string; audience?: string }
  | { valid: false; reason: "MISSING_HEADERS" | "UNKNOWN_KEY" | "EXPIRED" | "BAD_SIGNATURE" };

/**
 * Downstream verification helper. A service can drop this in and refuse any
 * request that did not come through an ActionGate credential exchange.
 */
export function verifySignedRequest(input: VerifySignedRequestInput): SignedRequestVerification {
  const get = (name: string) => {
    const value = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const keyId = get("x-actiongate-key-id");
  const grantId = get("x-actiongate-grant-id");
  const fingerprint = get("x-actiongate-fingerprint");
  const expiresAt = get("x-actiongate-expires-at");
  const nonce = get("x-actiongate-nonce");
  const signature = get("x-actiongate-signature");
  const audience = get("x-actiongate-audience");
  if (!keyId || !grantId || !fingerprint || !expiresAt || !nonce || !signature) return { valid: false, reason: "MISSING_HEADERS" };

  const secret = input.secrets[keyId];
  if (!secret) return { valid: false, reason: "UNKNOWN_KEY" };
  if (Date.parse(expiresAt) <= (input.now ?? Date.now())) return { valid: false, reason: "EXPIRED" };

  const expected = createHmac("sha256", secret)
    .update(canonicalPayload(grantId, fingerprint, expiresAt, nonce, audience))
    .digest("base64url");
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return { valid: false, reason: "BAD_SIGNATURE" };
  return { valid: true, grantId, fingerprint, ...(audience ? { audience } : {}) };
}

function canonicalPayload(grantId: string, fingerprint: string, expiresAt: string, nonce: string, audience?: string): string {
  return [grantId, fingerprint, expiresAt, nonce, audience ?? ""].join("\n");
}
