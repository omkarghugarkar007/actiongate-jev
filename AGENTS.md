# ActionGate contributor guide for coding agents

## Product direction

ActionGate is a plug-and-play control plane for specialized decision models such as Jev. The core primitive is a typed, enforceable decision rather than generated text.

The shape to aim for is a hub-and-connector platform in the spirit of OpenClaw, but for decision models instead of chat channels: one small core that owns identity, policy, and enforcement, a published connector contract, and a growing catalog of drop-in integrations that each reuse that core rather than reimplementing safety.

ActionGate makes decision models useful in real systems by providing the layers they do not provide alone:

1. normalized, typed evidence from one or more decision-model providers;
2. deterministic policy composition and server-owned tool metadata;
3. exact-action, expiring, single-use authorization grants;
4. enforcement at the real side-effect boundary;
5. durable tenant identity, review, audit, revocation, and incident workflows;
6. calibration, cost, latency, reliability, and drift evidence;
7. integrations that make adoption incremental and low-friction.

ActionGate must remain useful even when Jev is replaced by another conforming decision provider. Jev is the first and primary provider integration, not a reason to couple enforcement logic to one vendor response.

## The value test

Every feature must answer one question before it ships:

> What does this give a developer that calling the provider endpoint directly does not?

If the honest answer is "nothing", the feature is a wrapper and does not belong here. The durable answers are:

- **Authority.** A model probability becomes a deterministic `ALLOW`, `REVIEW`, or `BLOCK` with named reasons.
- **Binding.** A decision is cryptographically tied to one exact action, actor, tenant, and policy version.
- **Enforcement.** A permit is expiring, revocable, and consumable exactly once at the side-effect boundary.
- **Custody.** Tool schema, risk, owner, and policy live in a server-owned registry the agent cannot edit.
- **Evidence.** Proposed, decided, reviewed, consumed, executed, failed, and reversed outcomes share stable IDs.

A direct provider call gives none of these. State which of the five a change advances in its description; if it advances none, justify it as friction reduction instead.

## Adoption friction budget

Security that is expensive to adopt does not get adopted. Treat friction as a first-class constraint with explicit budgets, not as a tradeoff to be argued case by case.

| Budget | Limit |
|---|---|
| Clone to first decision | under five minutes, no model key, no database, no container |
| Guarding an existing function | one wrapper, no new service to operate |
| Required configuration to start | zero; every knob has a safe default |
| Copy-paste example per integration | fits on one screen |
| New required environment variables per feature | zero at Tier 0; a preset if a tier needs more than three |

### Adoption tiers

Capabilities must degrade cleanly down this ladder. A developer moves up only when they need what the next tier provides.

| Tier | What the developer runs | What they get |
|---|---|---|
| 0 | `pnpm dev` with the fake provider | Decisions, reasons, grants, and the dashboard with zero credentials |
| 1 | Adds a provider key | Real semantic evidence from Jev through OpenRouter |
| 2 | Adds Redis | Restart-safe state, distributed idempotency, cross-replica consumption |
| 3 | Adds PostgreSQL and key rings | Durable tenants, registry, reviews, encrypted audit, rotation, retention |

Rules that keep the ladder honest:

- Never require a database, Redis, key ring, or registry write to evaluate ActionGate locally.
- Every new capability ships with a working zero-config default and a documented way to turn it off.
- Production hardening is opt-in in configuration and fail-closed in behavior. Lowering friction must never lower the enforced boundary; it may only lower what a developer has to set up before reaching it.
- Prefer one good default over a configuration surface. Add a preset before adding a knob.

## Product priorities

Work in this order unless the product plan explicitly changes:

1. make bypass and cross-tenant access harder;
2. make the decision and enforcement lifecycle durable;
3. make integration easier without weakening the boundary;
4. prove semantic quality using independently reviewed evidence;
5. add workflow and ecosystem breadth.

High-value integration targets include:

- MCP servers and authenticated MCP proxies;
- generic HTTP tools, webhooks, and sidecars;
- TypeScript and Python applications;
- agent frameworks and AI SDKs;
- workflow engines and automation platforms;
- API gateways, service meshes, and credential brokers;
- review systems, incident tooling, and observability stacks.

An integration is only an enforcement integration if the raw handler or downstream credential is unavailable through an unguarded path. Clearly label advisory-only integrations.

## Security invariants

- Treat agent arguments, retrieved text, user text, headers, and tenant identifiers as untrusted.
- Derive tenant, environment, and roles from authenticated server-side context.
- Derive operation, argument schema, risk class, and policy from a server-owned registry.
- Never let a model probability override authentication, RBAC, schema, amount, allowlist, duplicate, or availability failures.
- Issue grants only for enforced `ALLOW` decisions.
- Bind grants to the exact tenant, environment, actor, tool, operation, arguments, risk class, decision, and policy version.
- Consume grants atomically before execution. Mutation, expiry, revocation, unknown grants, and replay fail closed.
- Never persist or return raw grant tokens in audit, list, detail, export, logs, or model-visible state.
- Store API keys as slow hashes and return newly issued plaintext keys once.
- Encrypt sensitive audit evidence at rest with a versioned key ID and authenticated context.
- Preserve immutable audit events for policy, registry, key, review, override, revocation, retention, and execution-boundary changes.
- Do not claim exactly-once side effects; ActionGate provides at-most-once authorization.

