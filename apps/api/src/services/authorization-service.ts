import { AuthorizationEngine, actionFingerprint, redactSecrets, type AuthorizationRequest, type AuthorizationResponse, type Policy } from "@actiongate/core";
import type { DecisionRepository } from "./repository.js";

export class IdempotencyConflictError extends Error { constructor() { super("IDEMPOTENCY_CONFLICT"); } }
export class IdempotencyBusyError extends Error { constructor() { super("IDEMPOTENCY_BUSY"); } }

export class AuthorizationService {
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<AuthorizationResponse> }>();
  constructor(
    private readonly engine: AuthorizationEngine,
    private readonly repository: DecisionRepository,
    private readonly idempotencyWaitMs = 10_000
  ) {}

  async authorize(req: AuthorizationRequest, policy: Policy): Promise<AuthorizationResponse> {
    const fingerprint = actionFingerprint(req, policy.version);
    const lockKey = `${req.tenantId}:${req.environment}:${req.idempotencyKey}`;
    const existing = await this.repository.findIdempotent(req.tenantId, req.environment, req.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return existing.response;
    }
    if (this.repository.claimIdempotency && this.repository.releaseIdempotency) {
      return this.authorizeDistributed(req, policy, fingerprint);
    }
    const pending = this.inFlight.get(lockKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return pending.promise;
    }
    const work = this.engine.authorize(req, policy).then(async (response) => {
      const stored = await this.repository.saveIdempotent(req.tenantId, req.environment, req.idempotencyKey, {
        response, fingerprint, tenantId: req.tenantId, sanitizedRequest: redactSecrets(req)
      });
      if (stored.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return stored.response;
    }).finally(() => this.inFlight.delete(lockKey));
    this.inFlight.set(lockKey, { fingerprint, promise: work });
    return work;
  }

  private async authorizeDistributed(req: AuthorizationRequest, policy: Policy, fingerprint: string): Promise<AuthorizationResponse> {
    const deadline = Date.now() + this.idempotencyWaitMs;
    while (Date.now() < deadline) {
      const existing = await this.repository.findIdempotent(req.tenantId, req.environment, req.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
        return existing.response;
      }

      const claim = await this.repository.claimIdempotency!(req.tenantId, req.environment, req.idempotencyKey, fingerprint);
      if (claim.status === "conflict") throw new IdempotencyConflictError();
      if (claim.status === "exists") continue;
      if (claim.status === "pending") {
        await delay(20);
        continue;
      }

      try {
        const response = await this.engine.authorize(req, policy);
        const stored = await this.repository.saveIdempotent(req.tenantId, req.environment, req.idempotencyKey, {
          response, fingerprint, tenantId: req.tenantId, sanitizedRequest: redactSecrets(req)
        });
        if (stored.fingerprint !== fingerprint) throw new IdempotencyConflictError();
        return stored.response;
      } finally {
        await this.repository.releaseIdempotency!(req.tenantId, req.environment, req.idempotencyKey, claim.leaseToken);
      }
    }
    throw new IdempotencyBusyError();
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
