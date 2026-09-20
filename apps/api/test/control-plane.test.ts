import { describe, expect, it } from "vitest";
import { EvidenceCipher } from "../src/security/evidence-cipher.js";
import { InMemoryControlPlaneRepository } from "../src/services/control-plane.js";

describe("tenant control-plane primitives", () => {
  it("encrypts evidence with authenticated context and supports overlap rotation", () => {
    const oldKey = { id: "old", secret: "old-evidence-secret-that-is-at-least-32-bytes" };
    const nextKey = { id: "next", secret: "next-evidence-secret-that-is-at-least-32-bytes" };
    const oldCipher = new EvidenceCipher([oldKey], oldKey.id);
    const envelope = oldCipher.encrypt({ userIntent: "private refund request" }, "tenant-a:decision-1");
    expect(JSON.stringify(envelope)).not.toContain("private refund request");
    const rotating = new EvidenceCipher([oldKey, nextKey], nextKey.id);
    expect(rotating.decrypt(envelope, "tenant-a:decision-1")).toEqual({ userIntent: "private refund request" });
    expect(() => rotating.decrypt(envelope, "tenant-b:decision-1")).toThrow();
    expect(new EvidenceCipher([nextKey], nextKey.id).encrypt({ ok: true }, "tenant-a").keyId).toBe("next");
  });

  it("issues hashed tenant keys and makes revocation effective immediately", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const issued = await repository.createApiKey({ tenantId: "tenant-a", name: "runtime", environment: "production", roles: ["authorize", "consume"] });
    expect(issued.token).toMatch(/^agk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(await repository.authenticate(issued.token)).toMatchObject({ tenantId: "tenant-a", environment: "production", roles: ["authorize", "consume"] });
    expect(JSON.stringify(await repository.listApiKeys("tenant-a"))).not.toContain(issued.token);
    expect(JSON.stringify(await repository.listApiKeys("tenant-a"))).not.toContain("scrypt-v1");
    await repository.revokeApiKey("tenant-a", issued.key.id, new Date());
    await expect(repository.authenticate(issued.token)).resolves.toBeUndefined();
  });
});
