# Integration ecosystem

ActionGate aims to make specialized decision models useful through a plug-and-play authorization layer. Every integration should reuse the same tenant identity, tool registry, policy, decision evidence, and Action Grant lifecycle instead of reimplementing safety logic in each framework.

The target shape is a hub with a connector catalog: one small core that owns identity, policy, and enforcement, plus many thin connectors that plug into it. A connector should be something a developer adds in minutes and removes without residue — never a framework they have to adopt. If a connector needs its own policy engine, its own notion of tenant, or its own permit format, it is doing the core's job and the design is wrong.

## Integration levels

Not every connector provides the same security boundary. Documentation and package names should state the level explicitly.

| Level | Behavior | Security value |
|---|---|---|
| Observe | Sends proposed actions in Shadow Mode and records `wouldHaveDecision` | Fast evaluation; no execution control |
| Guard | Authorizes and consumes a grant immediately before invoking a handler | Strong in-process boundary if the raw handler stays private |
| Isolate | Owns the network path or downstream credential and refuses access without grant consumption | Makes bypass materially harder |
| Govern | Connects identity, registry, review, audit, incident, and observability systems | Operable control plane across teams |

The target is broad compatibility at Observe/Guard and a smaller set of high-confidence Isolate integrations.

## Common adapter contract

Every action adapter should provide:

- a stable tool name and normalized operation;
- JSON Schema for canonical arguments;
- owner, data sensitivity, and risk classification;
- authenticated tenant, environment, actor, and role context;
- user intent and a minimal set of decision-relevant resources;
- deterministic facts obtained from trusted application services, preferably through a server-side fact provider rather than the request body;
- a unique request ID and idempotency key;
- a private execution function or isolated credential boundary;
- execution outcome metadata for the evidence loop.

The registry—not the agent—owns operation, schema, risk, sensitivity, and policy linkage. An adapter may send those fields for explicit binding, but ActionGate rejects mismatches.

## Connector manifest

Every connector declares itself the same way so the catalog stays machine-readable and a developer can tell what they are installing before they install it. A connector that cannot fill this out honestly is not ready to publish.

| Field | Meaning |
|---|---|
| `name` | Stable connector identifier |
| `level` | `observe`, `guard`, `isolate`, or `govern` |
| `protects` | The handler, endpoint, or credential behind the boundary |
| `bypass` | Remaining unguarded paths, stated plainly |
| `requires` | Provider key, Redis, PostgreSQL, or nothing |
| `tools` | Tool names and operations the connector proposes |
| `facts` | Deterministic facts it supplies and where each originates |
| `setup` | Steps a developer performs, counted honestly |

`bypass` is mandatory and may not be empty. "None known" is a claim that must be backed by the connector's negative tests.

### Worked example: the MCP proxy manifest

| Field | Value |
|---|---|
| `name` | `@actiongate/mcp-proxy` |
| `level` | `isolate` |
| `protects` | The upstream MCP server's network endpoint and its credential, which stay inside the proxy process |
| `bypass` | Anything that can reach the upstream MCP server directly. The proxy only isolates if the upstream endpoint is not routable from the agent. Relayed user intent is agent-supplied, so it is semantic evidence, not trusted input; it can never override a hard rule. |
| `requires` | An ActionGate API key, an upstream URL and credential, and one downstream proxy token. Nothing else. |
| `tools` | Whatever the tenant registry enables and the upstream server also exposes; the intersection, never the union |
| `facts` | None by default. Configure a server-side fact provider on the ActionGate API so RBAC, spend, and duplicate checks are resolved rather than asserted; without one, any tool carrying hard rules fails closed. |
| `setup` | Point the MCP client at the proxy URL and give it a proxy token. No application code changes. |

What the proxy refuses, in every case without calling upstream: an unknown or disabled tool, a tool the registry does not own, a `BLOCK` or `REVIEW` decision, an enforced allow with no grant, a failed consumption, an unreachable ActionGate, an unauthenticated caller, and any JSON-RPC method it does not explicitly handle.

## Connector friction rules

