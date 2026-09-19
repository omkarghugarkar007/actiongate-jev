import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { ActionGrantConsumeRequestSchema, ActionGrantError, ActionGrantSigner, AuthorizationEngine, AuthorizationRequestSchema, DEFAULT_POLICY, type DecisionProvider, type Policy } from "@actiongate/core";
import { FakeDecisionProvider, OpenRouterJevProvider } from "@actiongate/decision-provider";
import { config } from "./config.js";
import { AuthorizationService, IdempotencyConflictError } from "./services/authorization-service.js";
import { ActionGrantService } from "./services/action-grant-service.js";
import { InMemoryDecisionRepository, InMemoryGrantRepository, InMemoryPolicyRepository } from "./services/repository.js";

export interface BuildAppOptions {
  provider?: DecisionProvider;
  apiKey?: string;
  grantSecret?: string;
  grantTtlSeconds?: number;
  clock?: () => number;
  logger?: boolean;
  rateLimitMax?: number;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger === false ? false : { redact: ["req.headers.authorization", "req.body.token", "req.body.proposedAction.arguments.password", "req.body.proposedAction.arguments.token"] } });
  const provider = options.provider ?? createProvider();
  const decisions = new InMemoryDecisionRepository();
  const grants = new InMemoryGrantRepository();
  const policies = new InMemoryPolicyRepository([structuredClone(DEFAULT_POLICY)]);
  const service = new AuthorizationService(new AuthorizationEngine(provider, { timeoutMs: config.JEV_TIMEOUT_MS, failOpenReadOnly: config.failOpenReadOnly }), decisions);
  const grantService = new ActionGrantService(new ActionGrantSigner({
    secret: options.grantSecret ?? config.ACTIONGATE_GRANT_SECRET,
    ttlSeconds: options.grantTtlSeconds ?? config.ACTIONGATE_GRANT_TTL_SECONDS,
    ...(options.clock ? { clock: options.clock } : {})
  }), grants, options.clock ?? Date.now);
  const expectedKey = options.apiKey ?? config.ACTIONGATE_API_KEY;

  app.register(cors, { origin: config.APP_URL });
  app.register(sensible);
  app.register(rateLimit, { max: options.rateLimitMax ?? 300, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url === "/ready") return;
    if (request.headers.authorization !== `Bearer ${expectedKey}`) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "A valid ActionGate API key is required." } });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready", provider: config.DECISION_PROVIDER }));

  app.post("/v1/authorize", async (request, reply) => {
    const parsed = AuthorizationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    const headerKey = request.headers["idempotency-key"];
    if (headerKey && headerKey !== parsed.data.idempotencyKey) return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Header and body idempotency keys differ." } });
    const policy = policies.get(parsed.data.policyVersion ? DEFAULT_POLICY.id : DEFAULT_POLICY.id, parsed.data.policyVersion);
    if (!policy) return reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } });
    try {
      const response = await service.authorize(parsed.data, policy);
      return await grantService.attachGrant(parsed.data, response);
    }
    catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      throw error;
    }
  });

  app.post("/v1/grants/consume", async (request, reply) => {
    const parsed = ActionGrantConsumeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", issues: parsed.error.issues } });
    try {
      return await grantService.consume(parsed.data);
    } catch (error) {
      if (!(error instanceof ActionGrantError)) throw error;
      const statuses: Record<string, number> = {
        GRANT_MALFORMED: 401,
        GRANT_INVALID_SIGNATURE: 401,
        GRANT_BINDING_MISMATCH: 403,
        GRANT_NOT_FOUND: 404,
        GRANT_ALREADY_CONSUMED: 409,
        GRANT_EXPIRED: 410
      };
      return reply.code(statuses[error.code] ?? 400).send({ error: { code: error.code, message: error.message } });
    }
  });

  app.get("/v1/decisions", async (request) => {
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? "tenant-1";
    const records = await decisions.list(tenantId);
    return { data: records.map((x) => x.response) };
  });
  app.get("/v1/decisions/:id", async (request, reply) => {
    const tenantId = (request.query as { tenantId?: string }).tenantId ?? "tenant-1";
    const record = await decisions.get(tenantId, (request.params as { id: string }).id);
    return record ?? reply.code(404).send({ error: { code: "DECISION_NOT_FOUND" } });
  });
  app.get("/v1/policies", async () => ({ data: policies.list() }));
  app.get("/v1/policies/:id", async (request, reply) => policies.get((request.params as { id: string }).id) ?? reply.code(404).send({ error: { code: "POLICY_NOT_FOUND" } }));
  app.post("/v1/policies/:id/versions", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as Policy;
    if (body.id !== id) return reply.code(400).send({ error: { code: "POLICY_INVALID" } });
    try { return reply.code(201).send(policies.add(body)); } catch { return reply.code(409).send({ error: { code: "POLICY_VERSION_EXISTS" } }); }
  });
  app.post("/v1/decisions/:id/override", async (request, reply) => {
    const body = request.body as { correctDecision?: string; reason?: string };
    if (!body.correctDecision || !body.reason) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
    return reply.code(201).send({ id: crypto.randomUUID(), decisionId: (request.params as { id: string }).id, ...body, createdAt: new Date().toISOString() });
  });
  return app;
}

function createProvider(): DecisionProvider {
  if (config.DECISION_PROVIDER === "fake") return FakeDecisionProvider.allow();
  return new OpenRouterJevProvider({ apiKey: config.openRouterApiKey!, model: config.JEV_MODEL, appTitle: "ActionGate" });
}
