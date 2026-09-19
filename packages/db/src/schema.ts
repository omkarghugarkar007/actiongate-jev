import { bigint, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", { id: uuid("id").primaryKey().defaultRandom(), name: text("name").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const apiKeys = pgTable("api_keys", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").references(() => tenants.id).notNull(), keyPrefix: text("key_prefix").notNull(), keyHash: text("key_hash").notNull(), environment: text("environment").notNull(), revokedAt: timestamp("revoked_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, (t) => [index("api_keys_prefix_idx").on(t.keyPrefix)]);
export const policies = pgTable("policies", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").references(() => tenants.id).notNull(), name: text("name").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const policyVersions = pgTable("policy_versions", { id: uuid("id").primaryKey().defaultRandom(), policyId: uuid("policy_id").references(() => policies.id).notNull(), version: text("version").notNull(), documentJson: jsonb("document_json").notNull(), checksum: text("checksum").notNull(), createdBy: text("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, (t) => [uniqueIndex("policy_version_unique").on(t.policyId, t.version)]);
export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey(), requestId: text("request_id").notNull(), idempotencyKey: text("idempotency_key").notNull(), tenantId: uuid("tenant_id").references(() => tenants.id).notNull(), environment: text("environment").notNull(), mode: text("mode").notNull(), agentId: text("agent_id").notNull(), userIdHash: text("user_id_hash"), sessionIdHash: text("session_id_hash"), tool: text("tool").notNull(), operation: text("operation").notNull(), riskClass: text("risk_class").notNull(), decision: text("decision").notNull(), wouldHaveDecision: text("would_have_decision"), policyId: uuid("policy_id").references(() => policies.id).notNull(), policyVersionId: uuid("policy_version_id").references(() => policyVersions.id).notNull(), requestedModel: text("requested_model"), resolvedModel: text("resolved_model"), inputTokens: bigint("input_tokens", { mode: "number" }), outputTokens: bigint("output_tokens", { mode: "number" }), costUsd: numeric("cost_usd", { precision: 18, scale: 12 }), totalMs: bigint("total_ms", { mode: "number" }).notNull(), deterministicMs: bigint("deterministic_ms", { mode: "number" }).notNull(), semanticMs: bigint("semantic_ms", { mode: "number" }), requestFingerprint: text("request_fingerprint").notNull(), sanitizedRequestJson: jsonb("sanitized_request_json").notNull(), signalsJson: jsonb("signals_json").notNull(), reasonsJson: jsonb("reasons_json").notNull(), providerErrorCode: text("provider_error_code"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [uniqueIndex("decision_idempotency_unique").on(t.tenantId, t.environment, t.idempotencyKey), index("decision_tenant_created_idx").on(t.tenantId, t.createdAt)]);
export const actionGrants = pgTable("action_grants", {
  id: uuid("id").primaryKey(),
  decisionId: uuid("decision_id").references(() => decisions.id).notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  tokenHash: text("token_hash").notNull(),
  actionFingerprint: text("action_fingerprint").notNull(),
  claimsJson: jsonb("claims_json").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex("action_grants_decision_unique").on(t.decisionId),
  uniqueIndex("action_grants_token_hash_unique").on(t.tokenHash),
  index("action_grants_tenant_expires_idx").on(t.tenantId, t.expiresAt)
]);
export const overrides = pgTable("overrides", { id: uuid("id").primaryKey().defaultRandom(), decisionId: uuid("decision_id").references(() => decisions.id).notNull(), correctDecision: text("correct_decision").notNull(), reason: text("reason").notNull(), createdBy: text("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const evalCases = pgTable("eval_cases", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").references(() => tenants.id), dataset: text("dataset").notNull(), inputJson: jsonb("input_json").notNull(), expectedDecision: text("expected_decision").notNull(), expectedSignalConstraintsJson: jsonb("expected_signal_constraints_json"), tagsJson: jsonb("tags_json").notNull(), source: text("source").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const evalRuns = pgTable("eval_runs", { id: uuid("id").primaryKey().defaultRandom(), model: text("model").notNull(), policyVersion: text("policy_version").notNull(), thresholdProfile: text("threshold_profile").notNull(), dataset: text("dataset").notNull(), metricsJson: jsonb("metrics_json").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
