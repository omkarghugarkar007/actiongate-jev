import "dotenv/config";
import { Pool } from "pg";
import { DEFAULT_POLICY } from "@actiongate/core";
import { EvidenceCipher } from "../apps/api/src/security/evidence-cipher.js";
import { API_ROLES, defaultToolRegistrations } from "../apps/api/src/services/control-plane.js";
import { PostgresControlPlaneRepository } from "../apps/api/src/services/postgres-control-plane.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://actiongate:actiongate@localhost:5432/actiongate";
const tenantSlug = process.env.ACTIONGATE_SEED_TENANT ?? "tenant-1";
const tenantName = process.env.ACTIONGATE_SEED_TENANT_NAME ?? "Local development tenant";
const environment = process.env.ACTIONGATE_SEED_ENVIRONMENT === "staging" || process.env.ACTIONGATE_SEED_ENVIRONMENT === "production"
  ? process.env.ACTIONGATE_SEED_ENVIRONMENT
  : "development";
const evidenceRing = parseKeyRing(process.env.ACTIONGATE_EVIDENCE_KEYS);
const fallbackSecret = process.env.ACTIONGATE_GRANT_SECRET ?? "development-only-actiongate-grant-secret";
const keys = evidenceRing.length ? evidenceRing : [{ id: "development", secret: fallbackSecret }];
const activeKeyId = process.env.ACTIONGATE_EVIDENCE_ACTIVE_KID ?? keys[0]!.id;
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(`
    INSERT INTO tenants (slug, name) VALUES ($1, $2)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  `, [tenantSlug, tenantName]);
  const repository = new PostgresControlPlaneRepository(pool, new EvidenceCipher(keys, activeKeyId));
  if (!await repository.getPolicy(tenantSlug, DEFAULT_POLICY.id, DEFAULT_POLICY.version)) {
    await repository.addPolicy(tenantSlug, DEFAULT_POLICY, "seed");
  }
  for (const tool of defaultToolRegistrations().values()) {
    const input = {
      name: tool.name, operation: tool.operation, riskClass: tool.riskClass, argumentSchema: tool.argumentSchema,
      owner: tool.owner, dataSensitivity: tool.dataSensitivity, policyId: tool.policyId, policyVersion: tool.policyVersion, enabled: tool.enabled
    };
    await repository.putTool(tenantSlug, input, "seed");
  }
  const existing = (await repository.listApiKeys(tenantSlug)).find((key) => !key.revokedAt && key.environment === environment);
  if (existing) {
    console.log(JSON.stringify({ tenantId: tenantSlug, apiKeyCreated: false, existingKeyId: existing.id }, null, 2));
  } else {
    const issued = await repository.createApiKey({ tenantId: tenantSlug, name: "bootstrap-admin", environment, roles: [...API_ROLES] });
    console.log(JSON.stringify({ tenantId: tenantSlug, apiKeyCreated: true, apiKey: issued.token, key: issued.key, warning: "Store this API key now; it cannot be retrieved later." }, null, 2));
  }
} finally {
  await pool.end();
}

function parseKeyRing(value: string | undefined) {
  if (!value) return [];
  const parsed = JSON.parse(value) as Record<string, string>;
  return Object.entries(parsed).map(([id, secret]) => ({ id, secret }));
}
