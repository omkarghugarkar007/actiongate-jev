import type { RiskClass } from "./contracts.js";

export interface ToolPolicy {
  enabled: boolean;
  operation: string;
  riskClass: RiskClass;
  hardRules?: {
    maxAmountCents?: number;
    allowedCurrencies?: string[];
    requireAuthenticatedUser?: boolean;
    requireRbac?: boolean;
    denyDuplicate?: boolean;
    requireAllowlistedDestination?: boolean;
  };
  semanticPolicy: string[];
  thresholdProfile: keyof typeof THRESHOLD_PROFILES;
}

export interface Policy {
  id: string;
  version: string;
  mode: "shadow" | "enforce";
  skipSemanticAfterHardReview?: boolean;
  requireHumanForRisk?: RiskClass[];
  tools: Record<string, ToolPolicy>;
}

export const THRESHOLD_PROFILES = {
  "read-only-v1": { alignmentMinConfidence: .75, targetYesMin: .65, policyViolationBlockAt: .90, sensitiveExposureBlockAt: .90, scopeExpansionBlockAt: .90, missingIntentReviewAt: .55 },
  "reversible-write-v1": { alignmentMinConfidence: .85, targetYesMin: .80, policyViolationBlockAt: .85, sensitiveExposureBlockAt: .85, scopeExpansionBlockAt: .85, missingIntentReviewAt: .45 },
  "financial-v1": { alignmentMinConfidence: .92, targetYesMin: .90, policyViolationBlockAt: .75, sensitiveExposureBlockAt: .80, scopeExpansionBlockAt: .80, missingIntentReviewAt: .35 },
  "destructive-v1": { alignmentMinConfidence: .97, targetYesMin: .95, policyViolationBlockAt: .65, sensitiveExposureBlockAt: .70, scopeExpansionBlockAt: .70, missingIntentReviewAt: .25 }
} as const;

export const DEFAULT_POLICY: Policy = {
  id: "support-agent-default",
  version: "1.0.0",
  mode: "shadow",
  tools: {
    refund_payment: {
      enabled: true,
      operation: "refund",
      riskClass: "FINANCIAL",
      hardRules: { maxAmountCents: 10_000, allowedCurrencies: ["USD"], requireAuthenticatedUser: true, requireRbac: true, denyDuplicate: true },
      semanticPolicy: [
        "Refund only when the user explicitly requests a refund or account credit.",
        "Refund only a transaction connected to the user's stated issue.",
        "Do not expand a refund to unrelated transactions."
      ],
      thresholdProfile: "financial-v1"
    },
    get_order: { enabled: true, operation: "read", riskClass: "READ_ONLY", semanticPolicy: ["Read only the order the user requested."], thresholdProfile: "read-only-v1" },
    send_email: { enabled: true, operation: "send", riskClass: "EXTERNAL_COMMUNICATION", semanticPolicy: ["Send only to recipients supported by the user's request."], thresholdProfile: "reversible-write-v1" },
    delete_record: { enabled: false, operation: "delete", riskClass: "DESTRUCTIVE", semanticPolicy: ["Delete only with explicit user authorization."], thresholdProfile: "destructive-v1" }
  }
};

