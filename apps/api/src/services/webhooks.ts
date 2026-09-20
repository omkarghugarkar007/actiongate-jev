import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface WebhookEvent {
  type: string;
  tenantId: string;
  objectId: string;
  payload: unknown;
}

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  type: string;
  objectId: string;
  attempts: number;
  status: "DELIVERED" | "DEAD";
  lastError?: string;
  createdAt: string;
}

export interface WebhookNotifier {
  notify(event: WebhookEvent): Promise<WebhookDelivery | undefined>;
  deadLetters(tenantId: string): Promise<WebhookDelivery[]>;
}

export interface SignedWebhookNotifierOptions {
  url: string;
  /** Shared with the receiver only. Independent of grant and evidence keys. */
  secret: string;
  keyId?: string;
  /** Destinations the notifier may post to. The configured url must be one of them. */
  allowedHosts?: readonly string[];
  maxAttempts?: number;
  timeoutMs?: number;
  /** Backoff between attempts. Kept injectable so tests do not sleep. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

/**
 * Posts signed notifications with bounded retries. A payload that never lands is
 * kept as a dead letter rather than dropped, so an operator can see what was
 * missed. Delivery is best-effort and never blocks an authorization decision.
 */
export class SignedWebhookNotifier implements WebhookNotifier {
  private readonly dead: WebhookDelivery[] = [];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => number;

  constructor(private readonly options: SignedWebhookNotifierOptions) {
    if (options.secret.length < 32) throw new Error("A webhook secret must be at least 32 characters");
    const host = new URL(options.url).host;
    if (options.allowedHosts && !options.allowedHosts.includes(host)) {
      throw new Error(`Webhook destination ${host} is not allowlisted`);
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
  }

  async notify(event: WebhookEvent): Promise<WebhookDelivery | undefined> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const id = randomUUID();
    const body = JSON.stringify({ id, ...event, createdAt: new Date(this.clock()).toISOString() });
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const timestamp = Math.floor(this.clock() / 1000);
        const response = await this.fetcher(this.options.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ActionGate-Key-Id": this.options.keyId ?? "webhook",
            "X-ActionGate-Timestamp": String(timestamp),
            "X-ActionGate-Signature": sign(this.options.secret, timestamp, body),
            "X-ActionGate-Delivery": id
          },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000)
        });
        if (response.ok) {
          return { id, tenantId: event.tenantId, type: event.type, objectId: event.objectId, attempts: attempt, status: "DELIVERED", createdAt: new Date(this.clock()).toISOString() };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "delivery failed";
      }
      if (attempt < maxAttempts) await (this.options.sleep ?? defaultSleep)(this.options.backoffMs?.(attempt) ?? attempt * 250);
    }

    const delivery: WebhookDelivery = {
      id, tenantId: event.tenantId, type: event.type, objectId: event.objectId,
      attempts: maxAttempts, status: "DEAD", lastError,
      createdAt: new Date(this.clock()).toISOString()
    };
    this.dead.push(delivery);
    return delivery;
  }

  async deadLetters(tenantId: string) {
    return this.dead.filter((delivery) => delivery.tenantId === tenantId);
  }
}

/** Receiver-side helper so a destination can reject anything ActionGate did not send. */
export function verifyWebhookSignature(input: {
  secret: string;
  signature: string;
  timestamp: string;
  body: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  // A replayed delivery outside the window is rejected even if the signature is good.
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(sign(input.secret, timestamp, input.body));
  const provided = Buffer.from(input.signature);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sign(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
