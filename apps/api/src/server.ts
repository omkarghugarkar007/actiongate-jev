import { SignedRequestIssuer } from "@actiongate/core";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { OtlpMetricExporter } from "./services/otlp.js";
import { SignedWebhookNotifier } from "./services/webhooks.js";

/**
 * Wires the optional subsystems from configuration. Each stays off unless its
 * secret is present, because a half-configured broker or notifier is worse than
 * none: it would look enabled while producing credentials or deliveries nobody
 * can verify.
 */
const credentialIssuer = config.ACTIONGATE_CREDENTIAL_SECRET
  ? new SignedRequestIssuer({
      secret: config.ACTIONGATE_CREDENTIAL_SECRET,
      keyId: config.ACTIONGATE_CREDENTIAL_KID,
      maxTtlSeconds: config.ACTIONGATE_CREDENTIAL_MAX_TTL_SECONDS
    })
  : undefined;

const notifier = config.ACTIONGATE_WEBHOOK_URL && config.ACTIONGATE_WEBHOOK_SECRET
  ? new SignedWebhookNotifier({ url: config.ACTIONGATE_WEBHOOK_URL, secret: config.ACTIONGATE_WEBHOOK_SECRET })
  : undefined;

const app = buildApp({
  ...(credentialIssuer ? { credentialIssuer } : {}),
  ...(notifier ? { notifier } : {}),
  quotas: config.tenantQuotas,
  defaultQuota: config.defaultQuota
});

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info({
    provider: config.DECISION_PROVIDER,
    storage: config.ACTIONGATE_STORAGE,
    controlPlane: config.ACTIONGATE_CONTROL_PLANE,
    credentialBroker: Boolean(credentialIssuer),
    notifications: Boolean(notifier),
    otlp: Boolean(config.ACTIONGATE_OTLP_ENDPOINT)
  }, "ActionGate ready");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

if (config.ACTIONGATE_OTLP_ENDPOINT) {
  // Exported from the same snapshot /metrics serves, so the two cannot disagree.
  const exporter = new OtlpMetricExporter(app.telemetry, {
    endpoint: config.ACTIONGATE_OTLP_ENDPOINT,
    intervalMs: config.ACTIONGATE_OTLP_INTERVAL_MS,
    onError: (error) => app.log.warn({ error }, "OTLP metric export failed")
  });
  exporter.start();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => exporter.stop());
}
