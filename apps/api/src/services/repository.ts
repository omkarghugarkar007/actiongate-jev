import type { AuthorizationResponse, Policy } from "@actiongate/core";

export interface AuditRecord { response: AuthorizationResponse; fingerprint: string; tenantId: string; sanitizedRequest: unknown }
export interface DecisionRepository {
  findIdempotent(tenantId: string, environment: string, key: string): Promise<AuditRecord | undefined>;
  saveIdempotent(tenantId: string, environment: string, key: string, record: AuditRecord): Promise<void>;
  list(tenantId: string): Promise<AuditRecord[]>;
  get(tenantId: string, id: string): Promise<AuditRecord | undefined>;
}

export class InMemoryDecisionRepository implements DecisionRepository {
  private readonly records = new Map<string, AuditRecord>();
  private key(tenant: string, env: string, key: string) { return `${tenant}:${env}:${key}`; }
  async findIdempotent(tenant: string, env: string, key: string) { return this.records.get(this.key(tenant, env, key)); }
  async saveIdempotent(tenant: string, env: string, key: string, record: AuditRecord) { this.records.set(this.key(tenant, env, key), record); }
  async list(tenant: string) { return [...this.records.values()].filter((x) => x.tenantId === tenant).sort((a, b) => b.response.createdAt.localeCompare(a.response.createdAt)); }
  async get(tenant: string, id: string) { return [...this.records.values()].find((x) => x.tenantId === tenant && x.response.decisionId === id); }
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