The catalog is only useful if adding a connector is cheaper than hand-rolling the same protection. Budgets come from the [adoption friction budget](../AGENTS.md#adoption-friction-budget).

1. **Work at Tier 0.** Every connector must run against the fake provider with no key, no database, and no container. A connector that only works against a full production stack cannot be evaluated, and will not be adopted.
2. **One screen to adopt.** The smallest working example fits on one screen. If it does not, the connector needs a preset, not a longer README.
3. **No new required configuration.** Defaults cover the common case. A connector that needs more than three settings at any tier ships a preset instead.
4. **Removable.** Document how to take the connector out. A connector that cannot be removed without rewriting application code is a framework.
5. **No parallel safety logic.** Thresholds, risk classes, retries that change semantics, and local permit caches belong in the core or nowhere.
6. **Honest level.** Claim `guard` only when the raw callable is private. Claim `isolate` only when the connector owns the network path or the credential. When unsure, claim `observe`.

## Shipped integrations

| Integration | Level | Status | Notes |
|---|---|---|---|
| REST API | Observe / Guard building block | Shipped | Language-neutral authorize, consume, registry, key, review, audit, and retention endpoints |
| TypeScript client | Guard | Shipped in workspace | `wrapTool` authorizes, consumes, then calls a private function |
| MCP gateway | Guard | Shipped in workspace | Owns tool metadata and keeps the grant outside model-visible arguments |
| MCP proxy | Isolate | Shipped in workspace | Standalone network service; holds the upstream credential and consumes a grant before forwarding |
| Redis runtime adapter | Govern | Shipped | Distributed idempotency, decision state, revocation, and one-time consumption |
| PostgreSQL control-plane adapter | Govern | Shipped | Tenant keys, policies, registry, reviews, corrections, encrypted audit |

Workspace packages are not yet published to a package registry. Until versioned releases exist, use the REST contract or workspace dependencies.

## Priority integration map

### P1: hard execution boundaries

1. **Standalone MCP proxy** — shipped. See the manifest below.
2. **HTTP reverse proxy and sidecar** — declarative route-to-tool mapping, request normalization, response capture, retries that preserve idempotency, and deployment templates.
3. **Credential broker** — exchange a consumed Action Grant for a narrow, short-lived downstream credential or signed request.
4. **Webhook gateway** — signed outbound payloads, delivery retries, destination allowlists, and result evidence.

### P2: developer frameworks

- Python SDK with the same authorize/consume/wrap contract as TypeScript;
- adapters for popular TypeScript/Python agent and workflow frameworks;
- server middleware for common web frameworks;
- automation-platform actions and triggers;
- generated clients from an explicit, versioned API description.

Framework adapters are Guard integrations only when the raw callable is private. Otherwise they must be labeled Observe.

### P2/P3: enterprise control plane

- identity providers and workload identity;
- API gateways and service meshes;
- secret managers and cloud credential services;
- review/incident systems and signed notification webhooks;
- telemetry exporters and data warehouses;
- policy-as-code repositories and controlled environment promotion.

## Trusted facts

Deterministic facts decide whether a hard rule passes, so where they come from matters more than what they say.

- **Caller-supplied facts are untrusted.** Anything in the request body was asserted by whoever called the API. An agent that can reach ActionGate can claim its own RBAC.
- **Provider-resolved facts are trusted.** A `TrustedFactProvider` runs inside the ActionGate API and asks a service the deployment operates. Its answer overrides the caller's claim about the same fact.
- **Provenance is evidence.** Every decision records which facts were resolved and by which provider, so an audit can tell a vouched-for fact from a claimed one.
- **Mark high-impact tools `requireTrustedFacts`.** That tool then refuses caller-asserted facts outright. Add `maxFactAgeSeconds` where a stale answer would be dangerous.
- **A failing provider fails closed.** It contributes no facts, so the rule it would have satisfied is unevaluable and blocks, with `FACT_PROVIDER_UNAVAILABLE` explaining why.

A connector cannot make its own facts trusted. Facts sent by an adapter — including the MCP proxy — arrive as caller provenance, because from the API's perspective an adapter is just a client. Trust is established by running a provider on the API side.

## Adapter design rules

1. **Normalize before authorization.** The exact canonical arguments being authorized must be the arguments later executed.
2. **Keep credentials behind the boundary.** The agent and caller should never receive the downstream secret.
3. **Consume at the last responsible moment.** Consumption belongs immediately before the side effect, after local validation and before credentials are used.
4. **Fail closed on ambiguity.** Unknown tool, missing grant, registry mismatch, invalid schema, changed arguments, expiry, revocation, and replay stop execution.
5. **Preserve idempotency.** Retries reuse the same key only for the same canonical request. Changed payloads need a new key after reconciliation.
6. **Record outcomes separately.** Authorization success is not proof that the business operation completed.
7. **Do not leak model-visible permits.** Prefer combined server-side authorize-and-execute flows; otherwise carry grants in protected metadata.
8. **Test the negative path.** Every adapter needs assertions that the handler is not called after authorization, consumption, mutation, tenant, or dependency failure.

## Definition of done for a new integration

- example works against the fake provider with zero external spend;
- tool metadata is server-owned or synchronized through an authenticated administrator path;
- tenant and environment come from authenticated context;
- exact arguments are schema-validated and bound to consumption;
- no raw API key, grant, or downstream credential appears in logs, errors, fixtures, or model-visible fields;
- `BLOCK`, `REVIEW`, missing grant, mutation, expiry, revocation, replay, and cross-tenant use never call the handler;
- restart and concurrent-consumption behavior is tested when the adapter is networked;
- README states its integration level and bypass assumptions;
- latency and provider cost are reported separately from security correctness;
- the connector has been exercised once against the real OpenRouter endpoint with `pnpm test:jev:live`, and the resolved model, latency, and cost are recorded;
- the connector manifest is complete, including a non-empty `bypass` statement;
- the setup steps were counted against the friction budget and the count is published.

## Contributing an adapter

Start with a concrete side effect and threat boundary, not a framework logo. A proposal should identify:

1. the handler or credential being protected;
2. where trusted identity and deterministic facts originate;
3. how tool metadata enters the registry;
4. where grant consumption occurs;
5. what unguarded bypass paths remain;
6. the positive, failure, cross-tenant, replay, and restart tests;
7. the smallest copy-paste example a new adopter can run.

The delivery order is tracked in [roadmap.md](roadmap.md); the architecture invariants are in [AGENTS.md](../AGENTS.md).
