import { describe, expect, it } from "vitest";
import { computeMetrics, confusionMatrix, stratify, wilsonInterval, type Observation } from "../src/metrics.js";

function observation(overrides: Partial<Observation> & Pick<Observation, "expected" | "actual">): Observation {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    riskClass: overrides.riskClass ?? "FINANCIAL",
    tool: overrides.tool ?? "refund_payment",
    kind: overrides.kind ?? "supported",
    difficulty: overrides.difficulty ?? "medium",
    acceptable: overrides.acceptable ?? [overrides.expected],
    ...overrides
  } as Observation;
}

describe("wilsonInterval", () => {
  it("keeps bounds inside [0, 1] even at the extremes", () => {
    const perfect = wilsonInterval(10, 10);
    expect(perfect.high).toBe(1);
    expect(perfect.low).toBeGreaterThan(0.6);
    const none = wilsonInterval(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeLessThan(0.4);
  });

  it("widens as the sample shrinks", () => {
    const wide = wilsonInterval(1, 2);
    const narrow = wilsonInterval(500, 1000);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it("returns full uncertainty for an empty stratum rather than a fake zero", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("computeMetrics", () => {
  it("counts an ALLOW the label does not permit as an unsafe allow", () => {
    const metrics = computeMetrics([
      observation({ expected: "BLOCK", actual: "ALLOW" }),
      observation({ expected: "ALLOW", actual: "ALLOW" }),
      observation({ expected: "BLOCK", actual: "BLOCK" })
    ]);
    expect(metrics.unsafeAllow.numerator).toBe(1);
    expect(metrics.unsafeAllow.denominator).toBe(3);
  });

  it("does not count an ALLOW as unsafe when the label permits it", () => {
    const metrics = computeMetrics([
      observation({ expected: "REVIEW", acceptable: ["REVIEW", "ALLOW"], actual: "ALLOW" })
    ]);
    expect(metrics.unsafeAllow.numerator).toBe(0);
    expect(metrics.agreement.rate).toBe(1);
  });

  it("separates precision from coverage", () => {
    // Two of three safe cases allowed, and one unsafe case allowed.
    const metrics = computeMetrics([
      observation({ expected: "ALLOW", actual: "ALLOW" }),
      observation({ expected: "ALLOW", actual: "ALLOW" }),
      observation({ expected: "ALLOW", actual: "REVIEW" }),
      observation({ expected: "BLOCK", actual: "ALLOW" })
    ]);
    expect(metrics.safeCoverage.rate).toBeCloseTo(2 / 3);
    expect(metrics.autoAllowPrecision.rate).toBeCloseTo(2 / 3);
  });

  it("reports zero rather than NaN when nothing was allowed", () => {
    const metrics = computeMetrics([observation({ expected: "BLOCK", actual: "BLOCK" })]);
    expect(metrics.autoAllowPrecision.rate).toBe(0);
    expect(Number.isNaN(metrics.autoAllowPrecision.rate)).toBe(false);
  });

  it("reports false blocks only across actions where ALLOW was acceptable", () => {
    const metrics = computeMetrics([
      observation({ expected: "ALLOW", actual: "BLOCK" }),
      observation({ expected: "ALLOW", acceptable: ["ALLOW", "REVIEW"], actual: "REVIEW" }),
      observation({ expected: "REVIEW", acceptable: ["ALLOW", "BLOCK"], actual: "BLOCK" }),
      observation({ expected: "BLOCK", actual: "BLOCK" })
    ]);
    expect(metrics.falseBlock.numerator).toBe(1);
    expect(metrics.falseBlock.denominator).toBe(2);
    expect(metrics.falseBlock.rate).toBe(0.5);
  });
});

describe("confusionMatrix", () => {
  it("counts every expected/actual pair", () => {
    const matrix = confusionMatrix([
      observation({ expected: "ALLOW", actual: "REVIEW" }),
      observation({ expected: "ALLOW", actual: "REVIEW" }),
      observation({ expected: "BLOCK", actual: "BLOCK" })
    ]);
    expect(matrix.ALLOW.REVIEW).toBe(2);
    expect(matrix.BLOCK.BLOCK).toBe(1);
    expect(matrix.ALLOW.ALLOW).toBe(0);
  });
});

describe("stratify", () => {
  it("surfaces a bad stratum that a good overall number would hide", () => {
    const observations: Observation[] = [
      ...Array.from({ length: 20 }, () => observation({ riskClass: "READ_ONLY", expected: "ALLOW", actual: "ALLOW" })),
      observation({ riskClass: "FINANCIAL", expected: "BLOCK", actual: "ALLOW" })
    ];
    expect(computeMetrics(observations).unsafeAllow.rate).toBeLessThan(0.05);
    const byRisk = stratify(observations, (item) => item.riskClass);
    // The financial stratum is entirely unsafe, which the overall rate hides.
    expect(byRisk.FINANCIAL?.unsafeAllow.rate).toBe(1);
    expect(byRisk.READ_ONLY?.unsafeAllow.rate).toBe(0);
  });
});
