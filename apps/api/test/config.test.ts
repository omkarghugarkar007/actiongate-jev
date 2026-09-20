import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validGrantRing = JSON.stringify({ grant_2026_09: "g".repeat(32) });
const validEvidenceRing = JSON.stringify({ evidence_2026_09: "e".repeat(32) });

describe("production configuration guardrails", () => {
  it.each([
    [{}, "Production requires ACTIONGATE_STORAGE=redis"],
    [{ ACTIONGATE_STORAGE: "redis" }, "Production requires ACTIONGATE_CONTROL_PLANE=postgres"],
    [{ ACTIONGATE_STORAGE: "redis", ACTIONGATE_CONTROL_PLANE: "postgres", ACTIONGATE_API_KEY: "legacy-static-key" }, "Production does not accept ACTIONGATE_API_KEY"],
    [{ ACTIONGATE_STORAGE: "redis", ACTIONGATE_CONTROL_PLANE: "postgres" }, "Production requires an Action Grant key ring"],
    [{
      ACTIONGATE_STORAGE: "redis",
      ACTIONGATE_CONTROL_PLANE: "postgres",
      ACTIONGATE_GRANT_KEYS: validGrantRing,
      ACTIONGATE_GRANT_ACTIVE_KID: "grant_2026_09"
    }, "Production requires an evidence-encryption key ring"]
  ])("fails closed for an unsafe production configuration", (overrides, expected) => {
    const result = loadConfig(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
  });

  it("accepts Redis, PostgreSQL, and explicit active signing and encryption keys", () => {
    const result = loadConfig({
      ACTIONGATE_STORAGE: "redis",
      ACTIONGATE_CONTROL_PLANE: "postgres",
      ACTIONGATE_GRANT_KEYS: validGrantRing,
      ACTIONGATE_GRANT_ACTIVE_KID: "grant_2026_09",
      ACTIONGATE_EVIDENCE_KEYS: validEvidenceRing,
      ACTIONGATE_EVIDENCE_ACTIVE_KID: "evidence_2026_09"
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects malformed key rings and unknown active key IDs", () => {
    const productionStorage = { ACTIONGATE_STORAGE: "redis", ACTIONGATE_CONTROL_PLANE: "postgres" };
    const malformed = loadConfig({ ...productionStorage, ACTIONGATE_GRANT_KEYS: "not-json" });
    expect(malformed.stderr).toContain("ACTIONGATE_GRANT_KEYS must be a JSON object");

    const unknownActiveKey = loadConfig({
      ...productionStorage,
      ACTIONGATE_GRANT_KEYS: validGrantRing,
      ACTIONGATE_GRANT_ACTIVE_KID: "missing"
    });
    expect(unknownActiveKey.stderr).toContain("ACTIONGATE_GRANT_ACTIVE_KID is not present");
  });

  it("rejects a fact-provider token without a provider URL", () => {
    const result = loadConfig({
      ACTIONGATE_STORAGE: "redis",
      ACTIONGATE_CONTROL_PLANE: "postgres",
      ACTIONGATE_GRANT_KEYS: validGrantRing,
      ACTIONGATE_GRANT_ACTIVE_KID: "grant_2026_09",
      ACTIONGATE_EVIDENCE_KEYS: validEvidenceRing,
      ACTIONGATE_EVIDENCE_ACTIVE_KID: "evidence_2026_09",
      ACTIONGATE_FACT_PROVIDER_TOKEN: "orphaned-token"
    });
    expect(result.stderr).toContain("ACTIONGATE_FACT_PROVIDER_TOKEN requires ACTIONGATE_FACT_PROVIDER_URL");
  });
});

function loadConfig(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./apps/api/src/config.ts')"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      DOTENV_CONFIG_PATH: "/tmp/actiongate-config-test-no-env",
      ...overrides
    }
  });
}
