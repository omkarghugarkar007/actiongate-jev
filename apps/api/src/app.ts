import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { Ajv, type ValidateFunction } from "ajv";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { z } from "zod";
import {
  ActionGrantConsumeRequestSchema,
  ActionGrantError,
  ActionGrantSigner,
  AuthorizationEngine,
  type TrustedFactProvider,
  type CredentialIssuer,
  AuthorizationRequestSchema,
  PolicySchema,
  RiskClassSchema,
  redactSecrets,
  signExport,
  type AuthorizationRequest,
  type DecisionProvider,
  type Policy
} from "@actiongate/core";
import { FakeDecisionProvider, OpenRouterJevProvider } from "@actiongate/decision-provider";
import { config } from "./config.js";
import { EvidenceCipher } from "./security/evidence-cipher.js";
import { AuthorizationService, IdempotencyBusyError, IdempotencyConflictError } from "./services/authorization-service.js";
import { ActionGrantService } from "./services/action-grant-service.js";
import {
  API_ROLES,
  InMemoryControlPlaneRepository,
  type ApiEnvironment,
  type ApiRole,
  type AuthPrincipal,
  type ControlPlaneRepository
} from "./services/control-plane.js";
import { PostgresControlPlaneRepository } from "./services/postgres-control-plane.js";
import { RedisDecisionRepository, RedisGrantRepository } from "./services/redis-repository.js";
import type { WebhookNotifier } from "./services/webhooks.js";
import { Telemetry } from "./services/telemetry.js";
import { QuotaEnforcer, type TenantQuota } from "./services/quota.js";
import { InMemoryDecisionRepository, InMemoryGrantRepository, type DecisionRepository, type GrantRepository } from "./services/repository.js";

const EnvironmentSchema = z.enum(["development", "staging", "production"]);
const ApiRoleSchema = z.enum(API_ROLES);
const ToolInputSchema = z.object({
  operation: z.string().min(1).max(128),
  riskClass: RiskClassSchema,
  argumentSchema: z.record(z.string(), z.unknown()),
  owner: z.string().min(1).max(255),
  dataSensitivity: z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]),
  policyId: z.string().min(1).max(128),
  policyVersion: z.string().min(1).max(64),
  enabled: z.boolean()
}).strict();
const ApiKeyInputSchema = z.object({
  name: z.string().min(1).max(128),
  environment: EnvironmentSchema,
  roles: z.array(ApiRoleSchema).min(1).max(API_ROLES.length)
}).strict();
const OverrideInputSchema = z.object({
  correctDecision: z.enum(["ALLOW", "REVIEW", "BLOCK"]),
  reason: z.string().min(1).max(4000)
}).strict();
const ReviewInputSchema = z.object({
  decisionId: z.string().uuid(),
  reason: z.string().min(1).max(4000),
  assignee: z.string().min(1).max(255).optional(),
  expiresAt: z.string().datetime(),
  /** Two or more requires that many distinct reviewers before approval resolves. */
  requiredApprovals: z.number().int().min(1).max(5).optional()
}).strict();
const ReviewResolutionSchema = z.object({ decision: z.enum(["APPROVED", "DENIED"]) }).strict();
const ReviewClaimSchema = z.object({ assignee: z.string().min(1).max(255) }).strict();
/** A stored decision request, relaxed on the fields the approval path replaces. */
const RevalidationRequestSchema = AuthorizationRequestSchema.omit({ requestId: true, idempotencyKey: true })
  .extend({ requestId: z.string().optional(), idempotencyKey: z.string().optional() })
  .transform(({ requestId: _r, idempotencyKey: _i, ...rest }) => rest);
const ReviewEscalationSchema = z.object({ assignee: z.string().min(1).max(255), note: z.string().min(1).max(2000) }).strict();
const ExecutionInputSchema = z.object({
  decisionId: z.string().uuid(),
  grantId: z.string().uuid().optional(),
  status: z.enum(["ATTEMPTED", "COMPLETED", "FAILED", "REVERSED"]),
  detail: z.string().max(2000).optional(),
  externalRef: z.string().max(255).optional()
}).strict();
const GrantExchangeSchema = ActionGrantConsumeRequestSchema.extend({
  ttlSeconds: z.number().int().positive().max(3600).optional(),
  audience: z.string().min(1).max(255).optional()
}).strict();
const IncidentDisableSchema = z.object({ tools: z.array(z.string().min(1).max(128)).min(1).max(100) }).strict();
const SimulationSchema = z.object({
  request: AuthorizationRequestSchema.omit({ requestId: true, idempotencyKey: true, tenantId: true, environment: true, mode: true })
    .extend({ mode: z.enum(["shadow", "enforce"]).optional() }),
  /** A candidate policy to try. Omit to simulate against the tool's current one. */
  policy: PolicySchema.optional()
}).strict();
const IncidentRevokeSchema = z.object({ tool: z.string().min(1).max(128).optional() }).strict();

