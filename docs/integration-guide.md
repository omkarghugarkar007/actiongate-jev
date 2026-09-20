# Integrating ActionGate

This guide starts with a zero-cost local flow, then moves to the durable Redis/PostgreSQL control plane. Use Shadow Mode first and keep tools sandboxed until the integration boundary has been tested.

## 1. Start the local development API

Requirements: Node.js 22+, pnpm 10+, and Docker only for durable mode.

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev:api
```

The default provider is deterministic and offline. The local-only bearer key is `ag_test_local`, scoped to tenant `tenant-1`, environment `development`, with all roles. No provider request or cost is incurred.

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

Memory mode is for one-process development only.

## 2. Authorize a sandbox action

```bash
curl --request POST http://localhost:8080/v1/authorize \
  --header 'Authorization: Bearer ag_test_local' \
  --header 'Idempotency-Key: refund-demo-001' \
  --header 'Content-Type: application/json' \
  --data '{
    "requestId": "request-demo-001",
    "idempotencyKey": "refund-demo-001",
    "tenantId": "tenant-1",
    "environment": "development",
    "mode": "shadow",
    "actor": { "agentId": "support-agent", "userId": "user-42" },
    "userIntent": {
      "text": "Refund the duplicate $49 charge.",
      "source": "user_message"
    },
    "proposedAction": {
      "tool": "refund_payment",
      "operation": "refund",
      "arguments": { "transactionId": "txn_duplicate", "amountCents": 4900 },
      "riskClass": "FINANCIAL"
    },
    "deterministicFacts": {
      "authenticated": true,
      "authorizedByRbac": true,
      "duplicate": false,
      "amountCents": 4900,
      "currency": "USD",
      "resourceExists": true
    }
  }'
```

Tenant and environment must match the authenticated key. Tool, operation, risk, and arguments must match the server-owned registry and JSON Schema. Shadow Mode returns operational `ALLOW` while `wouldHaveDecision` shows the enforcement result; it never returns a grant.

The current API accepts deterministic facts from the integration. Populate them from authenticated application services, not agent text.

## 3. Run the durable local control plane

Start dependencies and initialize PostgreSQL:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` creates tenant `tenant-1`, the default immutable policy, the default tool registrations, and a bootstrap administrator key. The plaintext key is printed once. Store it immediately; only its slow hash can be retrieved later.

Enable the durable path in `.env`:

```env
ACTIONGATE_STORAGE=redis
ACTIONGATE_CONTROL_PLANE=postgres
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://actiongate:actiongate@localhost:5432/actiongate
```

Restart the API and use the seeded `agk_...` key instead of `ag_test_local`. Redis now coordinates decisions, idempotency, grants, revocation, and one-time consumption. PostgreSQL stores tenant keys, policies, the tool registry, reviews, corrections, and encrypted audit events.

The complete local stack can also be started with:

```bash
docker compose -f infra/docker-compose.yml up --build
```

On the first run, read the one-time bootstrap key from the `seed` service logs and place it in the dashboard environment if needed. This Compose file is development infrastructure, not a hardened deployment template.

## 4. Create least-privilege API keys

Available roles are:

| Role | Capability |
|---|---|
| `authorize` | Create decisions |
| `consume` | Consume grants |
| `decision_reader` | Read decisions and policies |
| `policy_admin` | Create policy versions, manage tools, retention, and grant revocation |
| `reviewer` | Create/resolve reviews, correct decisions, and revoke grants |
| `key_admin` | Issue, list, and revoke API keys |
| `audit_exporter` | Export audit records and execute retention |

Create separate runtime and operator keys instead of sharing the bootstrap key:

```bash
curl --request POST http://localhost:8080/v1/api-keys \
  --header "Authorization: Bearer $ACTIONGATE_BOOTSTRAP_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "refund-runtime",
    "environment": "development",
    "roles": ["authorize", "consume"]
  }'
```

The new plaintext token appears only in this response. `GET /v1/api-keys` returns metadata, prefix, roles, last-use, and revocation state—never plaintext or hashes. Revoke it with `POST /v1/api-keys/:id/revoke`.

## 5. Register tools and policies

The default seed contains `refund_payment`, `get_order`, `send_email`, and a disabled `delete_record`. A tool registration contains:

- normalized name and operation;
- JSON Schema for arguments;
- risk class and data sensitivity;
- owning team or service;
- linked immutable policy ID;
- enabled state.

Create the corresponding immutable policy version first, then register or update the tool with a `policy_admin` key:

```bash
curl --request PUT http://localhost:8080/v1/tools/refund_payment \
  --header "Authorization: Bearer $ACTIONGATE_ADMIN_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "operation": "refund",
    "riskClass": "FINANCIAL",
    "argumentSchema": {
      "type": "object",
      "properties": {
        "transactionId": { "type": "string", "minLength": 1 },
        "amountCents": { "type": "integer", "minimum": 0 }
      },
      "required": ["transactionId", "amountCents"],
      "additionalProperties": false
    },
    "owner": "payments-platform",
    "dataSensitivity": "RESTRICTED",
    "policyId": "support-agent-default",
    "policyVersion": "1.0.0",
    "enabled": true
  }'
```

Invalid schemas are rejected at registration. Missing policy tools, operation/risk mismatch, unknown tools, disabled tools, risk downgrades, and invalid runtime arguments fail before a semantic-provider call.

