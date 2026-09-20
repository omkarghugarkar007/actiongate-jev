import { z } from "zod";

export const RiskClassSchema = z.enum([
  "READ_ONLY",
  "REVERSIBLE_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL",
  "DESTRUCTIVE",
  "CREDENTIAL_OR_SECRET"
]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const AuthorizationDecisionSchema = z.enum(["ALLOW", "REVIEW", "BLOCK"]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;

export const AuthorizationRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(8).max(255),
  tenantId: z.string().min(1).max(128),
  environment: z.enum(["development", "staging", "production"]),
  mode: z.enum(["shadow", "enforce"]),
  actor: z.object({
    agentId: z.string().min(1).max(128),
    userId: z.string().max(255).optional(),
    sessionId: z.string().max(255).optional()
  }).strict(),
  userIntent: z.object({
    text: z.string().min(1).max(16_000),
    source: z.enum(["user_message", "workflow", "operator"])
  }).strict(),
  proposedAction: z.object({
    tool: z.string().min(1).max(128),
    operation: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
    riskClass: RiskClassSchema
  }).strict(),
  context: z.object({
    conversationExcerpt: z.array(z.object({
      role: z.enum(["user", "assistant", "tool"]),
      content: z.string().max(4000)
    })).max(8).optional(),
    resources: z.record(z.string(), z.unknown()).optional(),
    currentState: z.record(z.string(), z.unknown()).optional()
  }).strict().optional(),
  deterministicFacts: z.object({
    authenticated: z.boolean().optional(),
    authorizedByRbac: z.boolean().optional(),
    duplicate: z.boolean().optional(),
    amountCents: z.number().int().nonnegative().optional(),
    currency: z.string().max(3).optional(),
    destinationAllowlisted: z.boolean().optional(),
    resourceExists: z.boolean().optional()
  }).strict().optional(),
  policyVersion: z.string().max(64).optional()
}).strict();

export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

export const ActionGrantSchema = z.object({
  token: z.string().min(1).max(8192),
  grantId: z.string().uuid(),
  expiresAt: z.string().datetime()
}).strict();
export type ActionGrant = z.infer<typeof ActionGrantSchema>;

export const ActionGrantConsumeRequestSchema = z.object({
  token: z.string().min(1).max(8192),
  tenantId: z.string().min(1).max(128),
  environment: z.enum(["development", "staging", "production"]),
  actor: z.object({
    agentId: z.string().min(1).max(128),
    userId: z.string().max(255).optional(),
    sessionId: z.string().max(255).optional()
  }).strict(),
  proposedAction: z.object({
    tool: z.string().min(1).max(128),
    operation: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
    riskClass: RiskClassSchema
  }).strict()
}).strict();
export type ActionGrantConsumeRequest = z.infer<typeof ActionGrantConsumeRequestSchema>;

export const ActionGrantConsumeResponseSchema = z.object({
  grantId: z.string().uuid(),
  decisionId: z.string().uuid(),
  status: z.literal("CONSUMED"),
  consumedAt: z.string().datetime()
}).strict();
export type ActionGrantConsumeResponse = z.infer<typeof ActionGrantConsumeResponseSchema>;

export type Reason = {
  code: string;
  message: string;
  source: "DETERMINISTIC" | "JEV" | "SYSTEM";
};

export interface AuthorizationResponse {
  requestId: string;
  decisionId: string;
  decision: AuthorizationDecision;
  mode: "shadow" | "enforce";
  wouldHaveDecision?: AuthorizationDecision;
  riskClass: RiskClass;
  reasons: Reason[];
  signals: {
    deterministic: Record<string, boolean | number | string | null>;
    semantic?: Record<string, unknown>;
  };
  model?: {
    provider: string;
    requestedModel: string;
    resolvedModel?: string;
    usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined };
  };
  timing: { totalMs: number; deterministicMs: number; semanticMs?: number };
  policy: { id: string; version: string };
  createdAt: string;
  grant?: ActionGrant;
}

export type NoulQuestion = {
  type: "noul";
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: { true?: string | Record<string, unknown>; false?: string | Record<string, unknown> };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: Record<string, string | Record<string, unknown> | null>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: Array<string | Record<string, unknown>>;
};
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export interface DecisionProviderRequest { state: unknown; questions: Record<string, DecisionQuestion> }
export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> | undefined };
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export interface DecisionProviderResponse {
  provider: string;
  /** Provider-specific model identifier sent on the request. */
  requestedModel?: string;
  /** Concrete model identifier returned by the provider. */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined };
  metadata?: Record<string, unknown>;
}
export interface DecisionProvider {
  evaluate(request: DecisionProviderRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DecisionProviderResponse>;
}
