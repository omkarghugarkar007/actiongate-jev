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
  ACTIONGATE_API_KEY: z.string().min(8).default("ag_test_local"),
  ACTIONGATE_FAIL_OPEN_READ_ONLY: z.enum(["true", "false"]).default("false")
});

const env = schema.parse(process.env);
if (env.NODE_ENV === "production" && env.JEV_MODEL !== "typesafe/jev-1.13") throw new Error("Production requires JEV_MODEL=typesafe/jev-1.13");
if (env.DECISION_PROVIDER === "openrouter" && !(env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY)) throw new Error("OPENROUTER_API_KEY is required for the OpenRouter provider");

export const config = {
  ...env,
  openRouterApiKey: env.OPENROUTER_API_KEY ?? env.OPENROUTER_KEY,
  failOpenReadOnly: env.ACTIONGATE_FAIL_OPEN_READ_ONLY === "true"
};
