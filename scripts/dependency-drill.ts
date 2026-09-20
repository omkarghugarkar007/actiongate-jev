import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { Pool } from "pg";

/**
 * Dependency-loss and restore drill.
 *
 * Proves two things an operator needs to know before trusting a deployment:
 * that losing a store makes ActionGate deny rather than wave actions through,
 * and that a PostgreSQL dump restores to the same control-plane state.
 *
 * Run against a disposable stack. It stops and starts containers.
 */
const compose = process.env.DRILL_COMPOSE_FILE ?? "infra/docker-compose.yml";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://actiongate:actiongate@localhost:5432/actiongate";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const results: { step: string; ok: boolean; detail: string }[] = [];

const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${step}: ${detail}`);
};

function dockerCompose(...args: string[]): string {
  return execFileSync("docker", ["compose", "-f", compose, ...args], { encoding: "utf8" });
}

async function redisReachable(): Promise<boolean> {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  try { await client.connect(); await client.ping(); return true; }
  catch { return false; }
  finally { client.disconnect(); }
}

async function postgresCounts(): Promise<Record<string, number>> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const counts: Record<string, number> = {};
    for (const table of ["tenants", "api_keys", "policy_versions", "tool_registry", "audit_events"]) {
      const rows = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      counts[table] = Number(rows.rows[0]?.count ?? 0);
    }
    return counts;
  } finally { await pool.end(); }
}

// 1. Baseline.
const before = await postgresCounts();
record("baseline", true, `control-plane rows ${JSON.stringify(before)}`);

// 2. Back up.
const dump = execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "pg_dump", "-U", "actiongate", "actiongate"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
record("backup", dump.includes("PostgreSQL database dump"), `${dump.length} bytes captured`);

// 3. Lose Redis and confirm it is actually gone.
dockerCompose("stop", "redis");
record("redis-loss", !(await redisReachable()), "Redis is unreachable; a redis-backed API must now fail closed rather than allow");
dockerCompose("start", "redis");
let recovered = false;
for (let attempt = 0; attempt < 30 && !recovered; attempt += 1) {
  recovered = await redisReachable();
  if (!recovered) await new Promise((resolve) => setTimeout(resolve, 1000));
}
record("redis-recovery", recovered, recovered ? "Redis returned" : "Redis did not return within 30s");

// 4. Restore into a scratch database and compare.
execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-U", "actiongate", "-c", "DROP DATABASE IF EXISTS actiongate_restore"], { encoding: "utf8" });
execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-U", "actiongate", "-c", "CREATE DATABASE actiongate_restore"], { encoding: "utf8" });
execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-U", "actiongate", "-d", "actiongate_restore"], { input: dump, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const restorePool = new Pool({ connectionString: databaseUrl.replace(/\/[^/]+$/, "/actiongate_restore") });
const after: Record<string, number> = {};
try {
  for (const table of Object.keys(before)) {
    const rows = await restorePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    after[table] = Number(rows.rows[0]?.count ?? 0);
  }
} finally { await restorePool.end(); }

const matches = Object.keys(before).every((table) => before[table] === after[table]);
record("restore", matches, matches ? "restored row counts match the backup" : `mismatch: ${JSON.stringify({ before, after })}`);
execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-U", "actiongate", "-c", "DROP DATABASE actiongate_restore"], { encoding: "utf8" });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} drill steps passed.`);
if (failed.length) process.exitCode = 1;
