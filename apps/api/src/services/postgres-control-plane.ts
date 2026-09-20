import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson, PolicySchema, RiskClassSchema, type Policy } from "@actiongate/core";
import { EvidenceCipher, type EncryptedEnvelope } from "../security/evidence-cipher.js";
import {
  extractKeyPrefix,
  hashApiKey,
  issueApiKey,
  verifyApiKey,
  API_ROLES,
  type ApiEnvironment,
  type ApiKeyMetadata,
  type ApiRole,
  type AuditEvent,
  type AuthPrincipal,
  type ControlPlaneRepository,
  type CreateReviewInput,
  type OverrideRecord,
  type ReviewRecord,
  type ToolRegistration
} from "./control-plane.js";

const ApiEnvironmentSchema = z.enum(["development", "staging", "production"]);
const ApiRoleSchema = z.enum(API_ROLES);
const DataSensitivitySchema = z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
const ReviewStatusSchema = z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED"]);
const ReviewPayloadSchema = z.object({ reason: z.string(), assignee: z.string().optional() }).strict();

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  constructor(private readonly pool: Pool, private readonly cipher: EvidenceCipher) {}

  async authenticate(token: string): Promise<AuthPrincipal | undefined> {
    const prefix = extractKeyPrefix(token);
    if (!prefix) return undefined;
    const result = await this.pool.query<ApiKeyRow>(`
      SELECT k.id::text, k.name, k.key_prefix, k.key_hash, k.environment, k.roles, k.created_at, k.last_used_at,
             k.revoked_at, t.slug AS tenant_slug
      FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_prefix = $1 AND k.revoked_at IS NULL
    `, [prefix]);
    for (const row of result.rows) {
      if (!await verifyApiKey(token, row.key_hash)) continue;
      const scope = z.object({ environment: ApiEnvironmentSchema, roles: z.array(ApiRoleSchema).min(1) }).safeParse(row);
      if (!scope.success) continue;
      await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]);
      return { keyId: row.id, keyName: row.name, tenantId: row.tenant_slug, environment: scope.data.environment, roles: scope.data.roles };
    }
    return undefined;
  }

  async createApiKey(input: { tenantId: string; name: string; environment: ApiEnvironment; roles: ApiRole[] }) {
    const tenantId = await this.tenantUuid(input.tenantId);
    const issued = issueApiKey(input);
    await this.pool.query(`
      INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, environment, roles, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    `, [issued.key.id, tenantId, issued.key.name, issued.key.prefix, hashApiKey(issued.token), issued.key.environment, JSON.stringify(issued.key.roles), issued.key.createdAt]);
    return issued;
  }

  async listApiKeys(tenantId: string) {
    const result = await this.pool.query<ApiKeyRow>(`
      SELECT k.id::text, k.name, k.key_prefix, k.key_hash, k.environment, k.roles, k.created_at, k.last_used_at,
             k.revoked_at, t.slug AS tenant_slug
      FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE t.slug = $1 ORDER BY k.created_at DESC
    `, [tenantId]);
    return result.rows.map(apiKeyMetadata);
  }

  async revokeApiKey(tenantId: string, keyId: string, revokedAt: Date) {
    const result = await this.pool.query<ApiKeyRow>(`
      UPDATE api_keys k SET revoked_at = COALESCE(k.revoked_at, $3)
      FROM tenants t
      WHERE k.id = $1 AND k.tenant_id = t.id AND t.slug = $2
      RETURNING k.id::text, k.name, k.key_prefix, k.key_hash, k.environment, k.roles, k.created_at,
                k.last_used_at, k.revoked_at, t.slug AS tenant_slug
    `, [keyId, tenantId, revokedAt]);
    return result.rows[0] ? apiKeyMetadata(result.rows[0]) : undefined;
  }

  async listPolicies(tenantId: string) {
    const result = await this.pool.query<{ document_json: Policy }>(`
      SELECT pv.document_json FROM policy_versions pv
      JOIN policies p ON p.id = pv.policy_id JOIN tenants t ON t.id = p.tenant_id
      WHERE t.slug = $1 ORDER BY pv.created_at ASC
    `, [tenantId]);
    return result.rows.map((row) => PolicySchema.parse(row.document_json) as Policy);
  }

  async getPolicy(tenantId: string, id: string, version?: string) {
    const values: unknown[] = [tenantId, id];
    const versionFilter = version ? "AND pv.version = $3" : "";
    if (version) values.push(version);
    const result = await this.pool.query<{ document_json: Policy }>(`
      SELECT pv.document_json FROM policy_versions pv
      JOIN policies p ON p.id = pv.policy_id JOIN tenants t ON t.id = p.tenant_id
      WHERE t.slug = $1 AND p.name = $2 ${versionFilter}
      ORDER BY pv.created_at DESC LIMIT 1
    `, values);
    return result.rows[0] ? PolicySchema.parse(result.rows[0].document_json) as Policy : undefined;
  }

  async addPolicy(tenantId: string, policy: Policy, createdBy: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tenantUuid = await this.tenantUuid(tenantId, client);
      const policyResult = await client.query<{ id: string }>(`
        INSERT INTO policies (tenant_id, name) VALUES ($1, $2)
        ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id::text
      `, [tenantUuid, policy.id]);
      const policyUuid = policyResult.rows[0]!.id;
      await client.query(`
        INSERT INTO policy_versions (policy_id, version, document_json, checksum, created_by)
        VALUES ($1, $2, $3::jsonb, $4, $5)
      `, [policyUuid, policy.version, JSON.stringify(policy), documentChecksum(policy), createdBy]);
      await client.query("COMMIT");
      return structuredClone(policy);
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new Error("POLICY_VERSION_EXISTS", { cause: error });
      throw error;
    } finally { client.release(); }
  }

  async listTools(tenantId: string) {
    const result = await this.pool.query<ToolRow>(`
      SELECT tr.name, tr.operation, tr.risk_class, tr.argument_schema, tr.owner, tr.data_sensitivity,
             tr.policy_name, tr.policy_version, tr.enabled, tr.created_at, tr.updated_at
      FROM tool_registry tr JOIN tenants t ON t.id = tr.tenant_id
      WHERE t.slug = $1 ORDER BY tr.name
    `, [tenantId]);
    return result.rows.map(toolRegistration);
  }

  async getTool(tenantId: string, name: string) {
    const result = await this.pool.query<ToolRow>(`
      SELECT tr.name, tr.operation, tr.risk_class, tr.argument_schema, tr.owner, tr.data_sensitivity,
             tr.policy_name, tr.policy_version, tr.enabled, tr.created_at, tr.updated_at
      FROM tool_registry tr JOIN tenants t ON t.id = tr.tenant_id
      WHERE t.slug = $1 AND tr.name = $2
    `, [tenantId, normalizeName(name)]);
    return result.rows[0] ? toolRegistration(result.rows[0]) : undefined;
  }

  async putTool(tenantId: string, tool: Omit<ToolRegistration, "createdAt" | "updatedAt">, _actorKeyId: string) {
    const tenantUuid = await this.tenantUuid(tenantId);
    const result = await this.pool.query<ToolRow>(`
      INSERT INTO tool_registry (tenant_id, name, operation, risk_class, argument_schema, owner, data_sensitivity, policy_name, policy_version, enabled)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, name) DO UPDATE SET operation = EXCLUDED.operation, risk_class = EXCLUDED.risk_class,
        argument_schema = EXCLUDED.argument_schema, owner = EXCLUDED.owner, data_sensitivity = EXCLUDED.data_sensitivity,
        policy_name = EXCLUDED.policy_name, policy_version = EXCLUDED.policy_version, enabled = EXCLUDED.enabled, updated_at = now()
      RETURNING name, operation, risk_class, argument_schema, owner, data_sensitivity, policy_name, policy_version, enabled, created_at, updated_at
    `, [tenantUuid, normalizeName(tool.name), tool.operation, tool.riskClass, JSON.stringify(tool.argumentSchema), tool.owner, tool.dataSensitivity, tool.policyId, tool.policyVersion, tool.enabled]);
    return toolRegistration(result.rows[0]!);
  }

  async createOverride(input: Omit<OverrideRecord, "id" | "createdAt">) {
    const id = randomUUID();
    const tenantUuid = await this.tenantUuid(input.tenantId);
    const createdAt = new Date().toISOString();
    const encrypted = this.cipher.encrypt({ correctDecision: input.correctDecision, reason: input.reason }, `override:${input.tenantId}:${id}`);
    await this.pool.query(`
      INSERT INTO decision_corrections (id, tenant_id, decision_id, payload_encrypted, created_by, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    `, [id, tenantUuid, input.decisionId, JSON.stringify(encrypted), input.createdBy, createdAt]);
    return { ...input, id, createdAt };
  }

  async createReview(input: CreateReviewInput): Promise<ReviewRecord> {
    const id = randomUUID();
    const tenantUuid = await this.tenantUuid(input.tenantId);
    const createdAt = new Date().toISOString();
    const encrypted = this.cipher.encrypt({ reason: input.reason, assignee: input.assignee }, `review:${input.tenantId}:${id}`);
    await this.pool.query(`
      INSERT INTO reviews (id, tenant_id, decision_id, status, payload_encrypted, expires_at, created_by, created_at)
      VALUES ($1, $2, $3, 'PENDING', $4::jsonb, $5, $6, $7)
    `, [id, tenantUuid, input.decisionId, JSON.stringify(encrypted), input.expiresAt, input.createdBy, createdAt]);
    return {
      id,
      tenantId: input.tenantId,
      decisionId: input.decisionId,
      status: "PENDING",
      reason: input.reason,
      ...(input.assignee ? { assignee: input.assignee } : {}),
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      createdAt
    };
  }

  async resolveReview(tenantId: string, reviewId: string, resolution: "APPROVED" | "DENIED", actorKeyId: string) {
    const result = await this.pool.query<ReviewRow>(`
      UPDATE reviews r SET status = CASE WHEN r.expires_at <= now() THEN 'EXPIRED' ELSE $3 END,
        resolved_by = CASE WHEN r.expires_at <= now() THEN NULL ELSE $4 END,
        resolved_at = CASE WHEN r.expires_at <= now() THEN NULL ELSE now() END
      FROM tenants t WHERE r.id = $1 AND r.tenant_id = t.id AND t.slug = $2 AND r.status = 'PENDING'
      RETURNING r.id::text, r.decision_id::text, r.status, r.payload_encrypted, r.expires_at, r.created_by,
                r.created_at, r.resolved_by, r.resolved_at
    `, [reviewId, tenantId, resolution, actorKeyId]);
    return result.rows[0] ? this.reviewRecord(tenantId, result.rows[0]) : undefined;
  }

  async appendAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">) {
    const id = randomUUID();
    const tenantUuid = await this.tenantUuid(event.tenantId);
    const createdAt = new Date().toISOString();
    const encrypted = this.cipher.encrypt(event.payload, `audit:${event.tenantId}:${event.eventType}:${event.objectId}`);
    const result = await this.pool.query<AuditRow>(`
      INSERT INTO audit_events (id, tenant_id, event_type, object_id, actor_key_id, payload_encrypted, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (tenant_id, event_type, object_id) DO UPDATE SET object_id = EXCLUDED.object_id
      RETURNING id::text, event_type, object_id, actor_key_id, payload_encrypted, created_at
    `, [id, tenantUuid, event.eventType, event.objectId, event.actorKeyId, JSON.stringify(encrypted), createdAt]);
    return this.auditEvent(event.tenantId, result.rows[0]!);
  }

  async listAuditEvents(tenantId: string) {
    const result = await this.pool.query<AuditRow>(`
      SELECT ae.id::text, ae.event_type, ae.object_id, ae.actor_key_id, ae.payload_encrypted, ae.created_at
      FROM audit_events ae JOIN tenants t ON t.id = ae.tenant_id
      WHERE t.slug = $1 ORDER BY ae.created_at DESC
    `, [tenantId]);
    return result.rows.map((row) => this.auditEvent(tenantId, row));
  }

  async deleteAuditEventsBefore(tenantId: string, before: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tenantUuid = await this.tenantUuid(tenantId, client);
      const result = await client.query("DELETE FROM audit_events WHERE tenant_id = $1 AND created_at < $2", [tenantUuid, before]);
      await client.query("DELETE FROM decision_corrections WHERE tenant_id = $1 AND created_at < $2", [tenantUuid, before]);
      await client.query("DELETE FROM reviews WHERE tenant_id = $1 AND created_at < $2", [tenantUuid, before]);
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async ping() { return this.pool.query("SELECT 1"); }

  private async tenantUuid(slug: string, client: Pool | PoolClient = this.pool) {
    const result = await client.query<{ id: string }>("SELECT id::text FROM tenants WHERE slug = $1", [slug]);
    if (!result.rows[0]) throw new Error("TENANT_NOT_FOUND");
    return result.rows[0].id;
  }

  private auditEvent(tenantId: string, row: AuditRow): AuditEvent {
    return {
      id: row.id,
      tenantId,
      eventType: row.event_type,
      objectId: row.object_id,
      actorKeyId: row.actor_key_id,
      payload: this.cipher.decrypt(row.payload_encrypted, `audit:${tenantId}:${row.event_type}:${row.object_id}`),
      createdAt: dateString(row.created_at)
    };
  }

  private reviewRecord(tenantId: string, row: ReviewRow): ReviewRecord {
    const payload = ReviewPayloadSchema.parse(this.cipher.decrypt(row.payload_encrypted, `review:${tenantId}:${row.id}`));
    const status = ReviewStatusSchema.parse(row.status);
    return {
      id: row.id,
      tenantId,
      decisionId: row.decision_id,
      status,
      reason: payload.reason,
      ...(payload.assignee ? { assignee: payload.assignee } : {}),
      expiresAt: dateString(row.expires_at),
      createdBy: row.created_by,
      createdAt: dateString(row.created_at),
      ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
      ...(row.resolved_at ? { resolvedAt: dateString(row.resolved_at) } : {})
    };
  }
}

