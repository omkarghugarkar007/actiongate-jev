import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_POLICY, type AuthorizationRequest, type Policy, type RiskClass } from "@actiongate/core";

export const API_ROLES = ["authorize", "consume", "decision_reader", "policy_admin", "reviewer", "key_admin", "audit_exporter"] as const;
export type ApiRole = typeof API_ROLES[number];
export type ApiEnvironment = AuthorizationRequest["environment"];

export interface AuthPrincipal {
  keyId: string;
  keyName: string;
  tenantId: string;
  environment: ApiEnvironment;
  roles: ApiRole[];
}

export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  tenantId: string;
  environment: ApiEnvironment;
  roles: ApiRole[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface IssuedApiKey { token: string; key: ApiKeyMetadata }

export interface ToolRegistration {
  name: string;
  operation: string;
  riskClass: RiskClass;
  argumentSchema: Record<string, unknown>;
  owner: string;
  dataSensitivity: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  policyId: string;
  policyVersion: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OverrideRecord {
  id: string;
  tenantId: string;
  decisionId: string;
  correctDecision: "ALLOW" | "REVIEW" | "BLOCK";
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  tenantId: string;
  decisionId: string;
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  reason: string;
  assignee?: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  /** Distinct reviewer key IDs that have approved. Two-person approval needs two. */
  approvals?: string[];
  requiredApprovals?: number;
  escalatedTo?: string;
  escalationNote?: string;
}

/**
 * Execution outcome, recorded separately from authorization. An authorized action
 * is not a completed one, so these statuses never merge into the decision record.
 */
export interface ExecutionRecord {
  id: string;
  tenantId: string;
  decisionId: string;
  grantId?: string;
  status: "ATTEMPTED" | "COMPLETED" | "FAILED" | "REVERSED";
  detail?: string;
  externalRef?: string;
  recordedBy: string;
  recordedAt: string;
}

export interface CreateReviewInput {
  tenantId: string;
  decisionId: string;
  reason: string;
  assignee?: string;
  expiresAt: string;
  createdBy: string;
  /** Defaults to 1. Set 2 or more to require independent reviewers. */
  requiredApprovals?: number;
}

export type ReviewResolution =
  | { status: "PENDING_APPROVALS"; review: ReviewRecord }
  | { status: "RESOLVED"; review: ReviewRecord }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_APPROVED_BY_ACTOR"; review: ReviewRecord };

export interface AuditEvent {
  id: string;
  tenantId: string;
  eventType: string;
  objectId: string;
  actorKeyId: string;
  payload: unknown;
  createdAt: string;
}

export interface ControlPlaneRepository {
  authenticate(token: string): Promise<AuthPrincipal | undefined>;
  createApiKey(input: { tenantId: string; name: string; environment: ApiEnvironment; roles: ApiRole[] }): Promise<IssuedApiKey>;
  listApiKeys(tenantId: string): Promise<ApiKeyMetadata[]>;
  revokeApiKey(tenantId: string, keyId: string, revokedAt: Date): Promise<ApiKeyMetadata | undefined>;
  listPolicies(tenantId: string): Promise<Policy[]>;
  getPolicy(tenantId: string, id: string, version?: string): Promise<Policy | undefined>;
  addPolicy(tenantId: string, policy: Policy, createdBy: string): Promise<Policy>;
  listTools(tenantId: string): Promise<ToolRegistration[]>;
  getTool(tenantId: string, name: string): Promise<ToolRegistration | undefined>;
  putTool(tenantId: string, tool: Omit<ToolRegistration, "createdAt" | "updatedAt">, actorKeyId: string): Promise<ToolRegistration>;
  createOverride(input: Omit<OverrideRecord, "id" | "createdAt">): Promise<OverrideRecord>;
  createReview(input: CreateReviewInput): Promise<ReviewRecord>;
  resolveReview(tenantId: string, reviewId: string, resolution: "APPROVED" | "DENIED", actorKeyId: string): Promise<ReviewRecord | undefined>;
  listReviews(tenantId: string, status?: ReviewRecord["status"]): Promise<ReviewRecord[]>;
  getReview(tenantId: string, reviewId: string): Promise<ReviewRecord | undefined>;
  claimReview(tenantId: string, reviewId: string, assignee: string, actorKeyId: string): Promise<ReviewRecord | undefined>;
  escalateReview(tenantId: string, reviewId: string, assignee: string, note: string, actorKeyId: string): Promise<ReviewRecord | undefined>;
  recordApproval(tenantId: string, reviewId: string, actorKeyId: string): Promise<ReviewResolution>;
  recordExecution(input: Omit<ExecutionRecord, "id" | "recordedAt">): Promise<ExecutionRecord>;
  listExecutions(tenantId: string, decisionId?: string): Promise<ExecutionRecord[]>;
  disableTools(tenantId: string, toolNames: readonly string[], actorKeyId: string): Promise<ToolRegistration[]>;
  appendAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent>;
  listAuditEvents(tenantId: string): Promise<AuditEvent[]>;
  deleteAuditEventsBefore(tenantId: string, before: Date): Promise<number>;
  ping?(): Promise<unknown>;
  close?(): Promise<void>;
}

interface StoredApiKey extends ApiKeyMetadata { hash: string }

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  private readonly keys = new Map<string, StoredApiKey>();
  private readonly policies = new Map<string, Policy[]>();
  private readonly tools = new Map<string, Map<string, ToolRegistration>>();
  private readonly overrides: OverrideRecord[] = [];
  private readonly reviews: ReviewRecord[] = [];
  private readonly executions: ExecutionRecord[] = [];
  private readonly events: AuditEvent[] = [];

  constructor(initialKeys: Array<{ token: string; tenantId: string; name?: string; environment?: ApiEnvironment; roles?: ApiRole[] }> = []) {
    for (const item of initialKeys) this.registerApiKey(item.token, item);
  }

  registerApiKey(token: string, input: { tenantId: string; name?: string; environment?: ApiEnvironment; roles?: ApiRole[] }) {
    this.ensureTenant(input.tenantId);
    const now = new Date().toISOString();
    const id = randomUUID();
    const prefix = extractKeyPrefix(token) ?? `legacy-${id.slice(0, 8)}`;
    this.keys.set(id, {
      id,
      name: input.name ?? "local-development-key",
      prefix,
      hash: hashApiKey(token),
      tenantId: input.tenantId,
      environment: input.environment ?? "development",
      roles: input.roles ?? [...API_ROLES],
      createdAt: now
    });
  }

  async authenticate(token: string) {
    const prefix = extractKeyPrefix(token);
    for (const record of this.keys.values()) {
      if (record.revokedAt || (prefix && record.prefix !== prefix) || !await verifyApiKey(token, record.hash)) continue;
      record.lastUsedAt = new Date().toISOString();
      return principalFromKey(record);
    }
    return undefined;
  }

  async createApiKey(input: { tenantId: string; name: string; environment: ApiEnvironment; roles: ApiRole[] }) {
    this.ensureTenant(input.tenantId);
    const issued = issueApiKey(input);
    this.keys.set(issued.key.id, { ...issued.key, hash: hashApiKey(issued.token) });
    return issued;
  }

  async listApiKeys(tenantId: string) {
    return [...this.keys.values()].filter((key) => key.tenantId === tenantId).map(publicKeyMetadata);
  }

  async revokeApiKey(tenantId: string, keyId: string, revokedAt: Date) {
    const record = this.keys.get(keyId);
    if (!record || record.tenantId !== tenantId) return undefined;
    record.revokedAt ??= revokedAt.toISOString();
    return publicKeyMetadata(record);
  }

  async listPolicies(tenantId: string) { this.ensureTenant(tenantId); return structuredClone(this.policies.get(tenantId)!); }
  async getPolicy(tenantId: string, id: string, version?: string) {
    this.ensureTenant(tenantId);
    const policy = [...this.policies.get(tenantId)!].reverse().find((item) => item.id === id && (!version || item.version === version));
    return policy ? structuredClone(policy) : undefined;
  }
  async addPolicy(tenantId: string, policy: Policy) {
    this.ensureTenant(tenantId);
    const versions = this.policies.get(tenantId)!;
    if (versions.some((item) => item.id === policy.id && item.version === policy.version)) throw new Error("POLICY_VERSION_EXISTS");
    versions.push(structuredClone(policy));
    return structuredClone(policy);
  }

  async listTools(tenantId: string) { this.ensureTenant(tenantId); return structuredClone([...this.tools.get(tenantId)!.values()]); }
  async getTool(tenantId: string, name: string) {
    this.ensureTenant(tenantId);
    const tool = this.tools.get(tenantId)!.get(normalizeToolName(name));
    return tool ? structuredClone(tool) : undefined;
  }
  async putTool(tenantId: string, tool: Omit<ToolRegistration, "createdAt" | "updatedAt">) {
    this.ensureTenant(tenantId);
    const name = normalizeToolName(tool.name);
    const existing = this.tools.get(tenantId)!.get(name);
    const now = new Date().toISOString();
    const stored = { ...structuredClone(tool), name, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.tools.get(tenantId)!.set(name, stored);
    return structuredClone(stored);
  }

  async createOverride(input: Omit<OverrideRecord, "id" | "createdAt">) {
    const record = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.overrides.push(record);
    return structuredClone(record);
  }

  async createReview(input: CreateReviewInput) {
    const record: ReviewRecord = {
      ...input,
      id: randomUUID(),
      status: "PENDING",
      approvals: [],
      requiredApprovals: Math.max(1, input.requiredApprovals ?? 1),
      createdAt: new Date().toISOString()
    };
    this.reviews.push(record);
    return structuredClone(record);
  }

  async resolveReview(tenantId: string, reviewId: string, resolution: "APPROVED" | "DENIED", actorKeyId: string) {
    const record = this.findPendingReview(tenantId, reviewId);
    if (!record) return undefined;
    if (this.expireIfDue(record)) return structuredClone(record);
    record.status = resolution;
    record.resolvedBy = actorKeyId;
    record.resolvedAt = new Date().toISOString();
    return structuredClone(record);
  }

  async listReviews(tenantId: string, status?: ReviewRecord["status"]) {
    const now = Date.now();
    for (const review of this.reviews) {
      if (review.tenantId === tenantId && review.status === "PENDING" && Date.parse(review.expiresAt) <= now) review.status = "EXPIRED";
    }
    return structuredClone(this.reviews.filter((review) => review.tenantId === tenantId && (!status || review.status === status)));
  }

  async getReview(tenantId: string, reviewId: string) {
    const record = this.reviews.find((review) => review.tenantId === tenantId && review.id === reviewId);
    return record ? structuredClone(record) : undefined;
  }

  async claimReview(tenantId: string, reviewId: string, assignee: string, _actorKeyId: string) {
    const record = this.findPendingReview(tenantId, reviewId);
    if (!record) return undefined;
    if (this.expireIfDue(record)) return structuredClone(record);
    // First claim wins; a second claimer sees the existing assignee rather than
    // silently taking over someone else's review.
    if (record.assignee && record.assignee !== assignee) return structuredClone(record);
    record.assignee = assignee;
    return structuredClone(record);
  }

  async escalateReview(tenantId: string, reviewId: string, assignee: string, note: string, _actorKeyId: string) {
    const record = this.findPendingReview(tenantId, reviewId);
    if (!record) return undefined;
    if (this.expireIfDue(record)) return structuredClone(record);
    record.escalatedTo = assignee;
    record.escalationNote = note;
    record.assignee = assignee;
    return structuredClone(record);
  }

  async recordApproval(tenantId: string, reviewId: string, actorKeyId: string): Promise<ReviewResolution> {
    const record = this.findPendingReview(tenantId, reviewId);
    if (!record) return { status: "NOT_FOUND" };
    if (this.expireIfDue(record)) return { status: "RESOLVED", review: structuredClone(record) };
    const approvals = record.approvals ?? (record.approvals = []);
    // Two-person approval means two distinct reviewers, so the same key cannot
    // satisfy both halves by approving twice.
    if (approvals.includes(actorKeyId)) return { status: "ALREADY_APPROVED_BY_ACTOR", review: structuredClone(record) };
    approvals.push(actorKeyId);
    if (approvals.length < (record.requiredApprovals ?? 1)) return { status: "PENDING_APPROVALS", review: structuredClone(record) };
    record.status = "APPROVED";
    record.resolvedBy = actorKeyId;
    record.resolvedAt = new Date().toISOString();
    return { status: "RESOLVED", review: structuredClone(record) };
  }

  async recordExecution(input: Omit<ExecutionRecord, "id" | "recordedAt">) {
    const record: ExecutionRecord = { ...input, id: randomUUID(), recordedAt: new Date().toISOString() };
    this.executions.push(record);
    return structuredClone(record);
  }

  async listExecutions(tenantId: string, decisionId?: string) {
    return structuredClone(this.executions.filter((item) => item.tenantId === tenantId && (!decisionId || item.decisionId === decisionId)));
  }

  async disableTools(tenantId: string, toolNames: readonly string[], actorKeyId: string) {
    const disabled: ToolRegistration[] = [];
    for (const name of toolNames) {
      const existing = await this.getTool(tenantId, name);
      if (!existing || !existing.enabled) continue;
      void actorKeyId;
      disabled.push(await this.putTool(tenantId, { ...existing, enabled: false }));
    }
    return disabled;
  }

  private findPendingReview(tenantId: string, reviewId: string) {
    const record = this.reviews.find((review) => review.tenantId === tenantId && review.id === reviewId);
    return record && record.status === "PENDING" ? record : undefined;
  }

  private expireIfDue(record: ReviewRecord) {
    if (Date.parse(record.expiresAt) > Date.now()) return false;
    record.status = "EXPIRED";
    return true;
  }

  async appendAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">) {
    const existing = this.events.find((item) => item.tenantId === event.tenantId && item.eventType === event.eventType && item.objectId === event.objectId);
    if (existing) return structuredClone(existing);
    const record = { ...structuredClone(event), id: randomUUID(), createdAt: new Date().toISOString() };
    this.events.push(record);
    return structuredClone(record);
  }
  async listAuditEvents(tenantId: string) { return structuredClone(this.events.filter((event) => event.tenantId === tenantId)); }
  async deleteAuditEventsBefore(tenantId: string, before: Date) {
    let deleted = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]!;
      if (event.tenantId === tenantId && Date.parse(event.createdAt) < before.getTime()) { this.events.splice(index, 1); deleted += 1; }
    }
    return deleted;
  }

  private ensureTenant(tenantId: string) {
    if (!this.policies.has(tenantId)) this.policies.set(tenantId, [structuredClone(DEFAULT_POLICY)]);
    if (!this.tools.has(tenantId)) this.tools.set(tenantId, defaultToolRegistrations());
  }
}

