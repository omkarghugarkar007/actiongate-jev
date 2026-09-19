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
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ACTIONGATE_REDIS_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/).default("actiongate"),
  ACTIONGATE_IDEMPOTENCY_LEASE_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  ACTIONGATE_IDEMPOTENCY_WAIT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  ACTIONGATE_API_KEY: z.string().min(8).default("ag_test_local"),
  ACTIONGATE_GRANT_SECRET: z.string().min(32).default("development-only-actiongate-grant-secret"),
  ACTIONGATE_GRANT_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  ACTIONGATE_FAIL_OPEN_READ_ONLY: z.enum(["true", "false"]).default("false")
});

const env = schema.parse(process.env);
if (env.NODE_ENV === "production" && env.JEV_MODEL !== "typesafe/jev-1.13") throw new Error("Production requires JEV_MODEL=typesafe/jev-1.13");
if (env.NODE_ENV === "production" && env.ACTIONGATE_GRANT_SECRET === "development-only-actiongate-grant-secret") throw new Error("Production requires a unique ACTIONGATE_GRANT_SECRET");
if (env.NODE_ENV === "production" && env.ACTIONGATE_STORAGE === "memory") throw new Error("Production requires ACTIONGATE_STORAGE=redis");
if (env.ACTIONGATE_IDEMPOTENCY_LEASE_MS <= env.JEV_TIMEOUT_MS) throw new Error("ACTIONGATE_IDEMPOTENCY_LEASE_MS must exceed JEV_TIMEOUT_MS");
if (env.DECISION_PROVIDER === "openrouter" && !(env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY)) throw new Error("OPENROUTER_API_KEY is required for the OpenRouter provider");

export const config = {
  ...env,
  openRouterApiKey: env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY,
  failOpenReadOnly: env.ACTIONGATE_FAIL_OPEN_READ_ONLY === "true"
};
