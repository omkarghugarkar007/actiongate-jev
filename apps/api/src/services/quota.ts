/**
 * Per-tenant quotas and rate limits.
 *
 * Kept separate from the global rate limiter: a global limit protects the
 * process, while a tenant quota stops one tenant consuming the provider budget
 * or the review queue that another tenant depends on.
 */
export interface TenantQuota {
  /** Authorization requests allowed per window. */
  authorizePerMinute?: number;
  /** Provider spend allowed per day, in USD. */
  providerCostUsdPerDay?: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: "RATE_LIMIT" | "COST_BUDGET";
  retryAfterSeconds?: number;
  remaining?: number;
}

interface Window { resetAt: number; count: number }

export class QuotaEnforcer {
  private readonly minuteWindows = new Map<string, Window>();
  private readonly dailyCost = new Map<string, Window>();

  constructor(
    private readonly quotas: Readonly<Record<string, TenantQuota>>,
    private readonly defaults: TenantQuota = {},
    private readonly clock: () => number = Date.now
  ) {}

  quotaFor(tenantId: string): TenantQuota {
    return { ...this.defaults, ...this.quotas[tenantId] };
  }

  /** Call before doing the work. Counts the attempt, so a rejected request still
   * consumes its slot — otherwise a caller could probe the limit for free. */
  checkAuthorize(tenantId: string): QuotaDecision {
    const limit = this.quotaFor(tenantId).authorizePerMinute;
    if (!limit) return { allowed: true };
    const now = this.clock();
    const window = this.minuteWindows.get(tenantId);
    if (!window || window.resetAt <= now) {
      this.minuteWindows.set(tenantId, { resetAt: now + 60_000, count: 1 });
      return { allowed: true, remaining: limit - 1 };
    }
    window.count += 1;
    if (window.count > limit) {
      return { allowed: false, reason: "RATE_LIMIT", retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)), remaining: 0 };
    }
    return { allowed: true, remaining: limit - window.count };
  }

  /** Checked before a request, using spend already recorded. A single request
   * cannot be split, so the budget is allowed to overshoot by at most one call. */
  checkCostBudget(tenantId: string): QuotaDecision {
    const budget = this.quotaFor(tenantId).providerCostUsdPerDay;
    if (!budget) return { allowed: true };
    const now = this.clock();
    const window = this.dailyCost.get(tenantId);
    if (!window || window.resetAt <= now) return { allowed: true };
    if (window.count >= budget) {
      return { allowed: false, reason: "COST_BUDGET", retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
    }
    return { allowed: true };
  }

  recordCost(tenantId: string, costUsd: number): void {
    if (costUsd <= 0) return;
    const now = this.clock();
    const window = this.dailyCost.get(tenantId);
    if (!window || window.resetAt <= now) {
      this.dailyCost.set(tenantId, { resetAt: now + 86_400_000, count: costUsd });
      return;
    }
    window.count += costUsd;
  }

  spendToday(tenantId: string): number {
    const window = this.dailyCost.get(tenantId);
    return window && window.resetAt > this.clock() ? window.count : 0;
  }
}