## Architecture boundaries

- `packages/core`: provider-independent contracts, policy, fingerprints, grant signing, and decision composition.
- `packages/decision-provider`: adapters that normalize external decision-model evidence.
- `apps/api`: authentication, tenant scoping, registry enforcement, durable repositories, and HTTP APIs.
- `packages/sdk-js`: client-side integration that authorizes and consumes before invoking handlers.
- `packages/mcp-gateway`: guarded MCP registry and consume-before-execute boundary.
- `packages/db`: durable control-plane schema and migrations.
- `packages/evals`: integrity checks and, eventually, reviewed semantic calibration suites.
- `docs`: public architecture, security boundary, integration guides, roadmap, and product plan.

Core must not import provider, database, web framework, or integration packages. Provider adapters must not make authorization decisions. Integrations must execute only after the API has composed policy and the grant has been consumed.

## Implementation expectations

- Keep public contracts strict and versioned. Validate every network and persisted boundary.
- Prefer small interfaces around authentication, control-plane storage, runtime state, providers, and execution boundaries.
- Keep the memory mode suitable for local development; production configuration must fail closed without Redis, PostgreSQL, signing keys, and evidence-encryption keys.
- Add migrations that safely handle existing rows. Never assume a production table is empty.
- Use atomic database or Redis operations for idempotency, consumption, revocation, and state transitions.
- Keep secrets out of fixtures, snapshots, logs, errors, documentation, and Git history.
- Maintain backward verification during explicit key-rotation windows; new grants use the active key ID.
- Update the README architecture, `docs/architecture.md`, `docs/threat-model.md`, `docs/roadmap.md`, `docs/integrations.md`, and `docs/PLANNING.md` when capabilities or limitations change.

### Keep the picture and the front page current

The README and the architecture diagram are the first thing anyone sees. They drift faster than anything else in the repo, so treat them as part of the change, not as follow-up work.

- `docs/assets/platform-architecture.svg` is the canonical picture of the system. When a change adds, removes, or moves a boundary, a store, an integration surface, or a stage in the decision path, redraw it in the same change. A diagram showing a boundary the code does not have is worse than no diagram.
- The other diagrams are scoped: `authorization-flow.svg` covers the decide path, `action-grant-flow.svg` the permit lifecycle, `trust-model.svg` the trust boundaries. Update whichever one a change makes wrong.
- Every diagram needs an `alt` description that states what it shows, not what it is called. Someone reading without the image should still get the architecture.
- The README must name what ships today. When an integration reaches Guard or Isolate, it belongs on the front page with its boundary stated; when something is still missing, the README says so rather than implying it exists.
- A new capability on the adoption ladder updates the tier table in the README and in `docs/PLANNING.md`.

## Verification expectations

Run the checks relevant to every change and expand coverage when a security invariant changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:redis
pnpm db:migrate
pnpm test:postgres
pnpm build
pnpm e2e
pnpm audit --prod
```

Security-sensitive work should test positive behavior and explicit failures for tenant, environment, role, tool, operation, schema, arguments, risk, policy version, signature, expiry, revocation, replay, concurrency, restart, and dependency loss.

### Live provider verification

The fake provider proves plumbing. Only the live gate proves the integration actually works.

```bash
pnpm test:jev:live   # authorize -> grant -> consume against the real OpenRouter endpoint
pnpm jev:smoke       # single call; records resolved model, gateway, and latency
```

- Run `pnpm test:jev:live` before claiming any change works when the change touches provider adapters, wire translation, response parsing, question batteries, decision composition, policy thresholds, timeout and fallback behavior, or anything else that alters what is sent to or read from the model.
- A new capability that sits on the decision path is not done until it has been exercised against the real OpenRouter API, not only against fixtures.
- Assert that the decision was attributed to the live gateway. A test that would still pass with the fake provider is not a live test.
- Record the resolved model ID, latency, and token or cost impact. The requested model and the resolved model differ; report the resolved one.
- A skipped live suite is never a pass. `pnpm test:jev:live` enables itself and fails loudly when the key is missing; keep it that way.
- Keep live suites opt-in by script name so ordinary runs and CI never spend credits by accident.

Do not report generated-label replay or dataset integrity as model accuracy. Keep semantic quality, enforcement security, reliability, performance, and cost as separate benchmark dimensions.

## Documentation voice

Lead with concrete value and honest boundaries. Use "Jev supplies evidence; ActionGate creates and enforces the permit" as the architectural shorthand. Do not describe the project as production-ready until every P0 exit criterion in `docs/PLANNING.md` passes.
