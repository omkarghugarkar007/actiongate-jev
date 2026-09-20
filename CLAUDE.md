# CLAUDE.md

Working agreement for Claude Code in this repository. [AGENTS.md](AGENTS.md) is canonical for product direction and security invariants; this file repeats what is needed in-session and adds the operational detail. When the two disagree, AGENTS.md wins and this file should be corrected.

## What this project is

ActionGate is a plug-and-play control plane for specialized decision models such as Jev. The primitive is a typed, enforceable decision, not generated text.

The shape to aim for is a hub with a connector catalog: one small core that owns identity, policy, and enforcement, plus many thin connectors that plug into it. Think of a hub-and-plugin assistant platform, except what is brokered is an enforceable permit rather than a chat channel.

**Jev supplies evidence. ActionGate creates and enforces the permit.** ActionGate must stay useful if Jev is replaced by another conforming provider, so enforcement logic never couples to one vendor's response shape.

## Before writing code

Two questions gate every change.

**The value test.** What does this give a developer that calling the provider endpoint directly does not? Valid answers are authority, binding, enforcement, custody, or evidence. If a change advances none of them, it is a wrapper — either justify it as friction reduction or drop it.

**The friction test.** What does a developer now have to do that they did not have to do before? The answer should be nothing. Budgets:

| Budget | Limit |
|---|---|
| Clone to first decision | under five minutes, no model key, no database, no container |
| Guarding an existing function | one wrapper, no new service to operate |
| Required configuration to start | zero; every knob has a safe default |
| Copy-paste example per integration | fits on one screen |
| New required environment variables | zero at Tier 0; a preset if a tier needs more than three |

Capabilities degrade down this ladder, and each tier keeps the one below it working:

| Tier | Developer adds | They get |
|---|---|---|
| 0 | Nothing | Decisions, reasons, grants, dashboard, examples — no credentials, no spend |
| 1 | A provider key | Real Jev evidence through OpenRouter |
| 2 | Redis | Restart-safe state, distributed idempotency, cross-replica consumption |
| 3 | PostgreSQL and key rings | Durable tenants, registry, reviews, encrypted audit, rotation, retention |

Never require a database, Redis, key ring, or registry write to evaluate ActionGate locally. Lowering friction may reduce what a developer sets up; it may never reduce what is enforced. Prefer a preset over a new knob.

## Security invariants

Do not weaken these to make a test pass or an integration simpler.

- Treat agent arguments, retrieved text, user text, headers, and tenant identifiers as untrusted.
- Derive tenant, environment, and roles from authenticated server-side context.
- Derive operation, argument schema, risk class, and policy from the server-owned registry.
- Never let a model probability override authentication, RBAC, schema, amount, allowlist, duplicate, or availability failures.
- Issue grants only for enforced `ALLOW` decisions.
- Bind grants to the exact tenant, environment, actor, tool, operation, arguments, risk class, decision, and policy version.
- Consume grants atomically before execution. Mutation, expiry, revocation, unknown grants, and replay fail closed.
- Never persist or return raw grant tokens in audit, list, detail, export, logs, or model-visible state.
- Store API keys as slow hashes; return newly issued plaintext keys once.
- Encrypt sensitive audit evidence at rest with a versioned key ID and authenticated context.
- Preserve immutable audit events for policy, registry, key, review, override, revocation, retention, and execution-boundary changes.
- Do not claim exactly-once side effects. ActionGate provides at-most-once authorization.

## Where code goes

| Path | Owns |
|---|---|
| `packages/core` | Provider-independent contracts, policy, fingerprints, grant signing, decision composition |
| `packages/decision-provider` | Adapters that normalize external decision-model evidence |
| `apps/api` | Authentication, tenant scoping, registry enforcement, durable repositories, HTTP APIs |
| `packages/sdk-js` | Client integration that authorizes and consumes before invoking handlers |
| `packages/mcp-gateway` | Guarded MCP registry and consume-before-execute boundary |
| `packages/db` | Control-plane schema and migrations |
| `packages/evals` | Integrity checks and, eventually, reviewed semantic calibration |
| `docs` | Architecture, security boundary, integration guides, roadmap, product plan |

