import type { Telemetry } from "./telemetry.js";

/**
 * Pushes the metric snapshot to an OTLP/HTTP collector.
 *
 * Deliberately a push of the same numbers the /metrics endpoint serves, rather
 * than a second instrumentation path: two sources of truth for the same metric
 * disagree eventually, and the disagreement is always discovered during an
 * incident.
 *
 * Tenant labels are already hashed by Telemetry, so nothing customer-identifying
 * leaves the process here either.
 */
export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  serviceName?: string;
  fetch?: typeof globalThis.fetch;
  onError?: (error: unknown) => void;
}

export class OtlpMetricExporter {
  private timer: NodeJS.Timeout | undefined;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly telemetry: Telemetry, private readonly options: OtlpExporterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.exportOnce(); }, this.options.intervalMs ?? 60_000);
    // Never hold the process open just to report numbers.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exported separately so a deployment can flush on shutdown, and tests can call it. */
  async exportOnce(): Promise<boolean> {
    try {
      const response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.options.headers },
        body: JSON.stringify(this.payload()),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`collector returned HTTP ${response.status}`);
      return true;
    } catch (error) {
      // Telemetry export must never disturb the request path.
      this.options.onError?.(error);
      return false;
    }
  }

  private payload() {
    return {
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: this.options.serviceName ?? "actiongate" } }] },
        scopeMetrics: [{
          scope: { name: "actiongate" },
          // The Prometheus exposition is carried verbatim so the two paths can
          // never report different numbers for the same counter.
          metrics: [{
            name: "actiongate_prometheus_snapshot",
            description: "Prometheus exposition captured at export time.",
            unit: "1",
            gauge: { dataPoints: [{ timeUnixNano: String(Date.now() * 1_000_000), asString: this.telemetry.render() }] }
          }]
        }]
      }]
    };
  }
}