interface ApiKeyRow {
  id: string; name: string; key_prefix: string; key_hash: string; environment: unknown; roles: unknown;
  tenant_slug: string; created_at: Date | string; last_used_at: Date | string | null; revoked_at: Date | string | null;
}
interface ToolRow {
  name: string; operation: string; risk_class: unknown; argument_schema: unknown;
  owner: string; data_sensitivity: unknown; policy_name: string; policy_version: string; enabled: boolean;
  created_at: Date | string; updated_at: Date | string;
}
interface AuditRow { id: string; event_type: string; object_id: string; actor_key_id: string; payload_encrypted: EncryptedEnvelope; created_at: Date | string }
interface ReviewRow {
  id: string; decision_id: string; status: unknown; payload_encrypted: EncryptedEnvelope; expires_at: Date | string;
  created_by: string; created_at: Date | string; resolved_by: string | null; resolved_at: Date | string | null;
}

function apiKeyMetadata(row: ApiKeyRow): ApiKeyMetadata {
  const environment = ApiEnvironmentSchema.parse(row.environment);
  const roles = z.array(ApiRoleSchema).min(1).parse(row.roles);
  return {
    id: row.id, name: row.name, prefix: row.key_prefix, tenantId: row.tenant_slug, environment,
    roles, createdAt: dateString(row.created_at),
    ...(row.last_used_at ? { lastUsedAt: dateString(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: dateString(row.revoked_at) } : {})
  };
}
function toolRegistration(row: ToolRow): ToolRegistration {
  return {
    name: row.name, operation: row.operation, riskClass: RiskClassSchema.parse(row.risk_class),
    argumentSchema: z.record(z.string(), z.unknown()).parse(row.argument_schema),
    owner: row.owner, dataSensitivity: DataSensitivitySchema.parse(row.data_sensitivity),
    policyId: row.policy_name, policyVersion: row.policy_version, enabled: row.enabled,
    createdAt: dateString(row.created_at), updatedAt: dateString(row.updated_at)
  };
}
function dateString(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function normalizeName(name: string) { return name.trim().toLowerCase(); }
function documentChecksum(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505"); }