export interface BuildAppOptions {
  provider?: DecisionProvider;
  apiKey?: string;
  apiKeyTenantId?: string;
  apiKeyEnvironment?: ApiEnvironment;
  apiKeyRoles?: ApiRole[];
  controlPlane?: ControlPlaneRepository;
  controlPlaneStorage?: "memory" | "postgres";
  postgresPool?: Pool;
  databaseUrl?: string;
  grantSecret?: string;
  grantKeys?: ReadonlyArray<{ id: string; secret: string | Buffer }>;
  grantActiveKeyId?: string;
  evidenceKeys?: ReadonlyArray<{ id: string; secret: string | Buffer }>;
  evidenceActiveKeyId?: string;
  grantTtlSeconds?: number;
  clock?: () => number;
  logger?: boolean;
  rateLimitMax?: number;
  storage?: "memory" | "redis";
  redisUrl?: string;
  redisPrefix?: string;
  redisClient?: Redis;
  idempotencyLeaseMs?: number;
  idempotencyWaitMs?: number;
  /** Server-side providers that resolve deterministic facts ActionGate can vouch for. */
  factProviders?: readonly TrustedFactProvider[];
  /** Exchanges a consumed grant for a narrow, short-lived downstream credential. */
  credentialIssuer?: CredentialIssuer;
  /** Signed outbound notifications for decisions, reviews, and incidents. */
  notifier?: WebhookNotifier;
  /** Per-tenant rate limits and provider-cost budgets. */
  quotas?: Readonly<Record<string, TenantQuota>>;
  defaultQuota?: TenantQuota;
  /** Salt for hashing tenant ids in metric labels. Defaults to the grant secret. */
  metricsSalt?: string;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ["req.headers.authorization", "req.body.token", "req.body.proposedAction.arguments.password", "req.body.proposedAction.arguments.token"] } });
  const provider = options.provider ?? createProvider();
  const storage = options.storage ?? config.ACTIONGATE_STORAGE;
  const controlPlaneStorage = options.controlPlaneStorage ?? config.ACTIONGATE_CONTROL_PLANE;
  const grantSecret = options.grantSecret ?? config.ACTIONGATE_GRANT_SECRET;
  const evidenceKeyEntries = options.evidenceKeys ?? config.evidenceKeys;
  const evidenceActiveKeyId = options.evidenceActiveKeyId ?? config.ACTIONGATE_EVIDENCE_ACTIVE_KID;
  const evidenceCipher = evidenceKeyEntries.length > 0
    ? new EvidenceCipher(evidenceKeyEntries, evidenceActiveKeyId ?? evidenceKeyEntries[0]!.id)
    : new EvidenceCipher([{ id: "development", secret: grantSecret }], "development");

  let ownedRedis: Redis | undefined;
  let redis = options.redisClient;
  if (storage === "redis" && !redis) {
    ownedRedis = new Redis(options.redisUrl ?? config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis = ownedRedis;
  }
  const repositoryOptions = {
    prefix: options.redisPrefix ?? config.ACTIONGATE_REDIS_PREFIX,
    idempotencyLeaseMs: options.idempotencyLeaseMs ?? config.ACTIONGATE_IDEMPOTENCY_LEASE_MS,
    evidenceCipher
  };
  const decisions: DecisionRepository = storage === "redis" && redis ? new RedisDecisionRepository(redis, repositoryOptions) : new InMemoryDecisionRepository();
  const grants: GrantRepository = storage === "redis" && redis ? new RedisGrantRepository(redis, repositoryOptions) : new InMemoryGrantRepository();

  let ownedPostgres: Pool | undefined;
  let controlPlane = options.controlPlane;
  if (!controlPlane && controlPlaneStorage === "postgres") {
    ownedPostgres = options.postgresPool ?? new Pool({ connectionString: options.databaseUrl ?? config.DATABASE_URL, max: 10 });
    controlPlane = new PostgresControlPlaneRepository(ownedPostgres, evidenceCipher);
  }
  if (!controlPlane) {
    const localKey = options.apiKey ?? config.ACTIONGATE_API_KEY ?? "ag_test_local";
    controlPlane = new InMemoryControlPlaneRepository([{
      token: localKey,
      tenantId: options.apiKeyTenantId ?? config.ACTIONGATE_DEV_TENANT_ID,
      environment: options.apiKeyEnvironment ?? "development",
      roles: options.apiKeyRoles ?? [...API_ROLES]
    }]);
  }

  const service = new AuthorizationService(
    new AuthorizationEngine(provider, {
      timeoutMs: config.JEV_TIMEOUT_MS,
      failOpenReadOnly: config.failOpenReadOnly,
      ...(options.factProviders ? { factProviders: options.factProviders } : {})
    }),
    decisions,
    options.idempotencyWaitMs ?? config.ACTIONGATE_IDEMPOTENCY_WAIT_MS
  );
  const configuredGrantKeys = options.grantKeys ?? config.grantKeys;
  const signer = configuredGrantKeys.length > 0
    ? new ActionGrantSigner({
        keys: configuredGrantKeys,
        activeKeyId: options.grantActiveKeyId ?? config.ACTIONGATE_GRANT_ACTIVE_KID ?? configuredGrantKeys[0]!.id,
        ttlSeconds: options.grantTtlSeconds ?? config.ACTIONGATE_GRANT_TTL_SECONDS,
        ...(options.clock ? { clock: options.clock } : {})
      })
    : new ActionGrantSigner({ secret: grantSecret, ttlSeconds: options.grantTtlSeconds ?? config.ACTIONGATE_GRANT_TTL_SECONDS, ...(options.clock ? { clock: options.clock } : {}) });
  const grantService = new ActionGrantService(signer, grants, options.clock ?? Date.now);
  const principalByRequest = new WeakMap<FastifyRequest, AuthPrincipal>();
  const ajv = new Ajv({ allErrors: true, strict: true });
  const argumentValidators = new Map<string, ValidateFunction>();

  app.addHook("onClose", async () => {
    if (ownedRedis) {
      if (["wait", "end"].includes(ownedRedis.status)) ownedRedis.disconnect();
      else { try { await ownedRedis.quit(); } catch { ownedRedis.disconnect(); } }
    }
    if (ownedPostgres) await ownedPostgres.end();
  });

  app.register(cors, { origin: config.APP_URL });
  app.register(sensible);
  app.register(rateLimit, { max: options.rateLimitMax ?? 300, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url === "/ready") return;
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const principal = token ? await controlPlane!.authenticate(token) : undefined;
    if (!principal) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "A valid tenant-scoped API key is required." } });
    principalByRequest.set(request, principal);
  });

  const getPrincipal = (request: FastifyRequest) => {
    const principal = principalByRequest.get(request);
    if (!principal) throw new Error("AUTH_CONTEXT_MISSING");
    return principal;
  };
  const hasRole = (request: FastifyRequest, reply: FastifyReply, ...roles: ApiRole[]) => {
    const principal = getPrincipal(request);
    if (!roles.some((role) => principal.roles.includes(role))) {
      reply.code(403).send({ error: { code: "ROLE_FORBIDDEN", message: `One of these roles is required: ${roles.join(", ")}` } });
      return false;
    }
    return true;
  };
  const scopeRequest = (principal: AuthPrincipal, tenantId: string, environment: ApiEnvironment, reply: FastifyReply) => {
    if (tenantId !== principal.tenantId) { reply.code(403).send({ error: { code: "TENANT_SCOPE_VIOLATION" } }); return false; }
    if (environment !== principal.environment) { reply.code(403).send({ error: { code: "ENVIRONMENT_SCOPE_VIOLATION" } }); return false; }
    return true;
  };
  const registeredAction = async (principal: AuthPrincipal, request: AuthorizationRequest["proposedAction"], reply: FastifyReply) => {
    const tool = await controlPlane!.getTool(principal.tenantId, request.tool);
    if (!tool) { reply.code(404).send({ error: { code: "TOOL_NOT_REGISTERED" } }); return undefined; }
    if (!tool.enabled) { reply.code(403).send({ error: { code: "TOOL_DISABLED" } }); return undefined; }
    if (request.operation !== tool.operation || request.riskClass !== tool.riskClass) {
      reply.code(403).send({ error: { code: "TOOL_METADATA_MISMATCH", expected: { operation: tool.operation, riskClass: tool.riskClass } } });
      return undefined;
    }
    const cacheKey = `${principal.tenantId}:${tool.name}:${tool.updatedAt}`;
    let validator = argumentValidators.get(cacheKey);
    if (!validator) {
      try {
        const schemaIssue = closedObjectSchemaIssue(tool.argumentSchema);
        if (schemaIssue) throw new Error(schemaIssue);
        const compiled = ajv.compile(tool.argumentSchema);
        argumentValidators.set(cacheKey, compiled);
        validator = compiled;
      }
      catch { reply.code(503).send({ error: { code: "INVALID_REGISTERED_SCHEMA" } }); return undefined; }
    }
    if (!validator) return undefined;
    if (!validator(request.arguments)) {
      reply.code(400).send({ error: { code: "ACTION_ARGUMENTS_INVALID", issues: validator.errors } });
      return undefined;
    }
    return tool;
  };
  const audit = (principal: AuthPrincipal, eventType: string, objectId: string, payload: unknown) => controlPlane!.appendAuditEvent({
    tenantId: principal.tenantId, eventType, objectId, actorKeyId: principal.keyId, payload: redactSecrets(payload)
  });
  // Reuses the evidence key ring: an export attestation is audit evidence.
  const exportKeyEntry = evidenceKeyEntries.find((key) => key.id === (evidenceActiveKeyId ?? evidenceKeyEntries[0]?.id)) ?? evidenceKeyEntries[0];
  const exportKey = exportKeyEntry ? { id: exportKeyEntry.id, secret: exportKeyEntry.secret } : undefined;
  // Its own engine so a simulation can never touch stored decision state.
  const simulationEngine = new AuthorizationEngine(provider, {
    timeoutMs: config.JEV_TIMEOUT_MS,
    failOpenReadOnly: config.failOpenReadOnly,
    ...(options.factProviders ? { factProviders: options.factProviders } : {})
  });
  const telemetry = new Telemetry(options.metricsSalt ?? grantSecret);
  const quotas = new QuotaEnforcer(options.quotas ?? {}, options.defaultQuota ?? {}, options.clock ?? Date.now);
  const credentialIssuer = options.credentialIssuer;
  const notifier = options.notifier;
  /** Delivery is best-effort: a failing destination must never fail a decision. */
  const notify = async (event: { type: string; tenantId: string; objectId: string; payload: unknown }) => {
    if (!notifier) return;
    try { await notifier.notify({ ...event, payload: redactSecrets(event.payload) }); } catch { /* dead-lettered by the notifier */ }
  };

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/metrics", async (request, reply) => {
    // Role-gated: a scrape endpoint still exposes operational shape, and tenant
    // series are hashed rather than named.
    if (!hasRole(request, reply, "audit_exporter", "policy_admin")) return;
    return reply.header("Content-Type", "text/plain; version=0.0.4").send(telemetry.render());
  });
  app.get("/ready", async (_request, reply) => {
    try {
      if (decisions instanceof RedisDecisionRepository) await decisions.ping();
      if (controlPlane!.ping) await controlPlane!.ping();
    } catch { return reply.code(503).send({ status: "not_ready", storage, controlPlane: controlPlaneStorage }); }
    return { status: "ready", provider: config.DECISION_PROVIDER, storage, controlPlane: controlPlaneStorage };
  });

  app.post("/v1/authorize", async (request, reply) => {
    if (!hasRole(request, reply, "authorize")) return;
    const principal = getPrincipal(request);
    const parsed = AuthorizationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    if (!scopeRequest(principal, parsed.data.tenantId, parsed.data.environment, reply)) return;
    const headerKey = request.headers["idempotency-key"];
    if (headerKey && headerKey !== parsed.data.idempotencyKey) return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Header and body idempotency keys differ." } });
    const tenantLabel = telemetry.tenantLabel(principal.tenantId);

    // Quotas are checked before the registry lookup and before any provider
    // spend, so an over-quota tenant costs nothing.
    const rateDecision = quotas.checkAuthorize(principal.tenantId);
    if (!rateDecision.allowed) {
      telemetry.increment("actiongate_quota_rejections_total", "Requests rejected by a tenant quota.", { tenant: tenantLabel, reason: rateDecision.reason ?? "RATE_LIMIT" });
      return reply.code(429).header("Retry-After", String(rateDecision.retryAfterSeconds ?? 60)).send({ error: { code: rateDecision.reason } });
    }
    const costDecision = quotas.checkCostBudget(principal.tenantId);
    if (!costDecision.allowed) {
      telemetry.increment("actiongate_quota_rejections_total", "Requests rejected by a tenant quota.", { tenant: tenantLabel, reason: "COST_BUDGET" });
      return reply.code(429).header("Retry-After", String(costDecision.retryAfterSeconds ?? 3600)).send({ error: { code: "COST_BUDGET" } });
    }

    const tool = await registeredAction(principal, parsed.data.proposedAction, reply);
    if (!tool) return;
    if (parsed.data.policyVersion && parsed.data.policyVersion !== tool.policyVersion) return reply.code(403).send({ error: { code: "POLICY_VERSION_MISMATCH" } });
    const policy = await controlPlane.getPolicy(principal.tenantId, tool.policyId, tool.policyVersion);
    if (!policy) return reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } });
    const policyTool = policy.tools[tool.name];
    if (!policyTool || policyTool.operation !== tool.operation || policyTool.riskClass !== tool.riskClass) return reply.code(503).send({ error: { code: "CONTROL_PLANE_INCONSISTENT" } });
    const authorizedRequest: AuthorizationRequest = {
      ...parsed.data,
      tenantId: principal.tenantId,
      environment: principal.environment,
      policyVersion: tool.policyVersion,
      proposedAction: { ...parsed.data.proposedAction, tool: tool.name, operation: tool.operation, riskClass: tool.riskClass }
    };
    try {
      const response = await service.authorize(authorizedRequest, policy);
      const labels = { tenant: tenantLabel, decision: response.decision, risk: response.riskClass, mode: response.mode };
      telemetry.increment("actiongate_decisions_total", "Authorization decisions by outcome, risk, and mode.", labels);
      telemetry.observe("actiongate_decision_duration_ms", "End-to-end authorization latency in milliseconds.", response.timing.totalMs, { tenant: tenantLabel });
      if (response.timing.semanticMs != null) {
        telemetry.observe("actiongate_provider_duration_ms", "Decision-provider latency in milliseconds.", response.timing.semanticMs, { tenant: tenantLabel, provider: response.model?.provider ?? "none" });
      }
      if (response.model?.usage?.costUsd) {
        quotas.recordCost(principal.tenantId, response.model.usage.costUsd);
        telemetry.increment("actiongate_provider_cost_usd_total", "Provider cost in USD.", { tenant: tenantLabel, provider: response.model.provider }, response.model.usage.costUsd);
      }
      if (response.reasons.some((reason) => reason.code.startsWith("JEV_"))) {
        telemetry.increment("actiongate_provider_errors_total", "Decision-provider failures by tenant.", { tenant: tenantLabel });
      }
      await audit(principal, "decision.created", response.decisionId, { request: authorizedRequest, response });
      const withGrant = await grantService.attachGrant(authorizedRequest, response);
      if (withGrant.grant) telemetry.increment("actiongate_grants_issued_total", "Action Grants issued.", { tenant: tenantLabel, risk: response.riskClass });
      return withGrant;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      if (error instanceof IdempotencyBusyError) return reply.code(503).header("Retry-After", "1").send({ error: { code: "IDEMPOTENCY_BUSY" } });
      throw error;
    }
  });

  app.post("/v1/grants/consume", async (request, reply) => {
    if (!hasRole(request, reply, "consume")) return;
    const principal = getPrincipal(request);
    const parsed = ActionGrantConsumeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    if (!scopeRequest(principal, parsed.data.tenantId, parsed.data.environment, reply)) return;
    const tool = await registeredAction(principal, parsed.data.proposedAction, reply);
    if (!tool) return;
    const consumeRequest = { ...parsed.data, tenantId: principal.tenantId, environment: principal.environment, proposedAction: { ...parsed.data.proposedAction, tool: tool.name, operation: tool.operation, riskClass: tool.riskClass } };
    try {
      const consumed = await grantService.consume(consumeRequest);
      telemetry.increment("actiongate_grants_consumed_total", "Action Grants consumed.", { tenant: telemetry.tenantLabel(principal.tenantId), risk: tool.riskClass });
      await audit(principal, "grant.consumed", consumed.grantId, consumed);
      return consumed;
    } catch (error) {
      if (error instanceof ActionGrantError) {
        telemetry.increment("actiongate_grant_rejections_total", "Grant consumption rejections by reason.", { tenant: telemetry.tenantLabel(principal.tenantId), reason: error.code });
      }
      return grantErrorResponse(error, reply);
    }
  });

  app.post("/v1/grants/:id/revoke", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer", "policy_admin")) return;
    const principal = getPrincipal(request);
    try {
      const revoked = await grantService.revoke((request.params as { id: string }).id, principal.tenantId);
      await audit(principal, "grant.revoked", revoked.grantId, revoked);
      return revoked;
    } catch (error) { return grantErrorResponse(error, reply); }
  });

  app.get("/v1/decisions", async (request, reply) => {
    if (!hasRole(request, reply, "decision_reader")) return;
    const principal = getPrincipal(request);
    const requestedTenant = (request.query as { tenantId?: string }).tenantId;
    if (requestedTenant && requestedTenant !== principal.tenantId) return reply.code(403).send({ error: { code: "TENANT_SCOPE_VIOLATION" } });
    return { data: (await decisions.list(principal.tenantId)).map((record) => record.response) };
  });
  app.get("/v1/decisions/:id", async (request, reply) => {
    if (!hasRole(request, reply, "decision_reader")) return;
    const principal = getPrincipal(request);
    const requestedTenant = (request.query as { tenantId?: string }).tenantId;
    if (requestedTenant && requestedTenant !== principal.tenantId) return reply.code(403).send({ error: { code: "TENANT_SCOPE_VIOLATION" } });
    const record = await decisions.get(principal.tenantId, (request.params as { id: string }).id);
    return record ?? reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
  });

  app.get("/v1/policies", async (request, reply) => {
    if (!hasRole(request, reply, "decision_reader", "policy_admin")) return;
    return { data: await controlPlane.listPolicies(getPrincipal(request).tenantId) };
  });
  app.get("/v1/policies/:id", async (request, reply) => {
    if (!hasRole(request, reply, "decision_reader", "policy_admin")) return;
    const policy = await controlPlane.getPolicy(getPrincipal(request).tenantId, (request.params as { id: string }).id);
    return policy ?? reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } });
  });
  app.post("/v1/policies/:id/versions", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin")) return;
    const principal = getPrincipal(request);
    const parsed = PolicySchema.safeParse(request.body);
    const id = (request.params as { id: string }).id;
    if (!parsed.success || parsed.data.id !== id) return reply.code(400).send({ error: { code: "POLICY_INVALID", ...(parsed.success ? {} : { issues: parsed.error.issues }) } });
    const registry = new Map((await controlPlane.listTools(principal.tenantId)).map((tool) => [tool.name, tool]));
    for (const [name, policyTool] of Object.entries(parsed.data.tools)) {
      const registered = registry.get(name);
      if (!registered || registered.operation !== policyTool.operation || registered.riskClass !== policyTool.riskClass) return reply.code(409).send({ error: { code: "POLICY_REGISTRY_MISMATCH", tool: name } });
    }
    try {
      const created = await controlPlane.addPolicy(principal.tenantId, parsed.data as unknown as Policy, principal.keyId);
      await audit(principal, "policy.version.created", `${created.id}:${created.version}`, created);
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof Error && error.message === "POLICY_VERSION_EXISTS") return reply.code(409).send({ error: { code: "POLICY_VERSION_EXISTS" } });
      throw error;
    }
  });

  app.get("/v1/tools", async (request, reply) => {
    if (!hasRole(request, reply, "authorize", "decision_reader", "policy_admin")) return;
    return { data: await controlPlane.listTools(getPrincipal(request).tenantId) };
  });
  app.put("/v1/tools/:name", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin")) return;
    const principal = getPrincipal(request);
    const parsed = ToolInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "TOOL_INVALID", issues: parsed.error.issues } });
    try {
      const schemaIssue = closedObjectSchemaIssue(parsed.data.argumentSchema);
      if (schemaIssue) throw new Error(schemaIssue);
      new Ajv({ allErrors: true, strict: true }).compile(parsed.data.argumentSchema);
    }
    catch (error) {
      return reply.code(400).send({ error: { code: "TOOL_SCHEMA_INVALID", message: error instanceof Error ? error.message : "Invalid JSON Schema" } });
    }
    const name = (request.params as { name: string }).name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(name)) return reply.code(400).send({ error: { code: "TOOL_NAME_INVALID" } });
    const policy = await controlPlane.getPolicy(principal.tenantId, parsed.data.policyId, parsed.data.policyVersion);
    const policyTool = policy?.tools[name];
    if (!policyTool || policyTool.operation !== parsed.data.operation || policyTool.riskClass !== parsed.data.riskClass) {
      return reply.code(409).send({ error: { code: "TOOL_POLICY_MISMATCH" } });
    }
    const tool = await controlPlane.putTool(principal.tenantId, { name, ...parsed.data }, principal.keyId);
    argumentValidators.clear();
    await audit(principal, "tool.updated", tool.name, tool);
    return reply.code(200).send(tool);
  });

  app.get("/v1/api-keys", async (request, reply) => {
    if (!hasRole(request, reply, "key_admin")) return;
    return { data: await controlPlane.listApiKeys(getPrincipal(request).tenantId) };
  });
  app.post("/v1/api-keys", async (request, reply) => {
    if (!hasRole(request, reply, "key_admin")) return;
    const principal = getPrincipal(request);
    const parsed = ApiKeyInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "API_KEY_INVALID", issues: parsed.error.issues } });
    const issued = await controlPlane.createApiKey({ tenantId: principal.tenantId, ...parsed.data });
    await audit(principal, "api_key.created", issued.key.id, issued.key);
    return reply.code(201).send(issued);
  });
  app.post("/v1/api-keys/:id/revoke", async (request, reply) => {
    if (!hasRole(request, reply, "key_admin")) return;
    const principal = getPrincipal(request);
    const revoked = await controlPlane.revokeApiKey(principal.tenantId, (request.params as { id: string }).id, new Date());
    if (!revoked) return reply.code(404).send({ error: { code: "API_KEY_NOT_FOUND" } });
    await audit(principal, "api_key.revoked", revoked.id, revoked);
    return revoked;
  });

  app.post("/v1/decisions/:id/override", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const parsed = OverrideInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const decisionId = (request.params as { id: string }).id;
    if (!await decisions.get(principal.tenantId, decisionId)) return reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
    const record = await controlPlane.createOverride({ tenantId: principal.tenantId, decisionId, ...parsed.data, createdBy: principal.keyId });
    await audit(principal, "decision.overridden", record.id, record);
    return reply.code(201).send(record);
  });

  app.post("/v1/reviews", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const parsed = ReviewInputSchema.safeParse(request.body);
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) return reply.code(400).send({ error: { code: "REVIEW_INVALID", ...(parsed.success ? {} : { issues: parsed.error.issues }) } });
    if (!await decisions.get(principal.tenantId, parsed.data.decisionId)) return reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
    const review = await controlPlane.createReview({
      tenantId: principal.tenantId,
      decisionId: parsed.data.decisionId,
      reason: parsed.data.reason,
      ...(parsed.data.assignee ? { assignee: parsed.data.assignee } : {}),
      ...(parsed.data.requiredApprovals ? { requiredApprovals: parsed.data.requiredApprovals } : {}),
      expiresAt: parsed.data.expiresAt,
      createdBy: principal.keyId
    });
    telemetry.increment("actiongate_reviews_total", "Reviews raised.", { tenant: telemetry.tenantLabel(principal.tenantId) });
    await audit(principal, "review.created", review.id, review);
    return reply.code(201).send(review);
  });
  app.post("/v1/reviews/:id/resolve", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const parsed = ReviewResolutionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "REVIEW_INVALID", issues: parsed.error.issues } });
    const reviewId = (request.params as { id: string }).id;

    if (parsed.data.decision === "DENIED") {
      const denied = await controlPlane!.resolveReview(principal.tenantId, reviewId, "DENIED", principal.keyId);
      if (!denied) return reply.code(404).send({ error: { code: "REVIEW_NOT_FOUND" } });
      await audit(principal, "review.resolved", denied.id, denied);
      void notify({ type: "review.denied", tenantId: principal.tenantId, objectId: denied.id, payload: denied });
      return denied;
    }

    const outcome = await controlPlane!.recordApproval(principal.tenantId, reviewId, principal.keyId);
    if (outcome.status === "NOT_FOUND") return reply.code(404).send({ error: { code: "REVIEW_NOT_FOUND" } });
    if (outcome.status === "ALREADY_APPROVED_BY_ACTOR") {
      // Two-person approval means two distinct reviewers. The same key approving
      // twice must never satisfy both halves.
      return reply.code(409).send({ error: { code: "DUPLICATE_APPROVER" }, review: outcome.review });
    }
    if (outcome.status === "PENDING_APPROVALS") {
      await audit(principal, "review.approval_recorded", outcome.review.id, outcome.review);
      return reply.code(202).send({ review: outcome.review, approvalsRemaining: (outcome.review.requiredApprovals ?? 1) - (outcome.review.approvals?.length ?? 0) });
    }

    const review = outcome.review;
    await audit(principal, "review.resolved", review.id, review);
    if (review.status !== "APPROVED") return review;

    // Approval does not resurrect the original decision. Re-evaluate the exact
    // action against the policy and registry as they stand now, and mint a new
    // short-lived grant only if that fresh evaluation still allows it.
    const original = await decisions.get(principal.tenantId, review.decisionId);
    if (!original) return reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
    const revalidated = RevalidationRequestSchema.safeParse(original.sanitizedRequest);
    if (!revalidated.success) return reply.code(422).send({ error: { code: "DECISION_NOT_REPLAYABLE" }, review });

    const tool = await registeredAction(principal, revalidated.data.proposedAction, reply);
    if (!tool) return;
    const policy = await controlPlane!.getPolicy(principal.tenantId, tool.policyId, tool.policyVersion);
    if (!policy) return reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } });

    const approvalRequest: AuthorizationRequest = {
      ...revalidated.data,
      requestId: randomUUID(),
      idempotencyKey: `review-approval-${review.id}`,
      tenantId: principal.tenantId,
      environment: principal.environment,
      mode: "enforce",
      policyVersion: tool.policyVersion,
      proposedAction: { ...revalidated.data.proposedAction, tool: tool.name, operation: tool.operation, riskClass: tool.riskClass }
    };
    const freshDecision = await service.authorize(approvalRequest, policy);
    const withGrant = await grantService.attachGrant(approvalRequest, freshDecision);
    await audit(principal, "review.revalidated", review.id, { reviewId: review.id, originalDecisionId: review.decisionId, decisionId: withGrant.decisionId, decision: withGrant.decision });
    void notify({ type: "review.approved", tenantId: principal.tenantId, objectId: review.id, payload: { review, decision: withGrant.decision, decisionId: withGrant.decisionId } });
    return { review, revalidation: withGrant };
  });

  // --- Credential broker -------------------------------------------------
  // Exchanges a grant for a narrow, short-lived downstream credential. The grant
  // is consumed first, so an exchange is the same single use as an execution.
  app.post("/v1/grants/exchange", async (request, reply) => {
    if (!hasRole(request, reply, "consume")) return;
    if (!credentialIssuer) return reply.code(501).send({ error: { code: "CREDENTIAL_BROKER_NOT_CONFIGURED" } });
    const principal = getPrincipal(request);
    const parsed = GrantExchangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    if (!scopeRequest(principal, parsed.data.tenantId, parsed.data.environment, reply)) return;
    const tool = await registeredAction(principal, parsed.data.proposedAction, reply);
    if (!tool) return;
    const { ttlSeconds, audience, ...consumeInput } = parsed.data;
    const consumeRequest = {
      ...consumeInput,
      tenantId: principal.tenantId,
      environment: principal.environment,
      proposedAction: { ...parsed.data.proposedAction, tool: tool.name, operation: tool.operation, riskClass: tool.riskClass }
    };
    try {
      const { claims, response } = await grantService.consumeWithClaims(consumeRequest);
      const credential = await credentialIssuer.issue({ claims, ttlSeconds: ttlSeconds ?? 60, ...(audience ? { audience } : {}) });
      await audit(principal, "grant.exchanged", response.grantId, { grantId: response.grantId, decisionId: response.decisionId, issuer: credential.issuer, expiresAt: credential.expiresAt });
      return { grantId: response.grantId, decisionId: response.decisionId, consumedAt: response.consumedAt, credential };
    } catch (error) { return grantErrorResponse(error, reply); }
  });

  // --- Execution outcomes ------------------------------------------------
  // Authorization is not execution. These statuses are recorded separately so a
  // consumed grant is never mistaken for a completed business operation.
  app.post("/v1/executions", async (request, reply) => {
    if (!hasRole(request, reply, "consume")) return;
    const principal = getPrincipal(request);
    const parsed = ExecutionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    if (!await decisions.get(principal.tenantId, parsed.data.decisionId)) return reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
    const record = await controlPlane!.recordExecution({
      tenantId: principal.tenantId,
      decisionId: parsed.data.decisionId,
      status: parsed.data.status,
      ...(parsed.data.grantId ? { grantId: parsed.data.grantId } : {}),
      ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
      ...(parsed.data.externalRef ? { externalRef: parsed.data.externalRef } : {}),
      recordedBy: principal.keyId
    });
    telemetry.increment("actiongate_executions_total", "Execution outcomes recorded.", { tenant: telemetry.tenantLabel(principal.tenantId), status: parsed.data.status });
    await audit(principal, `execution.${parsed.data.status.toLowerCase()}`, record.id, record);
    void notify({ type: `execution.${parsed.data.status.toLowerCase()}`, tenantId: principal.tenantId, objectId: record.id, payload: record });
    return reply.code(201).send(record);
  });
  app.get("/v1/executions", async (request, reply) => {
    if (!hasRole(request, reply, "decision_reader")) return;
    const principal = getPrincipal(request);
    const decisionId = (request.query as { decisionId?: string }).decisionId;
    return { data: await controlPlane!.listExecutions(principal.tenantId, decisionId) };
  });

  // --- Review queue ------------------------------------------------------
  app.get("/v1/reviews", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const status = (request.query as { status?: string }).status;
    const parsedStatus = status && ["PENDING", "APPROVED", "DENIED", "EXPIRED"].includes(status) ? status as "PENDING" : undefined;
    return { data: await controlPlane!.listReviews(principal.tenantId, parsedStatus) };
  });
  app.post("/v1/reviews/:id/claim", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const parsed = ReviewClaimSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const review = await controlPlane!.claimReview(principal.tenantId, (request.params as { id: string }).id, parsed.data.assignee, principal.keyId);
    if (!review) return reply.code(404).send({ error: { code: "REVIEW_NOT_FOUND" } });
    if (review.status !== "PENDING") return reply.code(409).send({ error: { code: "REVIEW_NOT_PENDING" }, review });
    // A claim by a second reviewer does not take the review from the first.
    if (review.assignee !== parsed.data.assignee) return reply.code(409).send({ error: { code: "REVIEW_ALREADY_CLAIMED" }, review });
    await audit(principal, "review.claimed", review.id, review);
    return review;
  });
  app.post("/v1/reviews/:id/escalate", async (request, reply) => {
    if (!hasRole(request, reply, "reviewer")) return;
    const principal = getPrincipal(request);
    const parsed = ReviewEscalationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const review = await controlPlane!.escalateReview(principal.tenantId, (request.params as { id: string }).id, parsed.data.assignee, parsed.data.note, principal.keyId);
    if (!review) return reply.code(404).send({ error: { code: "REVIEW_NOT_FOUND" } });
    if (review.status !== "PENDING") return reply.code(409).send({ error: { code: "REVIEW_NOT_PENDING" }, review });
    await audit(principal, "review.escalated", review.id, review);
    void notify({ type: "review.escalated", tenantId: principal.tenantId, objectId: review.id, payload: review });
    return review;
  });

  // --- Policy and decision simulator --------------------------------------
  // Runs the full decision path and throws the result away: nothing is stored,
  // no idempotency key is consumed, and no grant is ever issued. It exists so a
  // policy change can be tried against a real action before it is committed.
  app.post("/v1/simulate", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin")) return;
    const principal = getPrincipal(request);
    const parsed = SimulationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });

    const tool = await registeredAction(principal, parsed.data.request.proposedAction, reply);
    if (!tool) return;
    const storedPolicy = await controlPlane!.getPolicy(principal.tenantId, tool.policyId, tool.policyVersion);
    const policy = parsed.data.policy ?? storedPolicy;
    if (!policy) return reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } });
    const policyTool = policy.tools[tool.name];
    if (!policyTool) return reply.code(409).send({ error: { code: "TOOL_NOT_IN_CANDIDATE_POLICY" } });

    const simulated: AuthorizationRequest = {
      ...parsed.data.request,
      requestId: `simulate-${randomUUID()}`,
      idempotencyKey: `simulate-${randomUUID()}`,
      tenantId: principal.tenantId,
      environment: principal.environment,
      mode: parsed.data.request.mode ?? "enforce",
      proposedAction: { ...parsed.data.request.proposedAction, tool: tool.name, operation: tool.operation, riskClass: tool.riskClass }
    };

    // The engine directly, not the service: the service records and deduplicates.
    const response = await simulationEngine.authorize(simulated, policy as Policy);
    telemetry.increment("actiongate_simulations_total", "Policy simulations run.", { tenant: telemetry.tenantLabel(principal.tenantId), decision: response.decision });
    return {
      simulated: true,
      decision: response.decision,
      wouldHaveDecision: response.wouldHaveDecision ?? null,
      riskClass: response.riskClass,
      reasons: response.reasons,
      signals: response.signals,
      timing: response.timing,
      policy: response.policy,
      ...(response.model ? { model: response.model } : {}),
      // Stated explicitly so a caller cannot mistake a simulation for a permit.
      note: "Simulation only. Nothing was stored and no Action Grant was issued."
    };
  });

  // --- Incident response --------------------------------------------------
  app.post("/v1/incidents/disable-tools", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin")) return;
    const principal = getPrincipal(request);
    const parsed = IncidentDisableSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const disabled = await controlPlane!.disableTools(principal.tenantId, parsed.data.tools, principal.keyId);
    argumentValidators.clear();
    for (const tool of disabled) await audit(principal, "tool.disabled", tool.name, tool);
    void notify({ type: "incident.tools_disabled", tenantId: principal.tenantId, objectId: parsed.data.tools.join(","), payload: { disabled: disabled.map((tool) => tool.name) } });
    return { disabled: disabled.map((tool) => tool.name) };
  });
  app.post("/v1/incidents/revoke-grants", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin")) return;
    const principal = getPrincipal(request);
    const parsed = IncidentRevokeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const result = await grantService.revokeOutstanding(principal.tenantId, parsed.data.tool);
    if (!result.supported) return reply.code(501).send({ error: { code: "BULK_REVOCATION_UNSUPPORTED" } });
    for (const grantId of result.revoked) await audit(principal, "grant.revoked", grantId, { grantId, reason: "incident" });
    void notify({ type: "incident.grants_revoked", tenantId: principal.tenantId, objectId: parsed.data.tool ?? "*", payload: { revoked: result.revoked } });
    return { revoked: result.revoked };
  });
  app.get("/v1/incidents/dead-letters", async (request, reply) => {
    if (!hasRole(request, reply, "policy_admin", "audit_exporter")) return;
    const principal = getPrincipal(request);
    return { data: notifier ? await notifier.deadLetters(principal.tenantId) : [] };
  });

  app.get("/v1/audit/export", async (request, reply) => {
    if (!hasRole(request, reply, "audit_exporter")) return;
    const principal = getPrincipal(request);
    const [decisionRecords, events] = await Promise.all([decisions.list(principal.tenantId), controlPlane!.listAuditEvents(principal.tenantId)]);
    const payload = { tenantId: principal.tenantId, exportedAt: new Date().toISOString(), decisions: decisionRecords, events };
    if (!exportKey) return payload;
    // Hash-chained and signed, so a recipient can detect an altered export
    // without trusting whoever handed it over.
    return {
      ...payload,
      attestation: signExport({
        tenantId: principal.tenantId,
        entries: [...decisionRecords, ...events],
        keyId: exportKey.id,
        secret: exportKey.secret,
        exportedAt: payload.exportedAt
      })
    };
  });
  app.delete("/v1/audit/retention", async (request, reply) => {
    if (!hasRole(request, reply, "audit_exporter", "policy_admin")) return;
    const principal = getPrincipal(request);
    const beforeValue = (request.query as { before?: string }).before;
    const before = beforeValue ? new Date(beforeValue) : undefined;
    if (!before || Number.isNaN(before.getTime()) || before.getTime() > Date.now()) return reply.code(400).send({ error: { code: "RETENTION_CUTOFF_INVALID" } });
    const [decisionsMinimized, eventsDeleted] = await Promise.all([
      decisions.deleteBefore ? decisions.deleteBefore(principal.tenantId, before) : Promise.resolve(0),
      controlPlane.deleteAuditEventsBefore(principal.tenantId, before)
    ]);
    const result = { before: before.toISOString(), decisionsMinimized, eventsDeleted };
    await audit(principal, "retention.executed", crypto.randomUUID(), result);
    return result;
  });

  // Exposed so a deployment can push the same snapshot to a collector without a
  // second instrumentation path.
  return Object.assign(app, { telemetry });
}

