import type { AuthorizationRequest, AuthorizationResponse, RiskClass } from "@actiongate/core";

/**
 * Adapter conformance suite.
 *
 * A third-party adapter claims an integration level. This suite checks the claim
 * by driving the adapter against a scripted ActionGate and asserting that the
 * handler ran only when it should have.
 *
 * It is deliberately transport-agnostic: an adapter supplies one function that
 * attempts an action, and the suite controls what ActionGate says.
 */
export type IntegrationLevel = "observe" | "guard" | "isolate" | "govern";

export interface AttemptResult {
  /** True when the adapter reached the protected side effect. */
  executed: boolean;
  /** Anything the adapter surfaced; only used in failure messages. */
  detail?: unknown;
}

export interface AdapterUnderTest {
  name: string;
  level: IntegrationLevel;
  /**
   * Attempt one guarded action. The adapter must call the supplied ActionGate
   * endpoints rather than its own; the suite decides what they return.
   */
  attempt(input: { tool: string; arguments: Record<string, unknown>; intent?: string }): Promise<AttemptResult>;
  /** Called between checks so state such as consumed grants does not leak across them. */
  reset?(): Promise<void>;
}

export type ScriptedDecision =
  | { kind: "allow-with-grant" }
  | { kind: "allow-without-grant" }
  | { kind: "deny"; decision: "BLOCK" | "REVIEW" }
  | { kind: "consume-fails" }
  | { kind: "unavailable" };

export interface ScriptedGate {
  /** Set what the next authorization will do. */
  script(decision: ScriptedDecision): void;
  /** How many times a grant was consumed. */
  consumeCount(): number;
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
  consumeGrant(request: unknown): Promise<unknown>;
}

const GRANT_TOKEN = "conformance-grant-token";

/** A controllable stand-in for the ActionGate API. */
export function createScriptedGate(): ScriptedGate {
  let next: ScriptedDecision = { kind: "allow-with-grant" };
  let consumed = 0;

  return {
    script(decision) { next = decision; },
    consumeCount() { return consumed; },
    async authorize(request) {
      if (next.kind === "unavailable") throw new Error("ActionGate is unreachable");
      const base: AuthorizationResponse = {
        requestId: request.requestId,
        decisionId: "00000000-0000-4000-8000-000000000000",
        decision: "ALLOW",
        mode: request.mode,
        riskClass: request.proposedAction.riskClass,
        reasons: [{ code: "POLICY_SATISFIED", message: "ok", source: "SYSTEM" }],
        signals: { deterministic: {} },
        timing: { totalMs: 1, deterministicMs: 1 },
        policy: { id: "conformance", version: "1.0.0" },
        createdAt: new Date().toISOString()
      };
      if (next.kind === "deny") {
        return { ...base, decision: next.decision, reasons: [{ code: "RBAC_DENIED", message: "denied", source: "DETERMINISTIC" }] };
      }
      if (next.kind === "allow-without-grant") return base;
      return { ...base, grant: { token: GRANT_TOKEN, grantId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 30_000).toISOString() } };
    },
    async consumeGrant() {
      if (next.kind === "consume-fails") throw new Error("GRANT_ALREADY_CONSUMED");
      consumed += 1;
      return { grantId: "11111111-1111-4111-8111-111111111111", decisionId: "00000000-0000-4000-8000-000000000000", status: "CONSUMED", consumedAt: new Date().toISOString() };
    }
  };
}

