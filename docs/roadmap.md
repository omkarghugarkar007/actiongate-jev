# ActionGate roadmap

ActionGate is developed in public. Work is ordered around durable identity and enforcement first, then network isolation, measurable decision quality, and broad plug-and-play integrations.

The destination is a hub with a connector catalog: a small core that owns identity, policy, and enforcement, surrounded by thin connectors that any application can add in minutes. Breadth is only worth building once the boundary it plugs into is real, which is why enforcement leads and the catalog follows.

Last reconciled: **2026-09-20**. P0 application controls are complete and verified against real Redis, PostgreSQL, and the live OpenRouter endpoint; ActionGate remains an early public release and does not yet claim production readiness.

## Standing constraints

These apply to every phase below, not to a phase of their own.

- **Friction budget.** Clone to first decision stays under five minutes with no model key, no database, and no container. Every new capability ships with a working zero-config default. Production hardening is opt-in in configuration and fail-closed in behavior. The budgets and adoption tiers are in [AGENTS.md](../AGENTS.md#adoption-friction-budget).
- **Live provider verification.** Any change on the decision path is verified against the real OpenRouter endpoint with `pnpm test:jev:live` before it is called done. Fixtures prove plumbing; only the live gate proves the integration. Resolved model, latency, and cost are recorded.
- **The value test.** Every feature must beat a direct provider call on authority, binding, enforcement, custody, or evidence. A feature that advances none of those is a wrapper and does not ship.

## Shipped foundation

- [x] Deterministic policy combined with structured Jev semantic evidence
- [x] Shadow and enforce modes with named, auditable reasons
- [x] Signed, expiring grants bound to tenant, environment, actor, tool, operation, arguments, risk, decision, and policy
- [x] Mutation, expiry, unknown-grant, revocation, and replay rejection
- [x] TypeScript client and guarded tool executor
- [x] Redis decisions, distributed idempotency, restart persistence, and atomic cross-instance grant consumption
- [x] Embeddable MCP gateway with server-owned tool metadata and consume-before-execute ordering
- [x] Provider token/cost capture, public security policy, CI, and security scanning
- [x] Live OpenRouter gate covering authorize, grant issue, single-use consume, and replay rejection

## P0 — tenant-safe durable control plane: complete

- [x] Slow-hashed, tenant/environment/role-scoped, one-time-display API keys
- [x] Authentication-derived tenant context and immediate key revocation
- [x] Role gates for decisions, grants, policy, registry, reviews, corrections, keys, export, and retention
- [x] Cross-tenant denial tests for reads and grant consumption
- [x] Durable tenant tool registry with JSON Schema, operation, owner, risk, sensitivity, policy, and enabled state
- [x] Registration-time schema/policy consistency checks and runtime argument validation
- [x] Registry-derived metadata and rejection of unknown tools, disabled tools, and risk/operation downgrades
- [x] PostgreSQL policies, registry, keys, reviews, corrections, and encrypted long-term audit events
- [x] Signing and encryption key IDs with explicit active keys and overlapping rotation windows
- [x] Individual API-key and grant revocation plus tool disablement
- [x] AES-256-GCM evidence encryption with authenticated tenant/object context
- [x] Tenant audit export and cutoff-based minimization/deletion
- [x] Production configuration fails closed without Redis, PostgreSQL, and explicit key rings
- [x] Real Redis/PostgreSQL restart, encryption, rotation, revocation, isolation, retention, and migration tests
- [x] Committed live OpenRouter end-to-end gate that fails loudly rather than skipping silently

## P1 — non-bypassable execution and complete review: complete

- [x] Package the gateway as a standalone MCP network proxy with authenticated transport
- [x] Add an HTTP reverse proxy/sidecar for applications that cannot embed the SDK
- [x] Add a credential broker for narrow, short-lived downstream credentials or signed requests
- [x] Publish a reference deployment where raw handlers and credentials are not directly reachable
- [x] Add trusted server-side fact providers for identity, RBAC, resource state, spend, duplicates, and allowlists
- [x] Add review list/claim/escalation plus exact-action revalidation at approval time
- [x] Mint a fresh approval grant and add configurable two-person approval
- [x] Add signed notification webhooks, retries, and dead-letter handling
- [x] Add bulk incident tool-disable and outstanding-grant revocation
- [x] Record execution attempted/completed/failed/reversed separately from authorization

### Adoption track — complete

These reduce friction without touching the enforcement boundary, so they do not wait for P2 assurance work.

- [x] Publish versioned TypeScript SDK and MCP gateway packages so adopters stop vendoring the workspace
- [x] Generate a versioned API description and typed clients from it
- [x] Define the connector manifest format and validate it in CI
- [x] Ship one-screen quickstarts for each shipped integration level
- [x] Add presets so a new connector needs no new configuration at Tier 0

## P2 — evidence, reliability, and production assurance

Engineering complete. Two items need people rather than code and are marked as such.

- [~] Replace generated cases with versioned, independently reviewed semantic examples and annotator guidance — *schema, provenance, annotator guidance, seed cases, and the gate that excludes unreviewed labels are shipped. The independent review itself is outstanding and cannot be done by the authors of the cases.*
- [x] Add provider-backed calibration, threshold sweeps, confidence intervals, and per-risk reports
- [x] Detect model, battery, policy, and dataset drift before promotion
- [x] Emit tenant-safe metrics/traces for decisions, providers, stores, grants, reviews, latency, and cost
- [x] Define SLOs and alerts; add per-tenant quotas and rate limits
- [x] Automate Redis/PostgreSQL backup, restore, replication, failover, and dependency-loss drills
- [x] Add signed/tamper-evident audit exports
- [x] Add container scanning, SBOM, release provenance, and signed artifacts
- [x] Publish deployment, migration, key-rotation, retention, restore, and incident runbooks
- [ ] Complete an external security review and remediate findings — *outstanding by definition: requires a reviewer outside this project.*

## P3 — connector catalog: complete

Packaging and the API description move into the P1 adoption track above; what remains here is breadth.

- [x] Add Python SDK parity
- [x] Add adapters for widely used agent and workflow frameworks with explicit Observe/Guard/Isolate labels
- [x] Add workflow-automation and webhook connectors
- [x] Add identity, secret-manager, gateway, service-mesh, incident, and observability integrations
- [x] Add guarded examples for email, CRM, booking, finance, infrastructure, and coding agents
- [x] Publish an adapter conformance suite for third-party integrations
- [x] Publish a browsable connector catalog driven by connector manifests
- [x] Add an interactive policy/decision simulator — *`POST /v1/simulate` plus a UI page. Hosting a public sandbox is a deployment decision, not a code change.*

The detailed acceptance gates are in [PLANNING.md](PLANNING.md), and the integration strategy is in [integrations.md](integrations.md).
