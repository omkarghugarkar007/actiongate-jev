import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ActionGrantError, type ActionGrantClaims } from "@actiongate/core";
import type { AuditRecord, DecisionRepository, GrantRecord, GrantRepository, IdempotencyClaim } from "./repository.js";

const CLAIM_SCRIPT = `
if redis.call("GET", KEYS[1]) then return "EXISTS" end
local current = redis.call("GET", KEYS[2])
if current then
  if string.sub(current, 1, 64) ~= ARGV[1] then return "CONFLICT" end
  return "PENDING"
end
redis.call("SET", KEYS[2], ARGV[1] .. ":" .. ARGV[2], "PX", ARGV[3])
return "ACQUIRED"
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

const SAVE_DECISION_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then return existing end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[2], ARGV[1])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[3])
return ARGV[1]
`;

const SAVE_GRANT_SCRIPT = `
local existingId = redis.call("GET", KEYS[1])
if existingId then
  local existingRecord = redis.call("GET", ARGV[3] .. existingId .. ":record")
  if existingRecord then return existingRecord end
  return "TOMBSTONE"
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[2], ARGV[2])
return ARGV[2]
`;

const CONSUME_GRANT_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "NOT_FOUND" end
local record = cjson.decode(raw)
if record.tokenHash ~= ARGV[1] then return "NOT_FOUND" end
if tonumber(ARGV[2]) >= tonumber(record.claims.expiresAt) * 1000 then return "EXPIRED" end
local consumed = redis.call("GET", KEYS[2])
if consumed then return "ALREADY:" .. consumed end
redis.call("SET", KEYS[2], ARGV[3])
return "CONSUMED:" .. ARGV[3]
`;

export interface RedisRepositoryOptions {
  prefix?: string;
  idempotencyLeaseMs?: number;
}

export class RedisDecisionRepository implements DecisionRepository {
  private readonly prefix: string;
  private readonly leaseMs: number;

  constructor(private readonly redis: Redis, options: RedisRepositoryOptions = {}) {
    this.prefix = validatePrefix(options.prefix ?? "actiongate");
    this.leaseMs = options.idempotencyLeaseMs ?? 15_000;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000) throw new Error("Idempotency lease must be at least 1000ms");
  }

  async findIdempotent(tenantId: string, environment: string, key: string) {
    return parseAuditRecord(await this.redis.get(this.idempotencyKey(tenantId, environment, key)));
  }

  async claimIdempotency(tenantId: string, environment: string, key: string, fingerprint: string): Promise<IdempotencyClaim> {
    const leaseToken = randomUUID();
    const result = String(await this.redis.eval(
      CLAIM_SCRIPT,
      2,
      this.idempotencyKey(tenantId, environment, key),
      this.lockKey(tenantId, environment, key),
      fingerprint,
      leaseToken,
      this.leaseMs
    ));
    if (result === "ACQUIRED") return { status: "acquired", leaseToken };
    if (result === "EXISTS") return { status: "exists" };
    if (result === "CONFLICT") return { status: "conflict" };
    return { status: "pending" };
  }

  async releaseIdempotency(tenantId: string, environment: string, key: string, leaseToken: string) {
    const fingerprintRecord = await this.redis.get(this.lockKey(tenantId, environment, key));
    if (!fingerprintRecord) return;
    const fingerprint = fingerprintRecord.slice(0, 64);
    await this.redis.eval(RELEASE_SCRIPT, 1, this.lockKey(tenantId, environment, key), `${fingerprint}:${leaseToken}`);
  }

  async saveIdempotent(tenantId: string, environment: string, key: string, record: AuditRecord) {
    const serialized = JSON.stringify(record);
    const stored = await this.redis.eval(
      SAVE_DECISION_SCRIPT,
      3,
      this.idempotencyKey(tenantId, environment, key),
      this.decisionKey(record.response.decisionId),
      this.tenantIndexKey(tenantId),
      serialized,
      Date.parse(record.response.createdAt),
      record.response.decisionId
    );
    return JSON.parse(String(stored)) as AuditRecord;
  }

  async list(tenantId: string) {
    const ids = await this.redis.zrevrange(this.tenantIndexKey(tenantId), 0, -1);
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map((id) => this.decisionKey(id)));
    return values.flatMap((value) => {
      const record = parseAuditRecord(value);
      return record?.tenantId === tenantId ? [record] : [];
    });
  }

  async get(tenantId: string, id: string) {
    const record = parseAuditRecord(await this.redis.get(this.decisionKey(id)));
    return record?.tenantId === tenantId ? record : undefined;
  }

  async ping() { return this.redis.ping(); }

  private idempotencyKey(tenantId: string, environment: string, key: string) {
    return `${this.prefix}:decision:idem:${digest(`${tenantId}\0${environment}\0${key}`)}`;
  }
  private lockKey(tenantId: string, environment: string, key: string) {
    return `${this.prefix}:decision:lock:${digest(`${tenantId}\0${environment}\0${key}`)}`;
  }
  private decisionKey(id: string) { return `${this.prefix}:decision:id:${id}`; }
  private tenantIndexKey(tenantId: string) { return `${this.prefix}:decision:tenant:${digest(tenantId)}`; }
}

export class RedisGrantRepository implements GrantRepository {
  private readonly prefix: string;

  constructor(private readonly redis: Redis, options: RedisRepositoryOptions = {}) {
    this.prefix = validatePrefix(options.prefix ?? "actiongate");
  }

  async findByDecision(decisionId: string) {
    const grantId = await this.redis.get(this.decisionKey(decisionId));
    if (!grantId) return undefined;
    const raw = await this.redis.get(this.recordKey(grantId));
    if (!raw) throw new Error("GRANT_RECORD_TOMBSTONED");
    return this.withConsumption(JSON.parse(raw) as StoredGrantRecord);
  }

  async saveIfAbsent(record: GrantRecord) {
    const stored: StoredGrantRecord = { claims: record.claims, tokenHash: record.tokenHash };
    const result = String(await this.redis.eval(
      SAVE_GRANT_SCRIPT,
      2,
      this.decisionKey(record.claims.decisionId),
      this.recordKey(record.claims.grantId),
      record.claims.grantId,
      JSON.stringify(stored),
      `${this.prefix}:grant:id:`
    ));
    if (result === "TOMBSTONE") throw new Error("GRANT_RECORD_TOMBSTONED");
    return this.withConsumption(JSON.parse(result) as StoredGrantRecord);
  }

  async consume(grantId: string, tokenHash: string, now: Date) {
    const result = String(await this.redis.eval(
      CONSUME_GRANT_SCRIPT,
      2,
      this.recordKey(grantId),
      this.consumedKey(grantId),
      tokenHash,
      now.getTime(),
      now.toISOString()
    ));
    if (result === "NOT_FOUND") throw new ActionGrantError("GRANT_NOT_FOUND");
    if (result === "EXPIRED") throw new ActionGrantError("GRANT_EXPIRED");
    if (result.startsWith("ALREADY:")) throw new ActionGrantError("GRANT_ALREADY_CONSUMED");
    const raw = await this.redis.get(this.recordKey(grantId));
    if (!raw) throw new ActionGrantError("GRANT_NOT_FOUND");
    return { ...(JSON.parse(raw) as StoredGrantRecord), consumedAt: result.slice("CONSUMED:".length) };
  }

  async ping() { return this.redis.ping(); }

  private async withConsumption(record: StoredGrantRecord): Promise<GrantRecord> {
    const consumedAt = await this.redis.get(this.consumedKey(record.claims.grantId));
    return { ...record, ...(consumedAt ? { consumedAt } : {}) };
  }
  private decisionKey(decisionId: string) { return `${this.prefix}:grant:decision:${decisionId}`; }
  private recordKey(grantId: string) { return `${this.prefix}:grant:id:${grantId}:record`; }
  private consumedKey(grantId: string) { return `${this.prefix}:grant:id:${grantId}:consumed`; }
}

interface StoredGrantRecord { claims: ActionGrantClaims; tokenHash: string }

function parseAuditRecord(value: string | null): AuditRecord | undefined {
  return value ? JSON.parse(value) as AuditRecord : undefined;
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

function validatePrefix(value: string) {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new Error("Redis prefix contains unsupported characters");
  return value;
}
