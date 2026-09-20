import { ActionGrantError, type ActionGrantClaims, type AuthorizationResponse, type Policy } from "@actiongate/core";

export interface AuditRecord { response: AuthorizationResponse; fingerprint: string; tenantId: string; sanitizedRequest: unknown }
export type IdempotencyClaim =
  | { status: "acquired"; leaseToken: string }
  | { status: "exists" }
  | { status: "pending" }
  | { status: "conflict" };

export interface DecisionRepository {
  findIdempotent(tenantId: string, environment: string, key: string): Promise<AuditRecord | undefined>;
  saveIdempotent(tenantId: string, environment: string, key: string, record: AuditRecord): Promise<AuditRecord>;
  list(tenantId: string): Promise<AuditRecord[]>;
  get(tenantId: string, id: string): Promise<AuditRecord | undefined>;
  deleteBefore?(tenantId: string, before: Date): Promise<number>;
  claimIdempotency?(tenantId: string, environment: string, key: string, fingerprint: string): Promise<IdempotencyClaim>;
  releaseIdempotency?(tenantId: string, environment: string, key: string, leaseToken: string): Promise<void>;
}

export interface GrantRecord {
  claims: ActionGrantClaims;
  tokenHash: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface GrantRepository {
  findByDecision(decisionId: string): Promise<GrantRecord | undefined>;
  saveIfAbsent(record: GrantRecord): Promise<GrantRecord>;
  consume(grantId: string, tokenHash: string, now: Date): Promise<GrantRecord>;
  revoke(grantId: string, tenantId: string, now: Date): Promise<GrantRecord>;
}

export class InMemoryGrantRepository implements GrantRepository {
  private readonly byId = new Map<string, GrantRecord>();
  private readonly idByDecision = new Map<string, string>();

  async findByDecision(decisionId: string) {
    const grantId = this.idByDecision.get(decisionId);
    return grantId ? this.byId.get(grantId) : undefined;
  }

  async saveIfAbsent(record: GrantRecord) {
    const existingId = this.idByDecision.get(record.claims.decisionId);
    if (existingId) return this.byId.get(existingId)!;
    this.idByDecision.set(record.claims.decisionId, record.claims.grantId);
    this.byId.set(record.claims.grantId, record);
    return record;
  }

  async consume(grantId: string, tokenHash: string, now: Date) {
    const record = this.byId.get(grantId);
    if (!record || record.tokenHash !== tokenHash) throw new ActionGrantError("GRANT_NOT_FOUND");
    if (now.getTime() >= record.claims.expiresAt * 1000) throw new ActionGrantError("GRANT_EXPIRED");
    if (record.revokedAt) throw new ActionGrantError("GRANT_REVOKED");
    if (record.consumedAt) throw new ActionGrantError("GRANT_ALREADY_CONSUMED");
    record.consumedAt = now.toISOString();
    return record;
  }

  async revoke(grantId: string, tenantId: string, now: Date) {
    const record = this.byId.get(grantId);
    if (!record || record.claims.tenantId !== tenantId) throw new ActionGrantError("GRANT_NOT_FOUND");
    if (!record.revokedAt) record.revokedAt = now.toISOString();
    return record;
  }
}

export class InMemoryDecisionRepository implements DecisionRepository {
  private readonly records = new Map<string, AuditRecord>();
  private key(tenant: string, env: string, key: string) { return `${tenant}:${env}:${key}`; }
  async findIdempotent(tenant: string, env: string, key: string) { return this.records.get(this.key(tenant, env, key)); }
  async saveIdempotent(tenant: string, env: string, key: string, record: AuditRecord) {
    const storageKey = this.key(tenant, env, key);
    const existing = this.records.get(storageKey);
    if (existing) return existing;
    this.records.set(storageKey, record);
    return record;
  }
  async list(tenant: string) { return [...this.records.values()].filter((x) => x.tenantId === tenant).sort((a, b) => b.response.createdAt.localeCompare(a.response.createdAt)); }
  async get(tenant: string, id: string) { return [...this.records.values()].find((x) => x.tenantId === tenant && x.response.decisionId === id); }
  async deleteBefore(tenant: string, before: Date) {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.tenantId === tenant && Date.parse(record.response.createdAt) < before.getTime()) {
        this.records.set(key, { ...record, sanitizedRequest: { retained: false } });
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class InMemoryPolicyRepository {
  constructor(private readonly versions: Policy[]) {}
  list() { return this.versions; }
  get(id: string, version?: string) { return [...this.versions].reverse().find((p) => p.id === id && (!version || p.version === version)); }
  add(policy: Policy) {
    if (this.get(policy.id, policy.version)) throw new Error("POLICY_VERSION_EXISTS");
    this.versions.push(structuredClone(policy));
    return policy;
  }
}