export interface ConformanceCheck {
  id: string;
  title: string;
  /** Levels this check applies to. */
  levels: readonly IntegrationLevel[];
  run(adapter: AdapterUnderTest, gate: ScriptedGate): Promise<void>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const CHECKS: ConformanceCheck[] = [
  {
    id: "executes-on-allow",
    title: "Executes when ActionGate allows and a grant is consumed",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "allow-with-grant" });
      const result = await adapter.attempt({ tool: "get_order", arguments: { orderId: "1" } });
      assert(result.executed, "An allowed action must reach the handler, or the adapter is unusable");
    }
  },
  {
    id: "consumes-exactly-once",
    title: "Consumes exactly one grant per allowed action",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "allow-with-grant" });
      const before = gate.consumeCount();
      await adapter.attempt({ tool: "get_order", arguments: { orderId: "1" } });
      assert(gate.consumeCount() === before + 1, `Expected exactly one consumption, saw ${gate.consumeCount() - before}`);
    }
  },
  {
    id: "no-execute-on-block",
    title: "Does not execute on BLOCK",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "deny", decision: "BLOCK" });
      const result = await adapter.attempt({ tool: "refund_payment", arguments: { amountCents: 4900 } });
      assert(!result.executed, "A BLOCK reached the handler");
    }
  },
  {
    id: "no-execute-on-review",
    title: "Does not execute on REVIEW",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "deny", decision: "REVIEW" });
      const result = await adapter.attempt({ tool: "refund_payment", arguments: { amountCents: 4900 } });
      assert(!result.executed, "A REVIEW reached the handler; review is not a soft allow");
    }
  },
  {
    id: "no-execute-without-grant",
    title: "Does not execute when an enforced allow carries no grant",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "allow-without-grant" });
      const result = await adapter.attempt({ tool: "refund_payment", arguments: { amountCents: 4900 } });
      assert(!result.executed, "An allow without a grant reached the handler");
    }
  },
  {
    id: "no-execute-when-consume-fails",
    title: "Does not execute when consumption fails",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "consume-fails" });
      const result = await adapter.attempt({ tool: "refund_payment", arguments: { amountCents: 4900 } });
      assert(!result.executed, "The handler ran even though the permit was never spent");
    }
  },
  {
    id: "no-execute-when-unavailable",
    title: "Fails closed when ActionGate is unreachable",
    levels: ["guard", "isolate"],
    async run(adapter, gate) {
      gate.script({ kind: "unavailable" });
      const result = await adapter.attempt({ tool: "refund_payment", arguments: { amountCents: 4900 } });
      assert(!result.executed, "An unreachable ActionGate must deny, not wave the action through");
    }
  },
  {
    id: "observe-never-blocks",
    title: "An observe adapter reports without controlling execution",
    levels: ["observe"],
    async run(adapter, gate) {
      gate.script({ kind: "deny", decision: "BLOCK" });
      const result = await adapter.attempt({ tool: "get_order", arguments: { orderId: "1" } });
      assert(result.executed, "An observe adapter must not claim to enforce; label it guard if it blocks");
    }
  }
];

export interface ConformanceResult {
  adapter: string;
  level: IntegrationLevel;
  passed: number;
  failed: number;
  skipped: number;
  checks: { id: string; title: string; status: "pass" | "fail" | "skip"; error?: string }[];
  conformant: boolean;
}

/** Runs every check that applies to the adapter's claimed level. */
export async function runConformance(adapter: AdapterUnderTest, gate: ScriptedGate = createScriptedGate()): Promise<ConformanceResult> {
  const checks: ConformanceResult["checks"] = [];
  for (const check of CHECKS) {
    if (!check.levels.includes(adapter.level)) {
      checks.push({ id: check.id, title: check.title, status: "skip" });
      continue;
    }
    await adapter.reset?.();
    try {
      await check.run(adapter, gate);
      checks.push({ id: check.id, title: check.title, status: "pass" });
    } catch (error) {
      checks.push({ id: check.id, title: check.title, status: "fail", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  return {
    adapter: adapter.name,
    level: adapter.level,
    passed: checks.filter((check) => check.status === "pass").length,
    failed,
    skipped: checks.filter((check) => check.status === "skip").length,
    checks,
    conformant: failed === 0
  };
}

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = CHECKS;
export { GRANT_TOKEN as CONFORMANCE_GRANT_TOKEN };
export type { RiskClass };
