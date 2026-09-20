import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tamper-evident audit exports.
 *
 * Each entry is hashed together with the hash of the entry before it, so the
 * export forms a chain. Removing, reordering, or editing any entry changes every
 * hash after it, and the final signature covers the chain head. A holder of the
 * export can therefore detect tampering without trusting whoever handed it over.
 *
 * This is tamper-*evident*, not tamper-proof: whoever holds the signing key can
 * forge a consistent chain. It defends against a reader altering an export, not
 * against the exporter lying at the moment of export.
 */
export interface ChainedEntry {
  sequence: number;
  /** Hash of this entry's content plus the previous entry's hash. */
  hash: string;
  previousHash: string;
  entry: unknown;
}

export interface SignedExport {
  version: 1;
  tenantId: string;
  exportedAt: string;
  count: number;
  /** The last hash in the chain; the signature covers this, not each entry. */
  chainHead: string;
  algorithm: "sha256-hmac";
  keyId: string;
  signature: string;
  entries: ChainedEntry[];
}

const GENESIS = "0".repeat(64);

export function buildChain(entries: readonly unknown[]): ChainedEntry[] {
  let previousHash = GENESIS;
  return entries.map((entry, index) => {
    const hash = hashEntry(index, previousHash, entry);
    const chained: ChainedEntry = { sequence: index, hash, previousHash, entry };
    previousHash = hash;
    return chained;
  });
}

export function signExport(input: {
  tenantId: string;
  entries: readonly unknown[];
  keyId: string;
  secret: string | Buffer;
  exportedAt?: string;
}): SignedExport {
  const chained = buildChain(input.entries);
  const chainHead = chained.at(-1)?.hash ?? GENESIS;
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  return {
    version: 1,
    tenantId: input.tenantId,
    exportedAt,
    count: chained.length,
    chainHead,
    algorithm: "sha256-hmac",
    keyId: input.keyId,
    // The signature binds tenant, time, and count as well as the chain head, so
    // a chain cannot be relabelled as another tenant's or another moment's.
    signature: createHmac("sha256", input.secret)
      .update([input.tenantId, exportedAt, String(chained.length), chainHead].join("\n"))
      .digest("base64url"),
    entries: chained
  };
}

export type ExportVerification =
  | { valid: true; count: number; chainHead: string }
  | { valid: false; reason: "UNKNOWN_KEY" | "BAD_SIGNATURE" | "BROKEN_CHAIN" | "COUNT_MISMATCH"; atSequence?: number };

export function verifyExport(value: SignedExport, secrets: Readonly<Record<string, string | Buffer>>): ExportVerification {
  const secret = secrets[value.keyId];
  if (!secret) return { valid: false, reason: "UNKNOWN_KEY" };
  if (value.entries.length !== value.count) return { valid: false, reason: "COUNT_MISMATCH" };

  let previousHash = GENESIS;
  for (const [index, chained] of value.entries.entries()) {
    if (chained.sequence !== index || chained.previousHash !== previousHash) {
      return { valid: false, reason: "BROKEN_CHAIN", atSequence: index };
    }
    if (hashEntry(index, previousHash, chained.entry) !== chained.hash) {
      return { valid: false, reason: "BROKEN_CHAIN", atSequence: index };
    }
    previousHash = chained.hash;
  }
  if (previousHash !== value.chainHead) return { valid: false, reason: "BROKEN_CHAIN", atSequence: value.entries.length };

  const expected = Buffer.from(createHmac("sha256", secret)
    .update([value.tenantId, value.exportedAt, String(value.count), value.chainHead].join("\n"))
    .digest("base64url"));
  const provided = Buffer.from(value.signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  return { valid: true, count: value.count, chainHead: value.chainHead };
}

function hashEntry(sequence: number, previousHash: string, entry: unknown): string {
  return createHash("sha256").update(`${sequence}\n${previousHash}\n${canonical(entry)}`).digest("hex");
}

/** Stable across key order, so re-serialising an entry does not break its hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
