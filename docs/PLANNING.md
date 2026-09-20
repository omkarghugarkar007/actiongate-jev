# ActionGate product plan

> Living strategy, architecture, and delivery checklist. Update this file whenever a capability, limitation, or acceptance gate changes.

Last reconciled: **2026-09-20** against the implementation on `main`.

## North star

ActionGate is a plug-and-play control and enforcement plane for specialized decision models such as Jev. The model supplies typed semantic evidence; ActionGate turns that evidence into an operable decision lifecycle:

1. normalize a proposed action from any agent or workflow;
2. authenticate the tenant and resolve server-owned tool metadata;
3. combine deterministic policy with decision-model evidence;
4. issue a signed, short-lived permit only for an enforced allow;
5. consume that exact permit once at the side-effect boundary;
6. preserve tenant-safe reviews, corrections, audit, revocation, and outcomes;
7. make integration incremental across SDK, MCP, HTTP, gateways, and automation systems.

**Positioning:** Jev supplies evidence. ActionGate creates and enforces the permit.

**Shape:** a hub with a connector catalog. One small core owns identity, policy, and enforcement; thin connectors plug into it and are removable without residue. The comparison worth borrowing is a hub-and-plugin assistant platform, except the thing being brokered is a typed, enforceable decision rather than a chat channel.

**Constraint:** the boundary is strict, the on-ramp is not. A developer reaches a real decision in under five minutes with no key, no database, and no container, and adds durability only when they need it. Security that is expensive to adopt does not get adopted.

ActionGate must remain useful if Jev is replaced by another conforming decision provider. Provider normalization belongs outside the deterministic authorization core.

## Status at a glance

| Area | Status | Current reality |
|---|---|---|
| Exact-action enforcement | Shipped foundation | Signed, expiring grants bind the complete action and are consumed once or explicitly revoked. |
| Runtime data plane | Shipped for Redis | Decisions, distributed idempotency, grant state, revoke, and consume survive API restarts and coordinate replicas. |
| Tenant-safe control plane | P0 complete | PostgreSQL stores tenants, scoped/hashed/revocable keys, immutable policy, registry, reviews, corrections, and encrypted audit events. |
| Server-owned tools | P0 complete | Operation, JSON Schema, risk, owner, sensitivity, policy, and enabled state are tenant-owned; downgrades fail closed. |
| Key/evidence lifecycle | P0 complete | Signing and encryption key IDs support active-key rotation overlap; sensitive evidence is encrypted at rest. |
| Data governance | P0 complete at application layer | Tenant export plus cutoff-based Redis minimization and PostgreSQL evidence deletion are role-gated. |
| TypeScript integrations | Shipped | SDK, MCP gateway, MCP proxy, and HTTP proxy build as versioned packages with declared exports, a generated OpenAPI 3.1 description, and a generated typed client. Nothing is published to a registry yet. |
| Non-bypassable network boundary | Shipped | MCP proxy, HTTP reverse proxy, and credential broker all consume before forwarding. A reference topology publishes only the proxy; everything else is on an unreachable network. |
| Trusted facts | Shipped | Server-side providers resolve RBAC, spend, duplicate, and allowlist facts. Provenance and freshness are recorded, and `requireTrustedFacts` refuses caller-asserted facts. |
| Human approval | Shipped | Review queue with claim and escalation. Approval re-evaluates the exact action against current policy and registry and mints a fresh grant; two-person approval requires distinct reviewers. |
| Semantic quality evidence | Not established | Generated cases validate plumbing; they are not an independently reviewed model-quality benchmark. |
| Production operations | Not complete | Telemetry, quotas, failover drills, supply-chain provenance, and external security review remain. |
| Adoption friction | Holding budget | Tier 0 runs with no key, no database, and no container; tiers 1-3 are additive. Packaging is the main remaining friction. |
| Live provider evidence | Gate in place | `pnpm test:jev:live` exercises authorize, grant issue, single-use consume, and replay rejection against the real OpenRouter endpoint. |

**Production-ready claim: no.** P0 application controls are complete and tested, but P1 enforcement-boundary work and P2 operational/security evidence are still required for high-impact production use.

## Why use ActionGate instead of calling Jev directly?