export function issueApiKey(input: { tenantId: string; name: string; environment: ApiEnvironment; roles: ApiRole[] }): IssuedApiKey {
  const prefix = randomBytes(6).toString("hex");
  const token = `agk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    key: {
      id: randomUUID(),
      name: input.name,
      prefix,
      tenantId: input.tenantId,
      environment: input.environment,
      roles: [...new Set(input.roles)],
      createdAt: new Date().toISOString()
    }
  };
}

export function hashApiKey(token: string, salt = randomBytes(16)): string {
  const digest = scryptSync(token, salt, 32);
  return `scrypt-v1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyApiKey(token: string, encoded: string): Promise<boolean> {
  const [version, saltValue, digestValue] = encoded.split("$");
  if (version !== "scrypt-v1" || !saltValue || !digestValue) return false;
  try {
    const supplied = await deriveScrypt(token, Buffer.from(saltValue, "base64url"));
    const expected = Buffer.from(digestValue, "base64url");
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  } catch { return false; }
}

function deriveScrypt(token: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(token, salt, 32, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

export function extractKeyPrefix(token: string) {
  return /^agk_([a-f0-9]{12})_[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
}

export function defaultToolRegistrations() {
  const result = new Map<string, ToolRegistration>();
  const now = new Date().toISOString();
  for (const [name, policy] of Object.entries(DEFAULT_POLICY.tools)) {
    result.set(name, {
      name,
      operation: policy.operation,
      riskClass: policy.riskClass,
      argumentSchema: defaultArgumentSchema(name),
      owner: "actiongate-bootstrap",
      dataSensitivity: name === "get_order" ? "CONFIDENTIAL" : "RESTRICTED",
      policyId: DEFAULT_POLICY.id,
      policyVersion: DEFAULT_POLICY.version,
      enabled: policy.enabled,
      createdAt: now,
      updatedAt: now
    });
  }
  return result;
}

function defaultArgumentSchema(name: string): Record<string, unknown> {
  const identifier = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
  if (name === "refund_payment") return {
    type: "object",
    properties: { transactionId: identifier, amountCents: { type: "integer", minimum: 1, maximum: 10_000_000 } },
    required: ["transactionId", "amountCents"],
    additionalProperties: false
  };
  if (name === "get_order") return { type: "object", properties: { orderId: identifier }, required: ["orderId"], additionalProperties: false };
  if (name === "send_email") return {
    type: "object",
    properties: {
      to: { type: "string", minLength: 3, maxLength: 320, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1, maxLength: 10_000 }
    },
    required: ["to", "body"],
    additionalProperties: false
  };
  if (name === "delete_record") return { type: "object", properties: { recordId: identifier }, required: ["recordId"], additionalProperties: false };
  return { type: "object", properties: {}, additionalProperties: false };
}

function principalFromKey(record: StoredApiKey): AuthPrincipal {
  return { keyId: record.id, keyName: record.name, tenantId: record.tenantId, environment: record.environment, roles: [...record.roles] };
}

function publicKeyMetadata(record: StoredApiKey): ApiKeyMetadata {
  return structuredClone({
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    tenantId: record.tenantId,
    environment: record.environment,
    roles: record.roles,
    createdAt: record.createdAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {})
  });
}

function normalizeToolName(name: string) { return name.trim().toLowerCase(); }
