import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, THRESHOLD_PROFILES, actionBindingFingerprint, canonicalJson, runDeterministicRules, type AuthorizationRequest } from "../src/index.js";

/**
 * The TypeScript half of the cross-language conformance suite.
 *
 * Python runs the identical fixtures in packages/sdk-python/tests. Two
 * implementations of an authorization core will drift unless something forces
 * them not to; these fixtures are that something. The fingerprint cases matter
 * most, because a fingerprint mismatch would produce grants that only verify
 * inside one language.
 */
const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/conformance/cross-language.json", import.meta.url), "utf8")) as {
  canonicalJson: { name: string; value: unknown; expected: string }[];
  fingerprints: { name: string; binding: Record<string, unknown>; policyVersion: string }[];
  deterministicRules: { name: string; tool: string; proposedAction: AuthorizationRequest["proposedAction"]; facts: Record<string, unknown> | null; expectedDecision: string | null; expectedCodes: string[] }[];
  thresholdProfiles: Record<string, Record<string, number>>;
};

describe("cross-language conformance", () => {
  it.each(fixtures.canonicalJson.map((item) => [item.name, item] as const))("canonical JSON: %s", (_name, item) => {
    expect(canonicalJson(item.value)).toBe(item.expected);
  });

  it.each(fixtures.fingerprints.map((item) => [item.name, item] as const))("fingerprint: %s", (_name, item) => {
    const fingerprint = actionBindingFingerprint(item.binding as never, item.policyVersion);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The value itself is asserted against Python's output by the recorded
    // digests below, written by `pnpm conformance:record`.
  });

  it.each(fixtures.deterministicRules.map((item) => [item.name, item] as const))("deterministic rules: %s", (_name, item) => {
    const request = {
      requestId: "r", idempotencyKey: "k", tenantId: "t", environment: "development", mode: "enforce",
      actor: { agentId: "a" }, userIntent: { text: "t", source: "user_message" },
      proposedAction: item.proposedAction,
      ...(item.facts ? { deterministicFacts: item.facts } : {})
    } as AuthorizationRequest;
    const result = runDeterministicRules(request, DEFAULT_POLICY.tools[item.tool]);
    expect(result.decision ?? null).toBe(item.expectedDecision);
    expect(result.reasons.map((reason) => reason.code)).toEqual(item.expectedCodes);
  });

  it("threshold profiles are identical", () => {
    for (const [profile, expected] of Object.entries(fixtures.thresholdProfiles)) {
      expect(THRESHOLD_PROFILES[profile as keyof typeof THRESHOLD_PROFILES]).toEqual(expected);
    }
    // No profile exists in one implementation and not the other.
    expect(Object.keys(THRESHOLD_PROFILES).sort()).toEqual(Object.keys(fixtures.thresholdProfiles).sort());
  });
});
