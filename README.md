<p align="center">
  <img src="docs/assets/actiongate-social.svg" alt="ActionGate — runtime authorization for AI agent actions with TypeSafe Jev directly or through OpenRouter" width="100%" />
</p>

# ActionGate

**Open-source Jev tool-calling authorization for AI agents.** ActionGate is a
runtime security gateway that evaluates a proposed tool call with deterministic
policy plus [TypeSafe Jev](https://docs.typesafe.ai/concepts/system-one), called
[directly through TypeSafe](https://docs.typesafe.ai/introduction/quickstart) or
through [OpenRouter](https://openrouter.ai/typesafe/jev-1.13), binds approval to
that exact action, and refuses expired, changed, or replayed permits.

[![CI](https://img.shields.io/github/actions/workflow/status/omkarghugarkar007/actiongate-jev/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/omkarghugarkar007/actiongate-jev/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/omkarghugarkar007/actiongate-jev?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](packages/sdk-python)
[![Jev](https://img.shields.io/badge/TypeSafe_Jev-1.13-6C7CFF?style=flat-square)](https://docs.typesafe.ai/models)

> **Early public release.** Use mock or sandbox tools while evaluating it. No
> external security review has happened yet — see the [threat model](docs/threat-model.md)
> and the [independent-review tracker](https://github.com/omkarghugarkar007/actiongate-jev/issues/9).

---

## The problem

Schema validation proves a tool call is well-formed. It cannot prove the call
matches what the user asked for. These two are both valid `refund_payment` calls:

| The user said | The agent proposed | Should it run? |
|---|---|---|
| "Refund the duplicate $49 charge on txn_5512." | `refund txn_5512, 4900` | Yes |
| "Refund the duplicate $49 charge on txn_5512." | `refund txn_9981, 4900` | No — different transaction |

ActionGate decides which is which, then issues a permit bound to the exact action
it approved. Here it is against the live model:

<p align="center">
  <img src="docs/assets/simulator.gif" alt="The ActionGate simulator: the same refund tool is allowed for the transaction the user named, then blocked for a transaction they never mentioned, and blocked again when a question is treated as a request." width="100%" />
</p>

**Jev supplies evidence. Code owns authority.** A model score never overrides an
RBAC, schema, limit, or duplicate failure.

## Quick start

Node.js 22+ and pnpm 10+. No model key needed — it starts with a deterministic
fake provider.

```bash
git clone https://github.com/omkarghugarkar007/actiongate-jev.git
cd actiongate-jev && corepack enable && cp .env.example .env
pnpm install && pnpm dev
```

Dashboard on [:3000](http://localhost:3000), simulator on
[:3000/simulator](http://localhost:3000/simulator), API on [:8080](http://localhost:8080).
Then `pnpm refund:demo` runs a guarded refund that cannot move real money.

For live decisions, choose either direct TypeSafe or OpenRouter:

```env
# Direct TypeSafe API
DECISION_PROVIDER=typesafe
TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0

# Or OpenRouter
# DECISION_PROVIDER=openrouter
# OPENROUTER_API_KEY=sk-or-v1-...
# JEV_MODEL=typesafe/jev-1.13
```

The direct adapter is fully fixture-tested but has not yet been exercised live
because no `TYPESAFE_API_KEY` is available. When you obtain one, run
`pnpm typesafe:smoke && pnpm test:typesafe:live`; both fail loudly if it is missing.
For tools with hard rules, also point `ACTIONGATE_FACT_PROVIDER_URL` at a
deployment-owned fact service; the fake Tier 0 server uses only a labeled local
fixture, and non-demo deployments fail closed without trusted evidence.

## Guard a tool

### TypeScript

```ts
import { FunctionFactProvider } from "@actiongate/core";
import { ActionGate } from "@actiongate/sdk";

const gate = ActionGate.embedded({
  // Read hard-rule evidence from application state, never agent input.
  factProviders: [new FunctionFactProvider({
    name: "payments",
    resolve: ({ request }) => paymentFacts(request.proposedAction.arguments)
  })]
});

const guardedRefund = gate.wrapTool({
  name: "refund_payment",
  operation: "refund",
  riskClass: "FINANCIAL",
  execute: async (input) => refundPayment(input.transactionId, input.amountCents),  // keep private
  buildRequest: async ({ runtime }) => ({
    requestId: crypto.randomUUID(),
    idempotencyKey: runtime.idempotencyKey,
    tenantId: "acme",
    environment: "production",
    mode: "enforce",
    actor: { agentId: "support-agent", userId: runtime.userId },
    userIntent: { text: runtime.userMessage, source: "user_message" }
  })
});

await guardedRefund({ transactionId: "txn_8923", amountCents: 4900 }, runtime);
```

When you outgrow one process, swap the constructor and nothing else changes:

```ts
const gate = new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY!, baseUrl: process.env.ACTIONGATE_URL! });
```
```python
gate = ActionGate(api_key=os.environ["ACTIONGATE_API_KEY"], base_url=os.environ["ACTIONGATE_URL"])
```

Embedded keeps the same issue-and-consume guarantees but costs you a real
boundary: grants live in memory, so they do not survive a restart or coordinate
across replicas, there is no audit trail or review queue, and the policy sits in
the same process as the agent — code that can edit it can raise its own limits.
Hosted mode exists so the registry is somewhere the agent cannot reach.

### Python

Same thing, no server:


```python
from actiongate import ActionGate, Actor, UserIntent, ActionBlockedError

gate = ActionGate.embedded(
    fact_providers=[("payments", lambda request, _tool:
        payment_facts(request["proposedAction"]["arguments"]))]
)

def _refund(arguments, runtime):            # keep private
    return payments.refund(arguments["transactionId"], arguments["amountCents"])

guarded_refund = gate.wrap_tool(
    name="refund_payment",
    operation="refund",
    risk_class="FINANCIAL",
    execute=_refund,
    build_request=lambda arguments, runtime: {
        "tenant_id": "acme",
        "environment": "production",
        "mode": "enforce",
        "actor": Actor(agent_id="support-agent", user_id=runtime["user_id"]),
        "user_intent": UserIntent(text=runtime["user_message"]),
    },
)

try:
    guarded_refund({"transactionId": "txn_8923", "amountCents": 4900}, runtime)
except ActionBlockedError as error:
    print(error.decision, [reason["code"] for reason in error.reasons])
```

Both SDKs authorize, consume a single-use grant, and only then call the handler.
Every error means the handler was **not** called.

`ActionGate.embedded()` runs the whole decision path in your process — no server,
no API key, no base URL, no database. Run either demo to see it:
`pnpm examples:embedded` or `pnpm examples:embedded:python`. Against the live
model both refuse a transaction the user never named, on meaning rather than on
a missing record.

A shared fixture suite makes the two implementations agree on canonical
fingerprints, deterministic rules, and thresholds, so a grant issued by one
verifies in the other.

> **Guard level.** These protect the wrapper, not the function it calls. Keep the
> handler private, or another caller reaches it without a grant.

### Without touching the agent

Point an MCP client or an HTTP caller at a proxy instead of the upstream service.
Both credentials stay inside the proxy; the caller gets neither.

```ts
import { createSidecar } from "@actiongate/http-proxy";

createSidecar({
  actionGateUrl, actionGateApiKey,                  // stays in this process
  upstreamUrl: "http://payments.internal:9000",
  upstreamToken: process.env.UPSTREAM_TOKEN,        // stays in this process
  proxyToken: process.env.PROXY_TOKEN!,             // all the caller gets
  tenantId: "acme",
  routes: [{ method: "POST", path: "/refunds", tool: "refund_payment" }]
}).listen({ port: 8090 });
```

An unmapped route is a 404, never a pass-through.

For MCP, guarding a server is a **config edit with no code** — your client spawns
ActionGate, ActionGate spawns the real server:

```json
{ "mcpServers": { "payments": {
  "command": "npx",
  "args": ["tsx", "/path/to/actiongate-jev/scripts/mcp-guard.ts"],
  "env": { "UPSTREAM_COMMAND": "npx", "UPSTREAM_ARGS": "-y your-mcp-server", "TYPESAFE_API_KEY": "..." }
}}}
```

See [guarding an MCP server](docs/guard-an-mcp-server.md) for what that does and
does not protect. One screen per integration level is in the
[quickstarts](docs/quickstarts.md), and every connector states its boundary in
the [catalog](docs/catalog.md).

## What it costs to adopt

The boundary is strict; the on-ramp is not. Each tier is additive.

| Tier | You add | You get |
|---|---|---|
| 0 | `ActionGate.embedded()` | Guarded tools in one process — no server, no key, no database |
| 1 | A TypeSafe or OpenRouter key | Real Jev semantic evidence instead of the deterministic fake |
| 2 | The API server | A registry the agent cannot edit, plus audit, reviews, and incident controls |
| 3 | Redis and PostgreSQL | Restart-safe state, cross-replica consumption, encrypted durable evidence |

## How it works

<p align="center">
  <img src="docs/assets/platform-architecture.svg" alt="Applications connect through SDK, MCP, HTTP, or webhook adapters. ActionGate combines tenant identity, a server-owned registry, deterministic authority fed by trusted server-side fact providers, and decision-model evidence before issuing a single-use grant that is consumed at the guarded execution boundary." width="100%" />
</p>

ActionGate asks six narrow Jev questions in one request — alignment, target match,
policy conflict, sensitive-data exposure, scope expansion, missing intent — never
one vague "is this safe?", and never uses model prose as an authorization reason.

Identity comes from a hashed tenant key. Tool operation, schema, risk, and policy
come from a server-owned registry. Deterministic facts such as RBAC and spend
must be resolved by [server-side providers](docs/integrations.md#trusted-facts);
request-body claims cannot satisfy a hard rule, so an agent cannot vouch for itself. Only an
enforced `ALLOW` produces a grant, and it is consumed once before the side effect.

Full design: [architecture](docs/architecture.md) · [threat model](docs/threat-model.md) ·
[integrations](docs/integrations.md) · [API description](docs/api/openapi.json) ·
[runbooks](docs/runbooks.md) · [product plan](docs/PLANNING.md).

## Verification

```bash
pnpm lint && pnpm typecheck && pnpm test     # unit and package tests
pnpm test:integration                         # API, MCP, HTTP, review, incident paths
pnpm test:redis && pnpm test:postgres         # against real containers
pnpm test:python                              # Python SDK
pnpm e2e                                      # real browser
pnpm test:jev:live                            # real OpenRouter; spends credits
pnpm test:typesafe:live                       # direct TypeSafe; requires its own key
```

See [a real refusal](docs/a-real-refusal.md) for one live decision record with
its signals, cost, and latency.

`pnpm verify:live` runs everything end to end against a real stack — Redis,
PostgreSQL, live OpenRouter, both SDKs over HTTP, both proxies with real upstream
servers, the credential broker, the signed audit chain, and the UI in a real
browser. Nothing in it is mocked.

The direct TypeSafe adapter is covered by offline wire-contract and boundary
tests, but it is not yet live-verified because this project does not currently
have a `TYPESAFE_API_KEY`. Run `pnpm typesafe:smoke` and
`pnpm test:typesafe:live` before treating that route as verified.

Semantic quality is measured separately and honestly: `pnpm eval:calibrate`
refuses unreviewed labels, and `pnpm eval:drift` blocks a promotion that raises
the unsafe-allow rate. Reports include unsafe allow, auto-allow precision,
review rate, and false-block rate by tool/action type. See the
[annotator guidance](docs/annotation-guide.md) and the
[500–1,000-case independent benchmark issue](https://github.com/omkarghugarkar007/actiongate-jev/issues/8).

## Status

Not on npm or PyPI: `@actiongate/sdk` there belongs to another project and
`actiongate` on PyPI is taken. Cloning is the supported path, and it is verified
from a fresh clone on every change — install, `pnpm dev`, both SDKs with and
without a model key, both test suites, and the MCP guard over real stdio.

P0–P4 are engineering-complete: tenant-safe control plane, non-bypassable
execution, review and incident workflow, calibration with drift gating, telemetry
and quotas, tamper-evident exports, supply-chain provenance, the connector
catalog, embedded mode in both SDKs, config-only MCP guarding, and the evidence
loop.

**Two release-readiness items remain, and neither is a code change.** The semantic dataset's
labels were authored alongside the system they test, so they stay `generated` and
are excluded from quality reports until someone who did not write them reviews
them. And no external security review has happened. Until both are done, treat
this as an early public release.

ActionGate is an independent community project, not affiliated with or endorsed
by TypeSafe AI or OpenRouter.

Built and maintained by [Omkar Ghugarkar](https://github.com/omkarghugarkar007).

## Contributing

Integrations, policy examples, and adversarial cases are welcome — see the
[contribution guide](.github/CONTRIBUTING.md). Security reports follow the
[security policy](.github/SECURITY.md), not public issues.

If ActionGate helps you build safer agents, **star the repository**.

## License

Apache 2.0. See [LICENSE](LICENSE).
