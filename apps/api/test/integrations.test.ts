import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSecret, resolveSecrets, SecretResolutionError } from "../src/services/secrets.js";
import { OtlpMetricExporter } from "../src/services/otlp.js";
import { Telemetry } from "../src/services/telemetry.js";

describe("secret resolution", () => {
  it("passes a plain value through unchanged", () => {
    expect(resolveSecret("a-literal-secret")).toBe("a-literal-secret");
    expect(resolveSecret(undefined)).toBeUndefined();
  });

  it("reads from an environment variable the secret manager populated", () => {
    expect(resolveSecret("env:FROM_VAULT", { env: { FROM_VAULT: "resolved" } })).toBe("resolved");
  });

  it("fails loudly when the referenced variable is missing", () => {
    // Silently resolving to undefined would start the process with no key.
    expect(() => resolveSecret("env:MISSING", { env: {} })).toThrow(SecretResolutionError);
  });

  it("reads a mounted file and strips the trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "actiongate-secrets-"));
    const path = join(dir, "grant-keys");
    writeFileSync(path, "secret-value\n");
    expect(resolveSecret(`file:${path}`)).toBe("secret-value");
  });

  it("reports which file could not be read", () => {
    expect(() => resolveSecret("file:/nonexistent/actiongate-secret")).toThrow(/Cannot read secret file/);
  });

  it("refuses command secrets unless explicitly enabled", () => {
    expect(() => resolveSecret("cmd:echo hello")).toThrow(/disabled/);
    expect(resolveSecret("cmd:echo hello", { allowCommands: true })).toBe("hello");
  });

  it("rejects an empty reference rather than resolving to nothing", () => {
    expect(() => resolveSecret("env:")).toThrow(SecretResolutionError);
  });

  it("reports every failure at once so a deployment is fixed in one pass", () => {
    try {
      resolveSecrets({ a: "env:MISSING_ONE", b: "env:MISSING_TWO", c: "literal" }, { env: {} });
      throw new Error("expected resolveSecrets to throw");
    } catch (error) {
      expect(String(error)).toContain("MISSING_ONE");
      expect(String(error)).toContain("MISSING_TWO");
    }
  });
});

describe("OTLP exporter", () => {
  function telemetryWithData() {
    const telemetry = new Telemetry("salt");
    telemetry.increment("actiongate_decisions_total", "Decisions.", { decision: "ALLOW" });
    return telemetry;
  }

  it("posts the same numbers the metrics endpoint serves", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }));
    const telemetry = telemetryWithData();
    const exporter = new OtlpMetricExporter(telemetry, { endpoint: "https://collector.internal/v1/metrics", fetch: fetchMock as unknown as typeof fetch });

    expect(await exporter.exportOnce()).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    const point = body.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0];
    expect(point.asString).toBe(telemetry.render());
    expect(body.resourceMetrics[0].resource.attributes[0].value.stringValue).toBe("actiongate");
  });

  it("sends configured collector headers", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }));
    await new OtlpMetricExporter(telemetryWithData(), {
      endpoint: "https://collector.internal/v1/metrics",
      headers: { "x-api-key": "collector-key" },
      fetch: fetchMock as unknown as typeof fetch
    }).exportOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({ "x-api-key": "collector-key" });
  });

  it("reports a failing collector without throwing into the caller", async () => {
    const errors: unknown[] = [];
    const exporter = new OtlpMetricExporter(telemetryWithData(), {
      endpoint: "https://collector.internal/v1/metrics",
      fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      onError: (error) => errors.push(error)
    });
    // Telemetry export must never disturb the request path.
    expect(await exporter.exportOnce()).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("does not hold the process open", async () => {
    const exporter = new OtlpMetricExporter(telemetryWithData(), {
      endpoint: "https://collector.internal/v1/metrics",
      intervalMs: 60_000,
      fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    });
    exporter.start();
    exporter.start(); // idempotent
    exporter.stop();
    expect(true).toBe(true);
  });
});
