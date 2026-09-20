import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DECISION_PROVIDER: z.enum(["fake", "openrouter"]).default("fake"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_KEY: z.string().optional(),
  JEV_MODEL: z.string().default("typesafe/jev-1.13"),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ACTIONGATE_STORAGE: z.enum(["memory", "redis"]).default("memory"),
  ACTIONGATE_CONTROL_PLANE: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().min(1).default("postgres://actiongate:actiongate@localhost:5432/actiongate"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ACTIONGATE_REDIS_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/).default("actiongate"),
  ACTIONGATE_IDEMPOTENCY_LEASE_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  ACTIONGATE_IDEMPOTENCY_WAIT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  ACTIONGATE_API_KEY: z.string().min(8).optional(),
  ACTIONGATE_DEV_TENANT_ID: z.string().min(1).max(128).default("tenant-1"),
  ACTIONGATE_GRANT_SECRET: z.string().min(32).default("development-only-actiongate-grant-secret"),
  ACTIONGATE_GRANT_KEYS: z.string().optional(),
  ACTIONGATE_GRANT_ACTIVE_KID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  ACTIONGATE_EVIDENCE_KEYS: z.string().optional(),
  ACTIONGATE_EVIDENCE_ACTIVE_KID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  ACTIONGATE_GRANT_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  ACTIONGATE_FAIL_OPEN_READ_ONLY: z.enum(["true", "false"]).default("false"),
  /** Deployment-owned service that resolves hard-rule evidence. */
  ACTIONGATE_FACT_PROVIDER_URL: z.string().url().optional(),
  ACTIONGATE_FACT_PROVIDER_TOKEN: z.string().min(1).optional(),
  /** Enables POST /v1/grants/exchange. Independent of the grant and evidence keys. */
  ACTIONGATE_CREDENTIAL_SECRET: z.string().min(32).optional(),
  ACTIONGATE_CREDENTIAL_KID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default("cred_1"),
  ACTIONGATE_CREDENTIAL_MAX_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
  /** OTLP metric export. Omit to keep metrics on the /metrics endpoint only. */
  ACTIONGATE_OTLP_ENDPOINT: z.string().url().optional(),
  ACTIONGATE_OTLP_INTERVAL_MS: z.coerce.number().int().min(5000).max(600_000).default(60_000),
  /** Signed outbound notifications. */
  ACTIONGATE_WEBHOOK_URL: z.string().url().optional(),
  ACTIONGATE_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** Per-tenant quotas as JSON: {"tenant":{"authorizePerMinute":60}}. */
  ACTIONGATE_TENANT_QUOTAS: z.string().optional(),
  ACTIONGATE_DEFAULT_QUOTA: z.string().optional()
});

const env = schema.parse(process.env);
if (env.NODE_ENV === "production" && env.JEV_MODEL !== "typesafe/jev-1.13") throw new Error("Production requires JEV_MODEL=typesafe/jev-1.13");
if (env.NODE_ENV === "production" && env.ACTIONGATE_STORAGE === "memory") throw new Error("Production requires ACTIONGATE_STORAGE=redis");
if (env.NODE_ENV === "production" && env.ACTIONGATE_CONTROL_PLANE !== "postgres") throw new Error("Production requires ACTIONGATE_CONTROL_PLANE=postgres");
if (env.NODE_ENV === "production" && env.ACTIONGATE_API_KEY) throw new Error("Production does not accept ACTIONGATE_API_KEY; provision a hashed tenant key in PostgreSQL");
if (env.ACTIONGATE_IDEMPOTENCY_LEASE_MS <= env.JEV_TIMEOUT_MS) throw new Error("ACTIONGATE_IDEMPOTENCY_LEASE_MS must exceed JEV_TIMEOUT_MS");
if (env.DECISION_PROVIDER === "openrouter" && !(env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY)) throw new Error("OPENROUTER_API_KEY is required for the OpenRouter provider");
if (env.ACTIONGATE_FACT_PROVIDER_TOKEN && !env.ACTIONGATE_FACT_PROVIDER_URL) throw new Error("ACTIONGATE_FACT_PROVIDER_TOKEN requires ACTIONGATE_FACT_PROVIDER_URL");
// A webhook URL with no secret would send unsigned notifications, which a
// receiver cannot distinguish from a forgery.
if (env.ACTIONGATE_WEBHOOK_URL && !env.ACTIONGATE_WEBHOOK_SECRET) throw new Error("ACTIONGATE_WEBHOOK_URL requires ACTIONGATE_WEBHOOK_SECRET");

const grantKeys = parseKeyRing(env.ACTIONGATE_GRANT_KEYS, "ACTIONGATE_GRANT_KEYS");
const evidenceKeys = parseKeyRing(env.ACTIONGATE_EVIDENCE_KEYS, "ACTIONGATE_EVIDENCE_KEYS");
if (env.ACTIONGATE_GRANT_ACTIVE_KID && !grantKeys.some((key) => key.id === env.ACTIONGATE_GRANT_ACTIVE_KID)) throw new Error("ACTIONGATE_GRANT_ACTIVE_KID is not present in ACTIONGATE_GRANT_KEYS");
if (env.ACTIONGATE_EVIDENCE_ACTIVE_KID && !evidenceKeys.some((key) => key.id === env.ACTIONGATE_EVIDENCE_ACTIVE_KID)) throw new Error("ACTIONGATE_EVIDENCE_ACTIVE_KID is not present in ACTIONGATE_EVIDENCE_KEYS");
if (env.NODE_ENV === "production" && (grantKeys.length === 0 || !env.ACTIONGATE_GRANT_ACTIVE_KID)) throw new Error("Production requires an Action Grant key ring and active key ID");
if (env.NODE_ENV === "production" && (evidenceKeys.length === 0 || !env.ACTIONGATE_EVIDENCE_ACTIVE_KID)) throw new Error("Production requires an evidence-encryption key ring and active key ID");

export const config = {
  ...env,
  openRouterApiKey: env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY,
  failOpenReadOnly: env.ACTIONGATE_FAIL_OPEN_READ_ONLY === "true",
  grantKeys,
  evidenceKeys,
  tenantQuotas: parseJsonRecord(env.ACTIONGATE_TENANT_QUOTAS, "ACTIONGATE_TENANT_QUOTAS"),
  defaultQuota: parseJsonRecord(env.ACTIONGATE_DEFAULT_QUOTA, "ACTIONGATE_DEFAULT_QUOTA")
};

function parseJsonRecord(value: string | undefined, name: string): Record<string, never> {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${name} must be a JSON object`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  return parsed as Record<string, never>;
}

function parseKeyRing(value: string | undefined, name: string) {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${name} must be a JSON object mapping key IDs to secrets`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object mapping key IDs to secrets`);
  return Object.entries(parsed).map(([id, secret]) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error(`${name} contains an invalid key ID or short secret`);
    return { id, secret };
  });
}
