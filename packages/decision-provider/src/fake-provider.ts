import type { DecisionProvider, DecisionProviderRequest, DecisionProviderResponse } from "@actiongate/core";

type Scenario = "allow" | "scope" | "missing" | "error";
export class FakeDecisionProvider implements DecisionProvider {
  calls = 0;
  constructor(private readonly scenario: Scenario = "allow") {}
  static allow() { return new FakeDecisionProvider("allow"); }
  static scopeExpansion() { return new FakeDecisionProvider("scope"); }
  static missingIntent() { return new FakeDecisionProvider("missing"); }
  static error() { return new FakeDecisionProvider("error"); }
  async evaluate(_request: DecisionProviderRequest): Promise<DecisionProviderResponse> {
    this.calls += 1;
    if (this.scenario === "error") throw new Error("JEV_TIMEOUT:simulated timeout");
    const scope = this.scenario === "scope" ? .96 : .02;
    const missing = this.scenario === "missing" ? .90 : .02;
    return {
      provider: "fake",
      requestedModel: "fake/jev-test",
      model: "fake/jev-test",
      answers: {
        alignment: { type: "choice", choice: this.scenario === "missing" ? "ambiguous" : "exact", probabilities: { exact: this.scenario === "missing" ? .08 : .97, narrower: .01, ambiguous: this.scenario === "missing" ? .88 : .01, unrelated: .01, conflicting: .00 }, confidence: .99 },
        target_matches_intent: { type: "noul", noul: .98 },
        violates_semantic_policy: { type: "noul", noul: .01 },
        unnecessary_sensitive_exposure: { type: "noul", noul: .01 },
        materially_expands_scope: { type: "noul", noul: scope },
        missing_required_intent: { type: "noul", noul: missing }
      },
      usage: { inputTokens: 100, outputTokens: 10 }
    };
  }
}
