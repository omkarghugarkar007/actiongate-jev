import { describe, expect, it } from "vitest";
import { validateConnectorManifest } from "@actiongate/connector-manifest";

const base = {
  name: "@actiongate/example",
  version: "0.1.0",
  level: "guard" as const,
  summary: "An example connector used only in tests.",
  protects: "The private handler behind the wrapper function.",
  bypass: ["Anything calling the handler directly is unguarded."],
  requires: { providerKey: false, redis: false, postgres: false, minimumTier: 0 },
  tools: [{ name: "get_order", operation: "read" }],
  facts: [],
  setup: { steps: 2, requiredSettings: 0 },
  negativeTests: ["BLOCK never calls the handler"]
};

function check(overrides: Record<string, unknown>) {
  return validateConnectorManifest({ ...base, ...overrides });
}

describe("connector manifest", () => {
  it("accepts a complete manifest", () => {
    expect(validateConnectorManifest(base).valid).toBe(true);
  });

  it("refuses an empty bypass statement", () => {
    const result = check({ bypass: [] });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((issue) => issue.path === "bypass")).toBe(true);
  });

  it("refuses unknown fields so a manifest cannot quietly carry extra claims", () => {
    expect(validateConnectorManifest({ ...base, securityGuarantee: "total" }).valid).toBe(false);
  });

  it("makes an isolate connector say what network path or credential it owns", () => {
    const vague = check({ level: "isolate", protects: "The important parts of the system." });
    expect(vague.valid).toBe(false);
    const specific = check({ level: "isolate", protects: "The upstream endpoint and its credential." });
    expect(specific.valid).toBe(true);
  });

  it("makes a guard connector declare its tools", () => {
    expect(check({ tools: [] }).valid).toBe(false);
  });

  it("holds Tier 0 to no settings and no infrastructure", () => {
    expect(check({ setup: { steps: 2, requiredSettings: 1 } }).valid).toBe(false);
    expect(check({ requires: { providerKey: true, redis: false, postgres: false, minimumTier: 0 } }).valid).toBe(false);
  });

  it("requires a preset once configuration grows past three settings", () => {
    const knobs = check({
      requires: { providerKey: false, redis: false, postgres: false, minimumTier: 1 },
      setup: { steps: 3, requiredSettings: 4 }
    });
    expect(knobs.valid).toBe(false);
    const preset = check({
      requires: { providerKey: false, redis: false, postgres: false, minimumTier: 1 },
      setup: { steps: 3, requiredSettings: 4, presetName: "sidecar" }
    });
    expect(preset.valid).toBe(true);
  });

  it("refuses an adapter claiming it resolves trusted facts", () => {
    // Only the API side can make a fact trusted; an adapter is a client.
    const result = check({ facts: [{ fact: "authorizedByRbac", origin: "trusted-provider", source: "itself" }] });
    expect(result.valid).toBe(false);
  });

  it("reports every problem at once rather than one at a time", () => {
    const result = validateConnectorManifest({ ...base, bypass: [], negativeTests: [], version: "not-semver" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path).sort()).toEqual(["bypass", "negativeTests", "version"]);
    }
  });

  it("does not mistake a word containing \"port\" for a real isolation claim", () => {
    expect(check({ level: "isolate", protects: "The important parts of the system." }).valid).toBe(false);
  });
});
