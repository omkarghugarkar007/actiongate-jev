<p align="center">
  <img src="docs/assets/actiongate-social.svg" alt="ActionGate — runtime authorization for AI agent actions with TypeSafe Jev via OpenRouter" width="100%" />
</p>

# ActionGate

**Open-source runtime authorization and single-use action permits for AI agents, powered by deterministic policy and [TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one) through [OpenRouter](https://openrouter.ai/typesafe/jev-1.13).** ActionGate evaluates a proposed tool call, binds an approval to that exact action, and prevents expired, changed, or replayed permits from reaching execution.

[![CI](https://img.shields.io/github/actions/workflow/status/omkarghugarkar007/actiongate-jev/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/omkarghugarkar007/actiongate-jev/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/omkarghugarkar007/actiongate-jev?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Jev](https://img.shields.io/badge/TypeSafe_Jev-1.13-6C7CFF?style=flat-square)](https://openrouter.ai/typesafe/jev-1.13)
[![GitHub stars](https://img.shields.io/github/stars/omkarghugarkar007/actiongate-jev?style=flat-square)](https://github.com/omkarghugarkar007/actiongate-jev/stargazers)

> **Early public release:** use mock or sandbox tools while evaluating it. The P0 tenant-safe control plane is implemented and exercised against Redis and PostgreSQL, but the project has not completed an external security review. A high-impact deployment must also make the guarded executor the only path to downstream credentials. See the [security boundary](docs/threat-model.md).

## Why ActionGate?

AI agents increasingly send emails, issue refunds, mutate databases, and run shell commands. Schema validation can prove that a tool call is well-formed, but it cannot prove that the action matches what the user actually intended.

<p align="center">
  <img src="docs/assets/authorization-flow.svg" alt="A user request and an agent's proposed action enter ActionGate, which returns ALLOW, REVIEW, or BLOCK after checking hard rules and meaning." width="100%" />
</p>

ActionGate combines both kinds of control:

| Code decides | TypeSafe Jev supplies semantic evidence |
|---|---|
| Authentication and RBAC | Does this action match the explicit request? |
| Amounts, dates, limits, and exact comparisons | Is the chosen recipient or resource the intended one? |
| Tool schemas and server-owned risk classes | Does the action expand beyond the requested scope? |
| Idempotency, duplicates, and rate limits | Is sensitive information exposed unnecessarily? |

**Jev supplies evidence. Code owns authority.** A positive model score never overrides a deterministic security failure.

Calling Jev directly produces a structured semantic signal. ActionGate adds the security lifecycle around that signal:

| Direct Jev call | ActionGate |
|---|---|
| Evaluates semantic questions | Combines semantic evidence with hard policy |
| Returns structured answers | Returns `ALLOW`, `REVIEW`, or `BLOCK` with named reasons |
| Does not control later execution | Issues a signed, short-lived Action Grant only for enforced `ALLOW` |
| Does not bind a result to later inputs | Binds tenant, environment, agent, user, session, tool, operation, arguments, risk, and policy |
| Does not track one-time use | Atomically rejects mutation, expiry, and replay |

<p align="center">
  <img src="docs/assets/action-grant-flow.svg" alt="An agent proposes an action, ActionGate decides whether it is allowed, an exact-action permit is created only for allow, and the executor consumes the permit once before running the tool." width="100%" />
</p>

## Five-minute quick start

Requirements: Node.js 22+ and pnpm 10+.

```bash
git clone https://github.com/omkarghugarkar007/actiongate-jev.git
cd actiongate-jev
corepack enable
cp .env.example .env
pnpm install
pnpm dev
```

No model key is required for the default local experience. ActionGate starts with its deterministic fake provider so you can explore without spending credits.

The local key `ag_test_local` is scoped to the development tenant `tenant-1`. It is intentionally unsuitable for deployment.

- Dashboard: [http://localhost:3000](http://localhost:3000)
- API: [http://localhost:8080](http://localhost:8080)
- Health: [http://localhost:8080/health](http://localhost:8080/health)

Run the sandbox refund example in another terminal:

```bash
pnpm refund:demo
```

The demo cannot move real money. For REST, SDK, and deployment examples, follow the [integration guide](docs/integration-guide.md).

For the complete local durable stack, start PostgreSQL and Redis, apply migrations, and seed a tenant:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm db:migrate
pnpm db:seed
```

```env
ACTIONGATE_STORAGE=redis
ACTIONGATE_CONTROL_PLANE=postgres
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://actiongate:actiongate@localhost:5432/actiongate
```

The seed command prints a bootstrap API key once. Redis holds short-lived enforcement state; PostgreSQL holds tenant keys, policies, the tool registry, reviews, corrections, and long-term audit events. The included infrastructure is for local development; deployment requirements are in the [integration guide](docs/integration-guide.md).

## How much does this cost to adopt?

The boundary is strict; the on-ramp is not. Each tier is additive, and the one below it keeps working.

| Tier | You add | You get | Cost |
|---|---|---|---|
| 0 | Nothing | Decisions, named reasons, grants, dashboard, guarded examples | No key, no database, no container, no spend |
| 1 | A provider key | Real Jev semantic evidence through OpenRouter | Per-decision provider cost only |
| 2 | Redis | Restart-safe state, distributed idempotency, cross-replica consumption | One container |
| 3 | PostgreSQL and key rings | Durable tenants, registry, reviews, encrypted audit, rotation, retention | Operating a database |

You never need a database, Redis, or a key ring to evaluate ActionGate, and guarding an existing function is one wrapper rather than a new service to operate.

## Protect an agent tool

```ts
import { ActionGate } from "@actiongate/sdk";

const gate = new ActionGate({
  apiKey: process.env.ACTIONGATE_API_KEY!,
  baseUrl: process.env.ACTIONGATE_URL!
});

const guardedRefund = gate.wrapTool({
  name: "refund_payment",
  operation: "refund",
  riskClass: "FINANCIAL",
  execute: async (input) => refundPayment(input.transactionId, input.amountCents),
  buildRequest: async ({ input, runtime }) => ({
    requestId: crypto.randomUUID(),
    idempotencyKey: runtime.idempotencyKey,
    tenantId: "acme",
    environment: "production",
    mode: "enforce",
    actor: { agentId: "support-agent", userId: runtime.userId },
    userIntent: { text: runtime.userMessage, source: "user_message" },
    deterministicFacts: {
      authenticated: true,
      authorizedByRbac: runtime.canRefund,
      duplicate: runtime.alreadyRefunded,
      amountCents: input.amountCents,
      currency: "USD"
    }
  })
});

await guardedRefund(
  { transactionId: "txn_8923", amountCents: 4900 },
  { idempotencyKey: crypto.randomUUID(), userId: "user_42", userMessage: "Refund the duplicate $49 charge.", canRefund: true }
);
```

The wrapper authorizes the exact arguments, requires an Action Grant for enforced `ALLOW`, consumes it once, and only then invokes the tool. Authorization or consumption failure prevents execution.

For MCP tools, use the [MCP gateway](docs/mcp-gateway.md) to keep the raw handler and its downstream credential behind the grant-consumption boundary.

Changing the amount to `49000` produces:

```text
BLOCK — AMOUNT_EXCEEDS_LIMIT
```

Proposing a refund when the user only asked “Why was I charged twice?” produces:

```text
REVIEW — MISSING_SEMANTIC_AUTHORIZATION
```

That is why agent authorization needs both deterministic code and semantic evidence.

## Guard an MCP server without touching the agent

The standalone MCP proxy sits between an MCP client and the server it calls. The agent's configuration changes; its code does not.

```ts
import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, HttpMcpUpstream, createMcpProxyServer, staticTokenResolver } from "@actiongate/mcp-proxy";

createMcpProxyServer({
  client: new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY!, baseUrl: process.env.ACTIONGATE_URL! }),
  registry: new ActionGateRegistry({ baseUrl: process.env.ACTIONGATE_URL!, apiKey: process.env.ACTIONGATE_API_KEY! }),
  // The upstream credential stays in this process and never reaches the agent.
  upstream: new HttpMcpUpstream({ url: process.env.UPSTREAM_MCP_URL!, headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` } }),
  resolvePrincipal: staticTokenResolver([
    { token: process.env.PROXY_TOKEN!, tenantId: "acme", environment: "production", actor: { agentId: "support-agent" } }
  ])
}).listen({ port: 8090 });
```

Point the MCP client at `http://localhost:8090/mcp` and every `tools/call` is authorized and permitted before it reaches the upstream server. `tools/list` advertises only the intersection of what the upstream offers and what the tenant registry enables, using the registry's schema — so a tool ActionGate does not own is never described to the model.

This is an **Isolate** integration only when the upstream endpoint is not routable from the agent. Its full boundary, including what it does *not* protect, is in the [connector manifest](docs/integrations.md#worked-example-the-mcp-proxy-manifest). To guard tools that carry hard rules such as RBAC or amount limits, configure a server-side `deterministicFacts` provider; without one those tools fail closed.

For in-process tools, the embeddable [MCP gateway](docs/mcp-gateway.md) keeps the raw handler behind the same boundary.

## How it works

<p align="center">
  <img src="docs/assets/platform-architecture.svg" alt="Applications connect through SDK, MCP, HTTP, or workflow adapters. ActionGate combines tenant identity, a server-owned registry, deterministic authority, and decision-model evidence before issuing a single-use grant that is consumed at the guarded execution boundary." width="100%" />
</p>

ActionGate asks all six narrow Jev questions in one request: alignment, target match, policy conflict, sensitive-data exposure, scope expansion, and missing intent. It never asks one vague “is this safe?” question and never uses generated prose as an authorization reason.

Identity and roles come from a hashed tenant key. Tool operation, schema, risk, ownership, sensitivity, and policy come from a durable server-owned registry. Redis performs atomic runtime coordination; PostgreSQL stores the durable control plane and encrypted evidence. Only an enforced `ALLOW` can produce a short-lived grant, and the guarded executor consumes it before a side effect.

Read the [architecture](docs/architecture.md), [integration ecosystem](docs/integrations.md), [threat model](docs/threat-model.md), and [living product plan](docs/PLANNING.md) for the complete design and acceptance gates.

## TypeSafe Jev through OpenRouter

Enable the live provider server-side:

```env
DECISION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
JEV_MODEL=typesafe/jev-1.13
```

The production model is pinned to `typesafe/jev-1.13`; ActionGate does not silently fall back to a general LLM. Verify the live Decisions API contract with:

```bash
pnpm jev:smoke
pnpm test:jev:live
```

The smoke test validates the structured response, reports latency and resolved model/provider metadata, and writes a credential-free fixture to [`fixtures/openrouter`](fixtures/openrouter/).

`pnpm test:jev:live` is the end-to-end gate. It runs authorize, grant issue, single-use consume, and replay rejection against the real Decisions endpoint, asserts the decision came from the live gateway rather than the fake provider, and confirms a deterministic RBAC failure still blocks when the model scores the request favourably. It fails loudly on a missing key rather than skipping, so a skipped suite can never be mistaken for a pass. It is the only suite that spends provider credits.

### Cost tracking

Every live decision records provider-reported input tokens, output tokens, and USD cost. The dashboard aggregates decision spend. To compare cumulative OpenRouter usage with your previous local snapshot:

```bash
pnpm cost:track
```

The snapshot stays in the gitignored `.actiongate/` directory. Pricing is never hard-coded into authorization logic.

## Built for safe rollout

- **Shadow Mode** — observe `wouldHaveDecision` without interrupting tool execution.
- **Risk-aware failures** — financial, destructive, and credential actions fail closed when Jev is unavailable.
- **Deterministic precedence** — model probabilities cannot average away an RBAC, schema, or limit failure.
- **Server-owned risk** — agents cannot self-declare a safer risk class.
- **Minimal state** — only relevant fields are sent to the semantic provider.
- **Strict provider contracts** — malformed or incomplete Jev responses are rejected.
- **Auditable reasons** — reason text comes from named rules and signals, not model prose.
- **Replay protection** — identical idempotency retries return the original decision; changed payloads conflict.
- **Exact-action grants** — enforced allows receive a signed permit bound to the tenant, agent, user/session, tool, operation, arguments, risk class, and policy.
- **One-time consumption** — altered, expired, unknown, and replayed permits fail closed before SDK execution.
- **Cross-instance enforcement** — Redis-backed Lua transactions allow one consumer across API replicas and preserve idempotent decisions across restarts.
- **MCP execution boundary** — the gateway derives server-owned tool risk, consumes the permit, and only then exposes the handler to execution.
- **Tenant-safe control plane** — slow-hashed, role-scoped API keys derive tenant and environment; revocation takes effect immediately.
- **Durable tool registry** — JSON Schema, operation, risk, owner, sensitivity, and policy linkage are tenant-scoped and validated before evaluation.
- **Key rotation** — signing and evidence-encryption key IDs permit overlapping verification/decryption windows while new records use the active key.
- **Encrypted evidence** — Redis decision payloads and PostgreSQL review, correction, and audit payloads use authenticated encryption at rest.
- **Data governance** — tenant-scoped export plus retention-driven evidence minimization and deletion are built into the API.
- **Honest evaluation boundaries** — dataset integrity, semantic quality, enforcement security, reliability, and performance are measured separately.

## Common use cases

- Customer-support agents issuing refunds or credits
- Voice agents changing bookings
- Sales agents sending external email
- Operations agents editing CRM records
- Finance agents proposing accounting actions
- Coding agents writing files, deleting resources, or pushing Git changes
- MCP gateways and tool-execution proxies

## Repository structure

```text
apps/
  api/                    Fastify authorization API
  web/                    Next.js audit dashboard
packages/
  core/                   Contracts, hard rules, state, thresholds, composition
  decision-provider/      OpenRouter Jev and deterministic fake providers
  sdk-js/                 TypeScript client and tool wrapper
  mcp-gateway/            Guarded MCP tool registry and execution boundary (embeddable)
  mcp-proxy/              Standalone MCP network proxy that owns the upstream credential
  db/                     Drizzle schema and PostgreSQL migrations
  evals/                  Starter dataset and integrity validation CLI
examples/
  curl/                   Copy-paste REST authorization request
  refund-agent/           Safe, in-memory end-to-end example
fixtures/openrouter/      Sanitized live Jev contract fixtures
infra/                    Docker Compose and k6 profiles
docs/                     Integration, architecture, and threat model
AGENTS.md                  Product and security invariants for coding agents
CLAUDE.md                  In-session working agreement for Claude Code
```

## API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/authorize` | Evaluate a proposed action |
| `POST` | `/v1/grants/consume` | Consume an exact-action grant once before execution |
| `POST` | `/v1/grants/:id/revoke` | Revoke an unconsumed grant |
| `GET` | `/v1/decisions` | List sanitized audit decisions |
| `GET` | `/v1/decisions/:id` | Inspect one decision and its signals |
| `GET` | `/v1/policies` | List immutable policy versions |
| `POST` | `/v1/policies/:id/versions` | Create a policy version |
| `GET` / `PUT` | `/v1/tools` / `/v1/tools/:name` | Read or update the tenant tool registry |
| `GET` / `POST` | `/v1/api-keys` | List key metadata or issue a scoped key once |
| `POST` | `/v1/api-keys/:id/revoke` | Revoke a tenant API key |
| `POST` | `/v1/decisions/:id/override` | Record a human correction |
| `POST` | `/v1/reviews` | Create an expiring review record |
| `POST` | `/v1/reviews/:id/resolve` | Approve or deny a review |
| `GET` | `/v1/audit/export` | Export tenant decisions and audit events |
| `DELETE` | `/v1/audit/retention` | Minimize or delete evidence before a cutoff |
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness |

See [integration-guide.md](docs/integration-guide.md) for request/response examples and failure handling.

## Development and verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:redis
pnpm test:postgres
pnpm build
pnpm e2e
pnpm audit --prod
pnpm test:jev:live   # opt-in; spends provider credits
```

Local infrastructure:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm db:migrate
```

The repository includes unit, provider-contract, API integration, browser E2E, live Jev, migration, load, and adversarial test paths. `pnpm eval` validates dataset structure and explicitly produces no accuracy score. The generated 500-case starter set is synthetic and marked for human review; production thresholds require provider-backed evaluation on representative, independently reviewed cases.

## Project status and roadmap

ActionGate is an independent community project and is not affiliated with or endorsed by TypeSafe AI or OpenRouter. TypeSafe, Jev, and OpenRouter are names of their respective owners.

The API defaults to in-memory repositories for a zero-dependency demo. The P0 path uses Redis for runtime coordination and PostgreSQL for tenant-scoped keys, policy, registry, reviews, corrections, and encrypted audit evidence. The embeddable MCP gateway protects registered handlers when downstream credentials remain private to that gateway. A standalone authenticated proxy, credential broker, advanced review workflow, independent semantic benchmark, operations hardening, and external security review remain on the [product plan](docs/PLANNING.md).

## Contributing

Ideas, integrations, policy examples, adversarial cases, and provider feedback are welcome. Read the [contribution guide](.github/CONTRIBUTING.md), browse [good first issues](https://github.com/omkarghugarkar007/actiongate-jev/labels/good%20first%20issue), or start a [discussion](https://github.com/omkarghugarkar007/actiongate-jev/discussions).

If ActionGate helps you build safer AI agents, **star the repository**—it helps other developers searching for TypeSafe Jev and AI-agent authorization discover the project.

Security reports should follow the [security policy](.github/SECURITY.md), not public issues.

## License

Apache License 2.0. See [LICENSE](LICENSE).
