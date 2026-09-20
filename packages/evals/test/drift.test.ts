import { describe, expect, it } from "vitest";
import { detectDrift } from "../src/drift.js";
import type { CalibrationReport, ProfileReport } from "../src/calibrate.js";
import { computeMetrics, type Observation } from "../src/metrics.js";

function observations(unsafe: number, total: number, riskClass = "FINANCIAL"): Observation[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `case-${index}`,
    riskClass,
    kind: "supported",
    expected: index < unsafe ? "BLOCK" : "ALLOW",
    acceptable: index < unsafe ? ["BLOCK"] : ["ALLOW"],
    actual: "ALLOW"
  })) as Observation[];
}

function profile(name: string, unsafe: number, total: number): ProfileReport {
  const items = observations(unsafe, total);
  const metrics = computeMetrics(items);
  return { profile: name, thresholds: {}, overall: metrics, byRisk: { FINANCIAL: metrics }, byTool: { refund_payment: metrics }, byKind: {}, byDifficulty: {} };
}

function report(overrides: Partial<CalibrationReport> = {}, unsafe = 0, total = 100): CalibrationReport {
  const { versions: versionOverrides, ...rest } = overrides;
  return {
    runId: overrides.runId ?? "run-a",
    createdAt: new Date().toISOString(),
    dataset: { total, reviewed: total, generated: 0, disputed: 0, byKind: {}, byRisk: {}, byDifficulty: {} },
    evaluated: total,
    excludedUnreviewed: 0,
    cost: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
    latencyMs: { p50: 100, p95: 200, max: 300 },
    providerErrors: 0,
    profiles: [profile("financial-v1", unsafe, total)],
    qualityClaimSupported: true,
    note: "",
    ...rest,
    // Merged last so a partial override keeps the other pinned versions.
    versions: {
      dataset: "1.0.0", datasetName: "core", datasetHash: "hash-a",
      policy: "p@1.0.0", battery: "battery-v1",
      requestedModel: "typesafe/jev-1.13", resolvedModel: "typesafe/jev-1.13-20260917", provider: "openrouter",
      ...versionOverrides
    }
  } as CalibrationReport;
}

describe("detectDrift", () => {
  it("promotes an unchanged candidate", () => {
    const result = detectDrift(report({ runId: "a" }), report({ runId: "b" }));
    expect(result.promotable).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("blocks any increase in unsafe allows, however small", () => {
    const result = detectDrift(report({ runId: "a" }, 0, 100), report({ runId: "b" }, 1, 100));
    expect(result.promotable).toBe(false);
    expect(result.findings.some((finding) => finding.severity === "block" && /unsafe-allow/.test(finding.detail))).toBe(true);
  });

  it("blocks a comparison across different dataset content", () => {
    const candidate = report({ runId: "b", versions: { datasetHash: "hash-b" } as CalibrationReport["versions"] });
    const result = detectDrift(report({ runId: "a" }), candidate);
    expect(result.promotable).toBe(false);
    expect(result.findings.some((finding) => finding.kind === "dataset")).toBe(true);
  });

  it("refuses to gate on a run built from unreviewed labels", () => {
    const result = detectDrift(report({ runId: "a" }), report({ runId: "b", qualityClaimSupported: false }));
    expect(result.promotable).toBe(false);
    expect(result.findings.some((finding) => /no person reviewed/.test(finding.detail))).toBe(true);
  });

  it("reports a model change as a warning rather than silently tolerating it", () => {
    const candidate = report({ runId: "b", versions: { resolvedModel: "typesafe/jev-1.14-20261101" } as CalibrationReport["versions"] });
    const result = detectDrift(report({ runId: "a" }), candidate);
    expect(result.findings.some((finding) => finding.kind === "model" && finding.severity === "warn")).toBe(true);
    // A model change alone does not block; it is for a human to weigh.
    expect(result.promotable).toBe(true);
  });

  it("warns when review volume grows, since that is operator load", () => {
    const baseline = report({ runId: "a" });
    const candidate = report({ runId: "b" });
    candidate.profiles[0]!.overall.reviewRate = { numerator: 30, denominator: 100, rate: 0.3, interval: { low: 0.2, high: 0.4 } };
    const result = detectDrift(baseline, candidate);
    expect(result.findings.some((finding) => /review rate rose/.test(finding.detail))).toBe(true);
  });

  it("warns on a large cost or latency regression", () => {
    const candidate = report({ runId: "b", cost: { inputTokens: 100, outputTokens: 10, costUsd: 0.5 }, latencyMs: { p50: 100, p95: 900, max: 1000 } });
    const result = detectDrift(report({ runId: "a" }), candidate);
    expect(result.findings.filter((finding) => finding.kind === "cost" || finding.kind === "latency")).toHaveLength(2);
  });

  it("notes a profile with no baseline instead of comparing against nothing", () => {
    const candidate = report({ runId: "b" });
    candidate.profiles = [profile("destructive-v1", 0, 100)];
    const result = detectDrift(report({ runId: "a" }), candidate);
    expect(result.findings.some((finding) => /no baseline/.test(finding.detail))).toBe(true);
    expect(result.comparedProfiles).toEqual([]);
  });
});