Core must not import provider, database, web framework, or integration packages. Provider adapters must not make authorization decisions. Integrations execute only after the API has composed policy and the grant has been consumed.

## Implementation expectations

- Keep public contracts strict and versioned. Validate every network and persisted boundary.
- Prefer small interfaces around authentication, control-plane storage, runtime state, providers, and execution boundaries.
- Memory mode stays suitable for local development. Production configuration fails closed without Redis, PostgreSQL, signing keys, and evidence-encryption keys.
- Migrations must handle existing rows. Never assume a production table is empty.
- Use atomic database or Redis operations for idempotency, consumption, revocation, and state transitions.
- Keep secrets out of fixtures, snapshots, logs, errors, documentation, and Git history.
- Maintain backward verification during key-rotation windows; new grants use the active key ID.
- When capabilities or limitations change, update the README architecture section, `docs/architecture.md`, `docs/threat-model.md`, `docs/roadmap.md`, `docs/integrations.md`, and `docs/PLANNING.md` in the same change.

## Verification

Run what the change touches; run everything when a security invariant moves.

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit and package tests
pnpm test:integration  # API and MCP integration
pnpm test:redis        # requires Redis
pnpm db:migrate
pnpm test:postgres     # requires PostgreSQL
pnpm build
pnpm e2e
pnpm audit --prod
```

Security-sensitive work needs positive behavior *and* explicit failures for tenant, environment, role, tool, operation, schema, arguments, risk, policy version, signature, expiry, revocation, replay, concurrency, restart, and dependency loss.

### Live provider verification — required

The fake provider proves plumbing. Only the live gate proves the integration works.

```bash
pnpm test:jev:live   # authorize -> grant -> consume against the real OpenRouter endpoint
pnpm jev:smoke       # single call; prints resolved model, gateway, and latency
```

- Run `pnpm test:jev:live` before calling any decision-path change done: provider adapters, wire translation, response parsing, question batteries, decision composition, policy thresholds, timeout and fallback behavior.
- A new capability on the decision path is not done until it has run against the real OpenRouter API, not only against fixtures.
- Assert the decision was attributed to the live gateway. A test that would still pass with the fake provider is not a live test.
- Record the resolved model ID, latency, and token or cost impact. Requested and resolved model IDs differ — report the resolved one.
- A skipped live suite is never a pass. `pnpm test:jev:live` sets its own opt-in flag and throws on a missing key. Keep it that way.
- Keep live suites opt-in by script name so ordinary runs and CI never spend credits by accident.

Never report generated-label replay or dataset integrity as model accuracy. Semantic quality, enforcement security, reliability, adoption cost, and performance/cost are separate dimensions and stay separate.

## Local environment notes

- `.env` is gitignored. `.env.example` is the template; keep it current when configuration changes.
- The provider key may be `OPENROUTER_API_KEY` or the local alias `OPENROUTER_KEY`.
- Infrastructure runs from `infra/docker-compose.yml`. The Postgres host port comes from `POSTGRES_PORT`, and on this machine it is **55432** because another service holds 5432. `DATABASE_URL` in `.env` must match, or `pnpm test:postgres` fails with a password error that looks like a credentials bug.
- `apps/api/src/config.ts` imports `dotenv/config`, so `.env` is loaded for any test that imports the app.
- When appending to `.env`, check for a trailing newline first. Appending to a file that lacks one silently corrupts the last value.
- `.actiongate/` holds local benchmark and verification output and is gitignored. Anything there that should be a repeatable gate belongs in the repo instead.

## Documentation voice

Lead with concrete value and honest boundaries. Do not describe the project as production-ready until every P0 exit criterion in `docs/PLANNING.md` passes. State bypass paths plainly; an integration is only an enforcement integration if the raw handler or downstream credential has no unguarded path.