| Capability | Direct Jev call | ActionGate |
|---|---|---|
| Semantic intent and scope evidence | Yes | Uses Jev through a provider-independent evidence interface |
| Authentication, RBAC, limits, allowlists, duplicate checks | Application must build it | Fixed-precedence deterministic policy |
| Tenant-scoped tool schema, risk, owner, sensitivity | Application must build it | Durable server-owned registry |
| Binding to exact action, actor, tenant, and policy | Application must build it | Canonical cryptographic fingerprint |
| Expiring, revocable, single-use permit | No | Action Grant plus atomic shared state |
| Shadow rollout and failure policy | Application must build it | First-class modes and risk-aware fallback |
| Durable roles, reviews, corrections, audit, retention | Application must build it | Tenant control plane and encrypted evidence |
| Execution boundary | No | SDK/MCP guard now; network proxy and credential broker next |
| Calibration, drift, latency, and cost evidence | Application must build it | Unified evidence loop target |

ActionGate is not valuable if it is only a convenient provider wrapper. The durable value is the identity-to-execution chain and the cross-integration evidence it produces.

## Adoption ladder

The answer to "is this heavy?" is that the weight is opt-in. Each tier is additive and the one below it keeps working.

| Tier | Developer adds | They get | Cost |
|---|---|---|---|
| 0 | Nothing | Decisions, named reasons, grants, dashboard, guarded examples | No key, no database, no container, no spend |
| 1 | A provider key | Real Jev semantic evidence through OpenRouter | Per-decision provider cost only |
| 2 | Redis | Restart-safe state, distributed idempotency, cross-replica consumption | One container |
| 3 | PostgreSQL and key rings | Durable tenants, registry, reviews, encrypted audit, rotation, retention | Operating a database |

