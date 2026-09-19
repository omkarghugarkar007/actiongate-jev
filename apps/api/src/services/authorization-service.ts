import { AuthorizationEngine, actionFingerprint, redactSecrets, type AuthorizationRequest, type AuthorizationResponse, type Policy } from "@actiongate/core";
import type { DecisionRepository } from "./repository.js";

export class IdempotencyConflictError extends Error { constructor() { super("IDEMPOTENCY_CONFLICT"); } }

export class AuthorizationService {
  private readonly inFlight = new Map<string, Promise<AuthorizationResponse>>();
  constructor(private readonly engine: AuthorizationEngine, private readonly repository: DecisionRepository) {}

  async authorize(req: AuthorizationRequest, policy: Policy): Promise<AuthorizationResponse> {
    const fingerprint = actionFingerprint(req, policy.version);
    const lockKey = `${req.tenantId}:${req.environment}:${req.idempotencyKey}`;
    const existing = await this.repository.findIdempotent(req.tenantId, req.environment, req.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return existing.response;
    }
    const pending = this.inFlight.get(lockKey);
    if (pending) return pending;
    const work = this.engine.authorize(req, policy).then(async (response) => {
      await this.repository.saveIdempotent(req.tenantId, req.environment, req.idempotencyKey, {
        response, fingerprint, tenantId: req.tenantId, sanitizedRequest: redactSecrets(req)
      });
      return response;
    }).finally(() => this.inFlight.delete(lockKey));
    this.inFlight.set(lockKey, work);
    return work;
  }
}

