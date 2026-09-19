# Integrating ActionGate

This guide takes an application from a proposed AI-agent tool call to an ActionGate decision. Start with the fake provider and Shadow Mode; connect TypeSafe Jev through OpenRouter only after the local flow works.

## 1. Start ActionGate locally

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev:api
```

The default API key is `ag_test_local` and the default provider is deterministic and offline. These defaults are for development only.

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

Shadow Mode always returns operational `ALLOW`; inspect `wouldHaveDecision` to see what enforcement would do.

## 3. Use the TypeScript SDK

The SDK currently ships as the workspace package `@actiongate/sdk`. Until the first npm release, consume it from this monorepo, a workspace dependency, or use the REST API directly.

```ts
import { ActionGate, ActionBlockedError } from "@actiongate/sdk";

const gate = new ActionGate({
  apiKey: process.env.ACTIONGATE_API_KEY!,
  baseUrl: process.env.ACTIONGATE_URL ?? "http://localhost:8080"
});

try {
  const authorization = await gate.authorize(request);

  if (authorization.decision === "REVIEW") {
    return queueForHumanApproval(authorization);
  }

  if (authorization.decision === "BLOCK") {
    throw new ActionBlockedError(authorization);
  }

  return executeTool();
} catch (error) {
  // Network failure is not authorization. Apply your application's safe failure policy.
  throw error;
}
```

The `wrapTool` helper ensures execution occurs only after `ALLOW`:

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
| `ALLOW` | Execute using the caller's credential and record the result |
| `REVIEW` | Pause and request human/user confirmation |
| `BLOCK` | Do not execute; surface the deterministic reason code |

Do not execute from a model probability directly. Use only the composed ActionGate decision.

## Production checklist

- Replace the development API key and store only a strong hash.
- Use durable PostgreSQL audit storage and Redis idempotency locks.
- Keep policy versions immutable.
- Configure TLS, tenant isolation, rate limiting, and retention.
- Export latency, provider-error, unsafe-allow, override, and cost metrics.
- Keep credentials with the executor or behind an execution proxy.
- Run provider-backed evaluation on representative, reviewed cases.
- Read the [threat model](threat-model.md).

