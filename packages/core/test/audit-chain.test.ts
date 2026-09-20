import { describe, expect, it } from "vitest";
import { buildChain, signExport, verifyExport, type SignedExport } from "../src/index.js";

const SECRET = "export-signing-secret-at-least-32-bytes";
const secrets = { export_1: SECRET };
const entries = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];

function signed(): SignedExport {
  return signExport({ tenantId: "acme", entries, keyId: "export_1", secret: SECRET, exportedAt: "2026-09-20T12:00:00.000Z" });
}

describe("audit chain", () => {
  it("links each entry to the one before it", () => {
    const chain = buildChain(entries);
    expect(chain[0]?.previousHash).toBe("0".repeat(64));
    expect(chain[1]?.previousHash).toBe(chain[0]?.hash);
    expect(chain[2]?.previousHash).toBe(chain[1]?.hash);
  });

  it("verifies an untouched export", () => {
    expect(verifyExport(signed(), secrets)).toMatchObject({ valid: true, count: 3 });
  });

  it("is stable across key order, so re-serialising does not break it", () => {
    const a = signExport({ tenantId: "acme", entries: [{ x: 1, y: 2 }], keyId: "export_1", secret: SECRET, exportedAt: "2026-09-20T12:00:00.000Z" });
    const b = signExport({ tenantId: "acme", entries: [{ y: 2, x: 1 }], keyId: "export_1", secret: SECRET, exportedAt: "2026-09-20T12:00:00.000Z" });
    expect(a.chainHead).toBe(b.chainHead);
  });

  it("detects an edited entry", () => {
    const value = signed();
    (value.entries[1]!.entry as { value: number }).value = 999;
    expect(verifyExport(value, secrets)).toMatchObject({ valid: false, reason: "BROKEN_CHAIN", atSequence: 1 });
  });

  it("detects a removed entry", () => {
    const value = signed();
    value.entries.splice(1, 1);
    expect(verifyExport(value, secrets).valid).toBe(false);
  });

  it("detects reordered entries", () => {
    const value = signed();
    [value.entries[0], value.entries[1]] = [value.entries[1]!, value.entries[0]!];
    expect(verifyExport(value, secrets)).toMatchObject({ valid: false, reason: "BROKEN_CHAIN" });
  });

  it("detects an appended entry even when the chain is rebuilt", () => {
    const value = signed();
    const extra = signExport({ tenantId: "acme", entries: [...entries, { id: "d", value: 4 }], keyId: "export_1", secret: SECRET, exportedAt: value.exportedAt });
    // The chain itself is internally consistent, but the signature was made over
    // the original head and count, so the forgery is caught.
    const forged: SignedExport = { ...value, entries: extra.entries, chainHead: extra.chainHead, count: extra.count };
    expect(verifyExport(forged, secrets)).toMatchObject({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("detects a chain head that does not match the entries", () => {
    const value = { ...signed(), chainHead: "f".repeat(64) };
    expect(verifyExport(value, secrets).valid).toBe(false);
  });

  it("refuses an export relabelled as another tenant", () => {
    const value = { ...signed(), tenantId: "other" };
    expect(verifyExport(value, secrets)).toMatchObject({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses an unknown signing key rather than guessing", () => {
    expect(verifyExport(signed(), { someone_else: SECRET })).toEqual({ valid: false, reason: "UNKNOWN_KEY" });
  });

  it("handles an empty export", () => {
    const empty = signExport({ tenantId: "acme", entries: [], keyId: "export_1", secret: SECRET });
    expect(verifyExport(empty, secrets)).toMatchObject({ valid: true, count: 0 });
  });
});
