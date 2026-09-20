import { describe, expect, it } from "vitest";
import { createScriptedGate, runConformance, type AdapterUnderTest, type ScriptedGate } from "@actiongate/conformance";

/** A correctly implemented guard adapter: authorize, consume, then execute. */
function correctAdapter(gate: ScriptedGate): AdapterUnderTest {
  return {
    name: "correct-guard",
    level: "guard",
    async attempt({ tool, arguments: args }) {
      try {
        const decision = await gate.authorize(request(tool, args));
        if (decision.decision !== "ALLOW") return { executed: false };
        if (!decision.grant) return { executed: false };
        await gate.consumeGrant({ token: decision.grant.token });
        return { executed: true };
      } catch (error) {
        return { executed: false, detail: error };
      }
    }
  };
}

/** Executes first and checks afterwards, which is the mistake this suite exists to catch. */
function executesBeforeCheckingAdapter(gate: ScriptedGate): AdapterUnderTest {
  return {
    name: "executes-first",
    level: "guard",
    async attempt({ tool, arguments: args }) {
      const executed = true;
      try {
        const decision = await gate.authorize(request(tool, args));
        if (decision.grant) await gate.consumeGrant({ token: decision.grant.token });
      } catch { /* swallowed, which is the bug */ }
      return { executed };
    }
  };
}

/** Treats REVIEW as good enough, and ignores a failed consumption. */
function reviewIsFineAdapter(gate: ScriptedGate): AdapterUnderTest {
  return {
    name: "review-is-fine",
    level: "guard",
    async attempt({ tool, arguments: args }) {
      try {
        const decision = await gate.authorize(request(tool, args));
        if (decision.decision === "BLOCK") return { executed: false };
        if (decision.grant) {
          try { await gate.consumeGrant({ token: decision.grant.token }); } catch { /* ignored, which is the bug */ }
        }
        return { executed: true };
      } catch {
        return { executed: false };
      }
    }
  };
}

function request(tool: string, args: Record<string, unknown>) {
  return {
    requestId: "conformance",
    idempotencyKey: "conformance-key-0001",
    tenantId: "conformance",
    environment: "development" as const,
    mode: "enforce" as const,
    actor: { agentId: "conformance" },
    userIntent: { text: "do the thing", source: "user_message" as const },
    proposedAction: { tool, operation: "call", arguments: args, riskClass: "FINANCIAL" as const }
  };
}

describe("conformance suite", () => {
  it("passes a correctly implemented guard adapter", async () => {
    const gate = createScriptedGate();
    const result = await runConformance(correctAdapter(gate), gate);
    expect(result.conformant).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(5);
  });

  it("catches an adapter that executes before checking", async () => {
    const gate = createScriptedGate();
    const result = await runConformance(executesBeforeCheckingAdapter(gate), gate);
    expect(result.conformant).toBe(false);
    const failures = result.checks.filter((check) => check.status === "fail").map((check) => check.id);
    expect(failures).toContain("no-execute-on-block");
    expect(failures).toContain("no-execute-when-unavailable");
  });

  it("catches an adapter that treats REVIEW as allow or ignores a failed consumption", async () => {
    const gate = createScriptedGate();
    const result = await runConformance(reviewIsFineAdapter(gate), gate);
    expect(result.conformant).toBe(false);
    const failures = result.checks.filter((check) => check.status === "fail").map((check) => check.id);
    expect(failures).toContain("no-execute-on-review");
    expect(failures).toContain("no-execute-without-grant");
    expect(failures).toContain("no-execute-when-consume-fails");
  });

  it("skips enforcement checks for an adapter that only claims observe", async () => {
    const gate = createScriptedGate();
    const adapter = { ...correctAdapter(gate), level: "observe" as const, name: "observer" };
    const result = await runConformance({ ...adapter, attempt: async () => ({ executed: true }) }, gate);
    expect(result.conformant).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.checks.find((check) => check.id === "no-execute-on-block")?.status).toBe("skip");
  });

  it("fails an observe adapter that actually blocks, since the level is wrong", async () => {
    const gate = createScriptedGate();
    const result = await runConformance({ name: "mislabelled", level: "observe", attempt: async () => ({ executed: false }) }, gate);
    expect(result.conformant).toBe(false);
    expect(result.checks.find((check) => check.id === "observe-never-blocks")?.error).toMatch(/label it guard/);
  });

  it("reports the reason a check failed rather than just a count", async () => {
    const gate = createScriptedGate();
    const result = await runConformance(executesBeforeCheckingAdapter(gate), gate);
    const failure = result.checks.find((check) => check.status === "fail");
    expect(failure?.error).toBeTruthy();
    expect(failure?.title).toBeTruthy();
  });
});