A capability that cannot degrade down this ladder is not finished. A capability that forces a developer up a tier to get any value at all is a design failure, not a security requirement. Budgets are enforced in [AGENTS.md](../AGENTS.md#adoption-friction-budget).

## Product moats

### Enforcement moat

- exact-action, expiring, single-use, revocable grants;
- atomic replay protection across replicas;
- server-owned tool/risk metadata and immutable policies;
- network proxies and credential brokering that make bypass difficult.

### Integration moat

- one normalized authorization contract across SDK, MCP, HTTP, webhooks, and workflow engines;
- adapters classified as Observe, Guard, Isolate, or Govern;
- drop-in execution boundaries plus trusted fact connectors;
- versioned packages, generated clients, examples, and deployment templates.

### Evidence moat

- proposed, decided, reviewed, consumed, executed, failed, and reversed outcomes connected by stable IDs;
- risk-specific calibration and drift signals;
- operator-verified corrections converted into regression cases;
- separate, reproducible security, semantic, reliability, performance, and cost suites.

### Adoption moat

- a real decision in under five minutes with no credentials and no infrastructure;
- one wrapper around an existing function, removable without rewriting application code;
- connectors that declare level, protected surface, remaining bypass, and setup cost in a single manifest;
- presets instead of configuration surface, so breadth does not become weight.

### Operations moat

- tenant roles, policy/registry lifecycle, revocation, retention, export, and incident evidence;
- provider-independent behavior and safe dependency failure;
- signed/tamper-evident exports, quotas, SLOs, and regional controls over time.

## P0 completion record — tenant-safe durable control plane

### Authentication and authorization

- [x] Generate high-entropy tenant API keys and store only `scrypt` hashes plus non-secret prefixes.
- [x] Bind every key to one tenant, environment, and explicit role set.
- [x] Derive tenant/environment/roles from authentication and reject request mismatches.
- [x] Track key creation, last use, and revocation; return plaintext only once.
- [x] Role-gate authorization, consumption, reads, policy/tool writes, review/correction, key administration, export, and retention.
- [x] Prove explicit and opaque cross-tenant reads and cross-tenant consumption fail closed.
- [x] Reject the development static key in production configuration.

### Durable server-owned registry and policy

- [x] Persist tenant tools with name, operation, JSON Schema, owner, risk, sensitivity, policy, and enabled state.
- [x] Validate JSON Schema at registration and arguments before provider evaluation.
- [x] Require policy/registry operation and risk consistency.
- [x] Reject unknown/disabled tools, invalid arguments, invalid schemas, and downgrade attempts before evaluation.
- [x] Persist immutable policy versions with checksums and reject duplicate versions.
- [x] Derive effective tool metadata from the registry on authorize and consume paths.

### Key lifecycle and incident controls

- [x] Add versioned grant signing key IDs and explicit active-key selection.
- [x] Verify older keys during a configured overlap while new grants use the active key.
- [x] Revoke individual grants atomically and reject subsequent consumption.
- [x] Revoke API keys immediately and preserve actor identity in audit events.
- [x] Disable tools through the durable registry.
- [x] Fail production startup without explicit signing and encryption key rings.

### Durable administrative state and data governance

- [x] Wire PostgreSQL into the API for tenants, keys, policies, registry, reviews, corrections, and long-term audit events.
- [x] Preserve PostgreSQL control-plane state and Redis runtime state across API restart.
- [x] Encrypt sensitive Redis decision payloads and PostgreSQL review/correction/audit payloads with AES-256-GCM.
- [x] Bind encrypted envelopes to tenant/object context and include versioned key IDs.
- [x] Keep raw API keys and raw grant tokens out of list, detail, audit, export, and storage records.
- [x] Add tenant-scoped audit export.
- [x] Add cutoff-based Redis detail minimization and durable evidence deletion while retaining idempotency tombstones.
- [x] Run database migrations safely and idempotently against existing schema state.
- [x] Document infrastructure backup, restore, replication, and failover as deployment responsibilities; validation drills remain P2.

### P0 verification evidence

- [x] Configuration tests reject each unsafe production mode.
- [x] Unit tests cover hashing/revocation, encryption context/rotation, and grant signing rotation/retirement.
- [x] API tests cover tenant/environment/role enforcement, registry downgrade, invalid schema/arguments, key/grant revocation, reviews, corrections, and token-free export.
- [x] Redis tests cover restart persistence, distributed idempotency, and one successful cross-instance consumer.
- [x] PostgreSQL + Redis integration covers durable restart, isolation, ciphertext-at-rest assertions, policy persistence, key/grant rotation and revocation, export, and retention.
- [x] Migration command succeeds repeatedly.
- [x] A committed live gate runs authorize, grant issue, single-use consume, and replay rejection against the real OpenRouter endpoint, asserts the decision was attributed to the live gateway, and proves a deterministic RBAC failure still blocks when the model scores the request favourably.
- [x] The live gate fails loudly on a missing key rather than skipping silently, so a skipped suite can never be mistaken for a pass.
- [x] Hard rules are satisfied affirmatively. A control whose deterministic fact is absent blocks rather than passing, and regression tests cover each rule individually. This closed a fail-open found while building the MCP proxy: omitting `deterministicFacts` returned `ALLOW` with a grant for a `FINANCIAL` tool that required authentication, RBAC, and duplicate checks.

## P1 — make execution bypass materially harder

### Network enforcement products

- [x] Ship a standalone authenticated MCP proxy with upstream/downstream tool mapping.
- [x] Ship an HTTP reverse proxy/sidecar with declarative routes and request normalization.
- [x] Add a credential broker that exchanges a consumed grant for a narrow, short-lived downstream credential or signed request.
- [x] Publish a reference topology where the guarded boundary is the only route to the tool credential.
- [x] Add signed execution-result receipts that distinguish authorized, attempted, completed, failed, and reversed.

### Complete review and incident workflow

- [x] Add list/claim/escalate APIs for a real review queue.
- [x] Revalidate current policy, registry, resource state, and exact action at approval time.
- [x] Mint a fresh short-lived approval grant rather than changing the original decision.
- [x] Add configurable two-person approval for high-impact tools.
- [x] Add signed notification webhooks with retries and dead-letter handling.
- [x] Add bulk incident actions for tool disablement and outstanding-grant revocation.

### Trusted fact adapters

- [x] Define a server-side fact-provider interface for identity, entitlements, resource state, spend, duplication, and allowlists.
- [x] Mark the trust provenance and freshness of each fact in audit evidence.
- [x] Reject high-impact authorization when required trusted facts are absent or stale (`requireTrustedFacts` plus `maxFactAgeSeconds`).

### Adoption track (parallel to P1) — complete

Packaging and on-ramp work does not touch the enforcement boundary, so it does not wait for P2 assurance.

- [x] Publish versioned TypeScript SDK and MCP gateway packages so adopters stop vendoring the workspace.
- [x] Publish a versioned API description and generate typed clients from it.
- [x] Define the connector manifest format and validate it in CI.
- [x] Ship a one-screen quickstart for each shipped integration level.
- [x] Add presets so a new connector needs no new configuration at Tier 0.

P1 exit criteria:

- [ ] A reference tool cannot be reached or credentialed without successful grant consumption.
- [ ] Proxy mutation, replay, expiry, revocation, tenant mismatch, and dependency failure never reach the upstream handler.
- [ ] Approval always uses current state and a new exact-action grant.
- [ ] Demonstrated incident flow can disable a tool and revoke all relevant outstanding grants.
- [ ] Every new enforcement surface has been exercised against the real OpenRouter endpoint, with resolved model, latency, and cost recorded.
- [ ] Every new enforcement surface still runs at Tier 0 against the fake provider with no key, no database, and no container.
- [ ] No new required configuration was added at Tier 0; anything beyond three settings at a higher tier ships a preset.

## P2 — prove semantic quality and production operations

### Evaluation and calibration

- [ ] Replace generated examples with versioned, independently reviewed cases and annotator guidance.
- [ ] Add hard negative pairs, paraphrases, target swaps, scope creep, injection, and multilingual cases.
- [ ] Report unsafe-allow rate, auto-allow precision/coverage, review/block rates, confusion matrices, and confidence intervals by risk.
- [ ] Run provider-backed threshold sweeps and freeze model, battery, policy, and dataset versions in each report.
- [ ] Detect provider/model drift before promotion.

### Reliability and observability

- [ ] Emit tenant-safe metrics/traces for decisions, providers, stores, grants, reviews, latency, and cost.
- [ ] Define SLOs and alerts for availability, unsafe allows, review volume, provider errors, storage failures, and replay attempts.
- [ ] Add per-tenant quotas and rate limits.
- [ ] Test Redis/PostgreSQL backup, restore, replication, failover, and dependency loss in an automated environment.
- [ ] Add encrypted export signing and tamper-evident audit chaining.

### Supply chain and assurance

- [ ] Add secret scanning, container scanning, SBOM generation, release provenance, and signed artifacts.
- [ ] Publish deployment, key-rotation, retention, migration, restore, and incident runbooks.
- [ ] Complete an external security review and remediate findings before any production-ready claim.

## P3 — connector catalog

Packaging and the API description moved into the P1 adoption track. What remains here is breadth.

- [ ] Add a Python SDK with parity for authorize/consume/wrap.
- [ ] Add framework adapters only after the integration-level/bypass boundary is explicit.
- [ ] Add workflow/automation connectors and signed webhook recipes.
- [ ] Add examples for email, CRM, booking, finance, infrastructure, and coding actions.
- [ ] Provide local integration conformance tests that third-party adapters can run.
- [ ] Publish a browsable connector catalog driven by connector manifests.
- [ ] Build a hosted sandbox and policy/decision simulator using fake tools.

Detailed integration priorities and acceptance rules are in [integrations.md](integrations.md).

## Benchmark specification

Never collapse these dimensions into one marketing score.

### A. Enforcement security

Attempt replay, signature mutation, expiry, revocation, tenant/environment/actor/tool/operation/arguments/risk/policy mutation, shadow/review/block consumption, concurrent double use, key rotation, registry downgrade, and cross-tenant access.

Primary metric: **unauthorized acceptances**. Release gate: `0`.

### B. Semantic safety

Use independently reviewed cases stratified by risk and difficulty. Report unsafe-allow rate, auto-allow precision, safe-task coverage, review/block rates, confusion matrix, confidence intervals, and all model/policy/battery/dataset versions.

Fixture replay and generated-label integrity are not semantic accuracy.

### C. Reliability

Test provider timeout/unavailability/malformed output, concurrent idempotency, database/replay-store interruption, restart, key rotation, ciphertext/redaction, tenant isolation, retention, backup/restore, and failover.

### D. Adoption cost

Measure what a developer spends to get protection: minutes from clone to first decision, lines of application code changed, required environment variables, required services, and steps to remove the integration.

Primary metric: **steps to a guarded side effect at Tier 0**. Regression gate: no increase without an explicit, documented tradeoff.

### E. Performance and cost

Measure deterministic short-circuit latency, provider latency, API-key verification, grant issue/consume, storage operations, end-to-end concurrency, tokens, and provider cost separately. Local in-process numbers are regression baselines, not hosted throughput claims.

## Decision rules

Prioritize work that:

1. makes bypass harder at the real side-effect boundary;
2. reduces unsafe allows or increases useful automation with measured evidence;
3. lowers integration effort without weakening identity or execution controls;
4. creates durable operational evidence unavailable from a direct model call;
5. makes policy, review, retention, or incident operations safer at scale;
6. removes an adoption step without weakening the boundary.

Before calling any decision-path work done, verify it against the real OpenRouter endpoint. A change that passes only against fixtures has not been shown to work.

Deprioritize decorative dashboards, provider-count marketing, and shallow framework logos until the relevant enforcement, evidence, and operations acceptance gates pass.