/** Tool arguments cross the agent boundary, so every registry schema must be a
 * closed top-level object. A permissive schema would silently turn new fields
 * into executable input without an administrator explicitly registering them. */
function closedObjectSchemaIssue(schema: Record<string, unknown>): string | undefined {
  if (schema.type !== "object") return "Tool argument schemas must have type=object";
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    return "Tool argument schemas must declare a properties object";
  }
  if (schema.additionalProperties !== false) return "Tool argument schemas must set additionalProperties=false";
  if (schema.patternProperties !== undefined) return "Tool argument schemas must not use patternProperties";
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string" || !(name in (schema.properties as Record<string, unknown>)))) {
      return "Tool argument schema required entries must name declared properties";
    }
  }
  return undefined;
}

function grantErrorResponse(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ActionGrantError)) throw error;
  const statuses: Record<string, number> = {
    GRANT_MALFORMED: 401,
    GRANT_INVALID_SIGNATURE: 401,
    GRANT_BINDING_MISMATCH: 403,
    GRANT_REVOKED: 403,
    GRANT_NOT_FOUND: 404,
    GRANT_ALREADY_CONSUMED: 409,
    GRANT_EXPIRED: 410
  };
  return reply.code(statuses[error.code] ?? 400).send({ error: { code: error.code, message: error.message } });
}

function createProvider(): DecisionProvider {
  if (config.DECISION_PROVIDER === "fake") return FakeDecisionProvider.allow();
  return new OpenRouterJevProvider({ apiKey: config.openRouterApiKey!, model: config.JEV_MODEL, appTitle: "ActionGate" });
}
