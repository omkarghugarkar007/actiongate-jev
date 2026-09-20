# Quickstarts

One screen per integration level. Each runs at the lowest tier that makes it
useful, and each says what it does *not* protect.

The levels come from the [integration ecosystem](integrations.md#integration-levels):
**Observe** evaluates without controlling execution, **Guard** consumes a grant
before an in-process handler, **Isolate** owns the network path or credential,
**Govern** connects identity, audit, and incident systems.

---

## Observe — see decisions without changing behaviour

**Tier 0.** No key, no database, no container. Nothing is blocked; you find out
what *would* have been.

```ts
import { ActionGate } from "@actiongate/sdk";

const gate = new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY!, baseUrl: process.env.ACTIONGATE_URL! });

const decision = await gate.authorize({
  requestId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
  tenantId: "acme",
  environment: "development",
  mode: "shadow",                                  // observe only
  actor: { agentId: "support-agent" },
  userIntent: { text: userMessage, source: "user_message" },
  proposedAction: { tool: "refund_payment", operation: "refund", arguments: { transactionId, amountCents }, riskClass: "FINANCIAL" }
});

console.log(decision.decision, decision.wouldHaveDecision, decision.reasons.map((r) => r.code));
```

**Does not protect anything.** Shadow mode never blocks. Use it to size review
volume and check reason codes before enforcing.

---

## Guard — consume a grant before your own handler

**Tier 0.** One wrapper around a function you already have.

```ts
import { ActionGate } from "@actiongate/sdk";

const gate = new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY!, baseUrl: process.env.ACTIONGATE_URL! });

export const guardedRefund = gate.wrapTool({
  name: "refund_payment",
  operation: "refund",
  riskClass: "FINANCIAL",
  execute: async (input) => refundPayment(input.transactionId, input.amountCents),   // keep this private
  buildRequest: async ({ input, runtime }) => ({
    requestId: crypto.randomUUID(),
    idempotencyKey: runtime.idempotencyKey,
    tenantId: "acme",
    environment: "production",
    mode: "enforce",
    actor: { agentId: "support-agent", userId: runtime.userId },
    userIntent: { text: runtime.userMessage, source: "user_message" }
  })
});
```

**Does not protect** `refundPayment` itself. Anything else that can call it is
unguarded, so keep it private to this module. Facts for hard rules belong to a
[server-side provider](integrations.md#trusted-facts), not to this call.

---

## Isolate — own the network path

**Tier 1.** The agent's configuration changes; its code does not.

```ts
import { createSidecar } from "@actiongate/http-proxy";

createSidecar({
  actionGateUrl: process.env.ACTIONGATE_URL!,
  actionGateApiKey: process.env.ACTIONGATE_API_KEY!,   // stays in this process
  upstreamUrl: "http://payments.internal:9000",
  upstreamToken: process.env.UPSTREAM_TOKEN,           // stays in this process
  proxyToken: process.env.PROXY_TOKEN!,                // this is all the agent gets
  tenantId: "acme",
  routes: [
    { method: "GET", path: "/orders/:orderId", tool: "get_order" },
    { method: "POST", path: "/refunds", tool: "refund_payment" }
  ]
}).listen({ port: 8090 });
```

For MCP, the same shape with `createGuardedMcpServer` from `@actiongate/mcp-proxy`.

**Does not protect** against anything that can route to `payments.internal`
directly — isolation is a network property. See the
[reference deployment](../infra/reference/README.md) for a topology that closes
that path, and the connector manifests for each proxy's full bypass statement.

---

## Govern — resolve facts and record outcomes

**Tier 1+.** Runs on the ActionGate API, not in an adapter: only the API side can
make a fact trusted.

```ts
import { HttpFactProvider } from "@actiongate/core";
import { buildApp } from "./app.js";

buildApp({
  factProviders: [
    new HttpFactProvider({
      name: "ledger",
      url: "http://entitlements.internal/facts",   // not reachable by the agent
      tools: ["refund_payment"]
    })
  ]
});
```

Caller facts cannot satisfy a hard rule, regardless of the legacy
`requireTrustedFacts` field. Configure a provider for every fact-backed rule,
then record what actually happened separately from the authorization:

```bash
curl -X POST "$ACTIONGATE_URL/v1/executions" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"decisionId":"...","status":"COMPLETED","externalRef":"refund_8842"}'
```

**Does not protect** against a compromised fact service. A provider is only as
trustworthy as the system behind it, and it must not be reachable by the agent.
