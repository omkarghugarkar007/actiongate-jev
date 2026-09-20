import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedEnvelope {
  v: 1;
  algorithm: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export class EvidenceCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(entries: ReadonlyArray<{ id: string; secret: string | Buffer }>, private readonly activeKeyId: string) {
    if (entries.length === 0) throw new Error("At least one evidence-encryption key is required");
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(entry.id)) throw new Error("Evidence key ID is invalid");
      if (this.keys.has(entry.id)) throw new Error(`Duplicate evidence key ID: ${entry.id}`);
      const source = Buffer.isBuffer(entry.secret) ? entry.secret : Buffer.from(entry.secret, "utf8");
      if (source.byteLength < 32) throw new Error("Evidence-encryption secrets must be at least 32 bytes");
      this.keys.set(entry.id, createHash("sha256").update(source).digest());
    }
    if (!this.keys.has(activeKeyId)) throw new Error("Active evidence key ID was not provided");
  }

  encrypt(value: unknown, associatedData: string): EncryptedEnvelope {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      v: 1,
      algorithm: "A256GCM",
      keyId: this.activeKeyId,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url")
    };
  }

  decrypt<T>(envelope: EncryptedEnvelope, associatedData: string): T {
    if (envelope.v !== 1 || envelope.algorithm !== "A256GCM") throw new Error("Unsupported encrypted evidence envelope");
    const key = this.keys.get(envelope.keyId);
    if (!key) throw new Error("Evidence encryption key is unknown or retired");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedEnvelope>;
  return candidate.v === 1 && candidate.algorithm === "A256GCM" && typeof candidate.keyId === "string" && typeof candidate.iv === "string" && typeof candidate.ciphertext === "string" && typeof candidate.tag === "string";
}