## 6. Use the TypeScript wrapper

The workspace package `@actiongate/sdk` provides the complete authorize/consume/execute sequence:

```ts
import { ActionGate } from "@actiongate/sdk";

const gate = new ActionGate({
  apiKey: process.env.ACTIONGATE_RUNTIME_KEY!,
  baseUrl: process.env.ACTIONGATE_URL ?? "http://localhost:8080"
});

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
      duplicate: runtime.alreadyRefunded,
      amountCents: input.amountCents,
      currency: input.currency,
      resourceExists: runtime.transactionExists
    }
  })
});
```

`execute` is called only after an enforced `ALLOW` returns a grant and that exact grant is consumed. Keep `refundPayment` and its credential private to this process. Shadow Mode is observational and executes without a grant, so never treat it as an enforcement boundary.

Workspace packages are not yet published to a package registry. Use a workspace dependency or the REST API until versioned releases ship.

## 7. Understand the grant lifecycle

An enforced `ALLOW` response includes a short-lived token:

```json
{
  "decision": "ALLOW",
  "mode": "enforce",
  "policy": { "id": "support-agent-default", "version": "1.0.0" },
  "grant": {
    "token": "ag2.grant_2026_09.<payload>.<signature>",
    "grantId": "0f4b4512-c8b9-46f8-a756-817f95dcaaf4",
    "expiresAt": "2026-09-20T10:00:30.000Z"
  }
}
```

Present the token with the same tenant, environment, actor, tool, operation, arguments, and risk immediately before execution at `POST /v1/grants/consume`.

| Failure | Response |
|---|---|
| Invalid signature or malformed token | `401` |
| Changed binding or revoked grant | `403` |
| Unknown grant | `404` |
| Replay | `409` |
| Expired grant | `410` |

Grant consumption is at-most-once authorization. If the process fails after consumption but before the side effect commits, reconcile the downstream system before obtaining a new authorization.

## 8. Put MCP tools behind the gateway

Use `@actiongate/mcp-gateway` when an MCP handler should be unreachable until consumption succeeds. It owns registered operation and risk metadata and can keep downstream credentials in server-only runtime state.

Prefer the combined `authorizeAndCall` flow, which keeps the grant out of model-visible state. The split `callWithGrant` flow carries it through protected MCP metadata, never tool arguments. See [mcp-gateway.md](mcp-gateway.md).

The current gateway is embeddable. A standalone authenticated proxy and credential broker are P1; see [integrations.md](integrations.md).

## 9. Connect Jev through OpenRouter

Set server-only environment variables:

```env
DECISION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
JEV_MODEL=typesafe/jev-1.13
JEV_TIMEOUT_MS=2000
```

Never expose the provider key through browser variables, frontend JavaScript, prompts, logs, fixtures, or tool arguments.

Validate the live contract and record a local cost snapshot:

```bash
pnpm jev:smoke
pnpm test:jev:live
pnpm cost:track
```

`pnpm test:jev:live` runs authorize, grant issue, single-use consume, and replay rejection against the real Decisions endpoint and fails loudly if the provider key is missing. Run it before treating any change on the decision path as verified; fixtures prove plumbing, not integration.

Cost snapshots remain in the gitignored `.actiongate/` directory. Provider cost, latency, semantic quality, and enforcement correctness are separate measurements.

## 10. Configure production keys

Production does not accept the development static API key or single legacy grant secret. Generate independent key material and configure key rings:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

```env
NODE_ENV=production
ACTIONGATE_STORAGE=redis
ACTIONGATE_CONTROL_PLANE=postgres
ACTIONGATE_GRANT_KEYS={"grant_2026_09":"<first-generated-secret>"}
ACTIONGATE_GRANT_ACTIVE_KID=grant_2026_09
ACTIONGATE_EVIDENCE_KEYS={"evidence_2026_09":"<second-generated-secret>"}
ACTIONGATE_EVIDENCE_ACTIVE_KID=evidence_2026_09
```

For rotation, add the new key beside the old one, switch the active ID, deploy, wait past the longest required verification/decryption window, then retire the old key. Signing and encryption secrets must be independent and stored in a secret manager.

## Safe rollout

1. Start with sandbox tools and the fake provider.
2. Enable Jev in Shadow Mode.
3. Inspect decisions, review reasons, latency, and provider cost.
4. Record verified false positives/negatives as corrections.
5. Calibrate thresholds by tool and risk on independently reviewed cases.
6. Enable enforcement for one low-impact tool with a private handler.
7. Exercise tenant, role, schema, mutation, expiry, revocation, replay, restart, and dependency-failure paths.
8. Expand only after the evidence meets your own safety and availability targets.

## Production checklist

- use Redis and PostgreSQL; run migrations before API rollout;
- store only scoped, least-privilege tenant keys and test revocation;
- use independent signing and encryption key rings with documented rotation;
- derive deterministic facts from trusted services;
- keep raw handlers and credentials unavailable outside the guarded boundary;
- enable TLS, private networking, authentication, replication, backups, monitoring, and restore drills for both stores;
- set retention rules and protect tenant exports;
- add per-tenant quotas, service telemetry, alerts, and incident procedures;
- run provider-backed evaluation on representative, independently reviewed cases;
- complete supply-chain hardening and an external security review;
- read the [threat model](threat-model.md) and [architecture](architecture.md).
