# Integrating ActionGate

This guide takes an application from a proposed AI-agent tool call to a one-time Action Grant. Start with the fake provider and Shadow Mode; connect TypeSafe Jev through OpenRouter only after the local flow works.

## 1. Start ActionGate locally

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev:api
```

The default API key is `ag_test_local` and the default provider is deterministic and offline. These defaults are for development only.

The development signing secret is also intentionally public. Set a unique value of at least 32 bytes before deployment:

```env
ACTIONGATE_GRANT_SECRET=replace-with-a-random-secret-of-at-least-32-bytes
ACTIONGATE_GRANT_TTL_SECONDS=30
```

Verify the service:

```bash
curl http://localhost:8080/health
```

## 2. Authorize one action over REST

```bash
curl --request POST http://localhost:8080/v1/authorize \
  --header 'Authorization: Bearer ag_test_local' \
  --header 'Idempotency-Key: refund-demo-001' \
  --header 'Content-Type: application/json' \
  --data '{
    "requestId": "request-demo-001",
    "idempotencyKey": "refund-demo-001",
    "tenantId": "demo",
    "environment": "development",
    "mode": "shadow",
    "actor": { "agentId": "support-agent" },
    "userIntent": {
      "text": "Refund the duplicate $49 charge.",
      "source": "user_message"
    },
    "proposedAction": {
      "tool": "refund_payment",
      "operation": "refund",
      "arguments": {
        "transactionId": "txn_duplicate",
        "amountCents": 4900
      },
      "riskClass": "FINANCIAL"
    },
    "deterministicFacts": {
      "authenticated": true,
      "authorizedByRbac": true,
      "amountCents": 4900,
      "currency": "USD",
      "resourceExists": true
    }
  }'
```

Shadow Mode always returns operational `ALLOW`; inspect `wouldHaveDecision` to see what enforcement would do. Shadow decisions never receive an Action Grant because shadow mode is observational.

## 3. Use the TypeScript SDK

The SDK currently ships as the workspace package `@actiongate/sdk`. Until the first npm release, consume it from this monorepo, a workspace dependency, or use the REST API directly.

```ts
import { ActionGate } from "@actiongate/sdk";

const gate = new ActionGate({
  apiKey: process.env.ACTIONGATE_API_KEY!,
  baseUrl: process.env.ACTIONGATE_URL ?? "http://localhost:8080"
});

Use `wrapTool` for the complete enforced lifecycle. It authorizes the exact inputs, requires a grant, consumes the grant, and calls `execute` only after consumption succeeds:

```ts
const guardedRefund = gate.wrapTool({
  name: "refund_payment",
  operation: "refund",
  riskClass: "FINANCIAL",
  execute: refundPayment,
  buildRequest: async ({ input, runtime }) => ({
    requestId: crypto.randomUUID(),
    idempotencyKey: runtime.idempotencyKey,
    tenantId: runtime.tenantId,
    environment: "production",
    mode: "enforce",
    actor: { agentId: "support-agent", userId: runtime.userId },
    userIntent: { text: runtime.userMessage, source: "user_message" },
    deterministicFacts: {
      authenticated: runtime.authenticated,
      authorizedByRbac: runtime.canRefund,
      amountCents: input.amountCents,
      currency: input.currency,
      resourceExists: true
    }
  })
});
```

For `mode: "shadow"`, the wrapper remains observational: it executes after the decision without asking for a grant. Never use shadow mode as an enforcement boundary.

### REST grant lifecycle

An enforced `ALLOW` response includes a short-lived grant:

```json
{
  "decision": "ALLOW",
  "mode": "enforce",
  "policy": { "id": "support-agent-default", "version": "1.0.0" },
  "grant": {
    "token": "ag1.<payload>.<signature>",
    "grantId": "0f4b4512-c8b9-46f8-a756-817f95dcaaf4",
    "expiresAt": "2026-09-19T10:00:30.000Z"
  }
}
```

Present the token with the exact same action immediately before execution:

```bash
curl --request POST http://localhost:8080/v1/grants/consume \
  --header 'Authorization: Bearer ag_test_local' \
  --header 'Content-Type: application/json' \
  --data '{
    "token": "ag1.<payload>.<signature>",
    "tenantId": "demo",
    "environment": "development",
    "actor": { "agentId": "support-agent" },
    "proposedAction": {
      "tool": "refund_payment",
      "operation": "refund",
      "arguments": { "transactionId": "txn_duplicate", "amountCents": 4900 },
      "riskClass": "FINANCIAL"
    }
  }'
```

A grant is valid only once. Mutation returns `403`, an invalid signature `401`, replay `409`, and expiry `410`. A consumed grant gives at-most-once authorization, not exactly-once execution: if the process fails after consumption but before the side effect, obtain a new authorization with a new idempotency key after reconciling downstream state.

## 4. Connect TypeSafe Jev through OpenRouter

Set server-only environment variables:

```env
DECISION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
JEV_MODEL=typesafe/jev-1.13
JEV_TIMEOUT_MS=2000
```

Never expose the OpenRouter key through `NEXT_PUBLIC_*`, frontend JavaScript, agent prompts, logs, or tool arguments.

Validate the live contract and record the cost baseline:

```bash
pnpm jev:smoke
RUN_LIVE_JEV_TESTS=true pnpm test:jev:live
pnpm cost:track
```

## 5. Add a tool policy

Tool risk is server-owned. Add the tool to the policy/registry before accepting agent requests:

```ts
send_email: {
  enabled: true,
  operation: "send",
  riskClass: "EXTERNAL_COMMUNICATION",
  semanticPolicy: [
    "Send only to recipients supported by the user's explicit request.",
    "Do not include sensitive information unnecessary for the request."
  ],
  thresholdProfile: "reversible-write-v1"
}
```

Do not allow the agent to lower the registered risk class.

## 6. Roll out safely

1. Start with sandbox tools and the fake provider.
2. Enable Jev in Shadow Mode.
3. Inspect decisions, signal distributions, latency, and provider cost.
4. Label false positives and false negatives with overrides.
5. Calibrate thresholds per risk class and tool.
6. Enable enforcement for one low-impact tool.
7. Expand only after unsafe-allow and false-block metrics meet your target.

## Response handling

| Decision | Caller behavior |
|---|---|
| enforced `ALLOW` | Consume the Action Grant with the exact action, then execute |
| shadow `ALLOW` | Observe `wouldHaveDecision`; this is intentionally not enforcement |
| `REVIEW` | Pause and request human/user confirmation |
| `BLOCK` | Do not execute; surface the deterministic reason code |

Do not execute from a model probability directly. Use only the composed ActionGate decision.

## Production checklist

- Replace the development API key and store only a strong hash.
- Replace the development grant secret and plan key rotation.
- Use durable PostgreSQL audit/grant storage and transactional or Redis-backed atomic consumption.
- Keep policy versions immutable.
- Configure TLS, tenant isolation, rate limiting, and retention.
- Export latency, provider-error, unsafe-allow, override, and cost metrics.
- Put credentials behind the guarded executor, gateway, or credential broker; direct credential access can bypass an SDK wrapper.
- Run provider-backed evaluation on representative, reviewed cases.
- Read the [threat model](threat-model.md).
