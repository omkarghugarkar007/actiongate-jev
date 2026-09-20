import { createHash } from "node:crypto";

/**
 * Tenant-safe metrics in Prometheus text format.
 *
 * Tenant identifiers are hashed before they become label values. A tenant slug
 * is customer-identifying, and a metrics endpoint is usually scraped by systems
 * with a much wider audience than the control plane, so the raw slug never
 * leaves here. The hash is stable, so per-tenant series still work.
 */
export type MetricLabels = Record<string, string>;

interface CounterSeries { help: string; type: "counter"; values: Map<string, { labels: MetricLabels; value: number }> }
interface HistogramSeries {
  help: string;
  type: "histogram";
  buckets: readonly number[];
  values: Map<string, { labels: MetricLabels; counts: number[]; sum: number; count: number }>;
}

const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;

export class Telemetry {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();
  private readonly startedAt = Date.now();

  constructor(private readonly tenantSalt: string) {}

  /** Stable but non-reversible, so per-tenant series work without exposing who. */
  tenantLabel(tenantId: string): string {
    return createHash("sha256").update(`${this.tenantSalt}:${tenantId}`).digest("hex").slice(0, 16);
  }

  increment(name: string, help: string, labels: MetricLabels = {}, by = 1): void {
    const series = this.counters.get(name) ?? { help, type: "counter" as const, values: new Map() };
    const key = labelKey(labels);
    const existing = series.values.get(key);
    series.values.set(key, { labels, value: (existing?.value ?? 0) + by });
    this.counters.set(name, series);
  }

  observe(name: string, help: string, milliseconds: number, labels: MetricLabels = {}): void {
    const series = this.histograms.get(name) ?? { help, type: "histogram" as const, buckets: LATENCY_BUCKETS, values: new Map() };
    const key = labelKey(labels);
    const existing = series.values.get(key) ?? { labels, counts: new Array(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
    for (let index = 0; index < LATENCY_BUCKETS.length; index += 1) {
      if (milliseconds <= LATENCY_BUCKETS[index]!) existing.counts[index] = (existing.counts[index] ?? 0) + 1;
    }
    existing.sum += milliseconds;
    existing.count += 1;
    series.values.set(key, existing);
    this.histograms.set(name, series);
  }

  render(): string {
    const lines: string[] = [];
    lines.push("# HELP actiongate_uptime_seconds Seconds since this process started.", "# TYPE actiongate_uptime_seconds gauge",
      `actiongate_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);

    for (const [name, series] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of series.values.values()) lines.push(`${name}${renderLabels(labels)} ${value}`);
    }

    for (const [name, series] of [...this.histograms].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} histogram`);
      for (const entry of series.values.values()) {
        series.buckets.forEach((bucket, index) => {
          lines.push(`${name}_bucket${renderLabels({ ...entry.labels, le: String(bucket) })} ${entry.counts[index] ?? 0}`);
        });
        lines.push(`${name}_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${entry.count}`);
        lines.push(`${name}_sum${renderLabels(entry.labels)} ${entry.sum.toFixed(3)}`);
        lines.push(`${name}_count${renderLabels(entry.labels)} ${entry.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

function labelKey(labels: MetricLabels): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
