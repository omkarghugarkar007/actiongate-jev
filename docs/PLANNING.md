# ActionGate product plan

> Living strategy, architecture, and delivery checklist. Update this file when a milestone ships or product assumptions change.

Last reconciled: **2026-09-19** against the implementation on `main`.

## Product thesis

Jev is a strong structured semantic decision model. A direct Jev call can answer questions such as whether a proposed action matches user intent, expands scope, or has enough evidence. That is necessary, but it is not an authorization system.

ActionGate's durable job is to own the complete authorization lifecycle around that signal:

1. bind an authorization request to an exact action;
2. combine deterministic policy with semantic evidence;
3. issue an enforceable, short-lived permit only when the result is safe;
4. consume that permit at the execution boundary exactly once;
5. preserve an auditable explanation without storing credentials or permit tokens;
6. learn from reviews, overrides, incidents, and production outcomes.

**Positioning:** Jev supplies evidence. ActionGate creates and enforces the permit.

This follows established authorization architecture: policy decision points are separate from policy enforcement points in [OPA](https://www.openpolicyagent.org/docs/deploy), while [Cedar](https://docs.cedarpolicy.com/) and [AWS Verified Permissions](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/terminology.html) evaluate a principal, action, resource, and context. Agent tools add a semantic problem because model-selected tools can cause real side effects; the [MCP server specification](https://modelcontextprotocol.io/specification/draft/server/index) treats tools as model-controlled, and [MCP authorization guidance](https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html) places enforcement at the HTTP boundary before the tool handler runs.

## Status at a glance

| Area | Status | What that means today |
| --- | --- | --- |
| Exact-action enforcement | Complete foundation | Signed, expiring grants are bound to the full action and consumed once before execution. |
| Shared runtime state | Complete for Redis | Decisions, idempotency leases, grants, and consumption state survive API restarts and work across replicas. |
| TypeScript enforcement integrations | Partial | The SDK wrapper and embeddable MCP gateway are implemented; a standalone authenticated proxy is not. |
| Tenant identity and access control | Not production-ready | The API still uses one configured bearer key and accepts caller-supplied tenant context. |
| Policy and tool control plane | Partial | Policies are immutable but in-process; the MCP gateway owns its local tool registry, but there is no durable tenant registry. |
| Human review and incident response | Not implemented | Overrides are not persisted; approval, denial, revocation, escalation, and notification workflows remain. |
| Semantic quality evidence | Not established | The generated dataset validates plumbing only; it is not a reviewed accuracy benchmark. |
| Production operations | Not implemented | Metrics, traces, retention, backup/restore validation, key rotation, and a security review remain. |

**Production readiness: no.** The current release is suitable for development, sandbox evaluation, and guarded prototypes. The P0 items in the remaining-work section are required before recommending real high-impact multi-tenant use.

## Why use ActionGate instead of calling Jev directly?

| Capability | Direct Jev call | ActionGate target |
| --- | --- | --- |
| Semantic intent and scope evidence | Yes | Uses Jev as one evidence source |
| Deterministic RBAC, limits, allowlists, duplicate checks | Application must build it | Versioned policy layer |
| Exact binding to tenant, agent, tool, operation, arguments, risk, and policy | Application must build it | Cryptographic action fingerprint |
| Expiring, single-use authorization permit | No | Action Grant |
| Replay and mutation resistance | Application must build it | Atomic grant consumption |
| Shadow rollout and enforcement modes | Application must build it | First-class workflow |
| Human review and approval | Application must build it | Review queue and approval grants |
| Immutable audit history and redaction | Application must build it | Built-in and tenant-scoped |
| Provider fallback and calibration | Application must build it | Provider-independent control plane |
| SDK and gateway enforcement | No | Integrations at the side-effect boundary |

ActionGate is not valuable if it remains a nicer prompt wrapper. It becomes valuable when tool credentials or the tool endpoint require an Action Grant, making bypass materially harder and policy centrally operable.

## Moat being built

The capabilities below describe the intended durable advantage. Completed and remaining work is tracked explicitly in the delivery plan.

### 1. Enforcement moat

- Signed, expiring, single-use Action Grants.
- Grants bound to the exact tenant, environment, agent, tool, operation, arguments, risk class, policy version, and decision.
- Atomic replay prevention and explicit revocation.
- Gateway or credential-broker integrations that make a permit mandatory, not advisory.

### 2. Policy moat

- Server-owned tool and operation registry; callers cannot self-declare a safer risk class.
- Deterministic hard rules execute before semantic evaluation.
- Immutable, testable policy versions with linting and safe rollout.
- Resource-aware rules, spend limits, rate limits, and separation of duties.

### 3. Workflow moat

- Shadow, monitor, and enforce rollouts.
- Review queues with expiry, approver identity, evidence, and escalation.
- Approved actions receive a new exact-action grant; decisions are never silently rewritten.
- Incident response: revoke grants, disable operations, and preserve evidence.

### 4. Integration moat

- TypeScript and Python SDKs that authorize and consume at the execution boundary.
- MCP gateway and framework adapters.
- HTTP reverse proxy for tools that cannot embed an SDK.
- Credential brokering so downstream credentials are unavailable without a valid grant.

### 5. Evidence and data moat

- Outcome-linked audit trails: proposed, authorized, consumed, executed, failed, reversed.
- Tenant-specific calibration by risk class.
- Review corrections become regression cases, not opaque training data.
- Public benchmark methodology with adversarial, semantic, reliability, latency, and cost suites kept separate.

### 6. Trust and operations moat

- Secret redaction and configurable data minimization before provider calls.
- Signed receipts, tamper-evident audit exports, retention controls, and regional deployment.
- Provider-independent evidence interfaces and fail-safe behavior.
- Cost, latency, drift, and false-allow monitoring by policy and risk class.

## Current reality

The prototype now has deterministic prechecks, a typed Jev evidence battery, immutable in-process policies, shadow mode, sanitized audit records, signed Action Grants, optional Redis-backed cross-instance idempotency and replay protection, an SDK guarded executor, and an embeddable MCP tool gateway. PostgreSQL schemas and migrations exist, but the API runtime is not wired to PostgreSQL repositories.

It is not yet a production authorization plane:

- memory remains the zero-dependency development default, while production startup requires shared Redis storage;
- Redis state is durable only to the degree that the deployment configures persistence, replication, backups, authentication, and TLS;
- the current Redis adapter retains records indefinitely; tenant retention and deletion controls remain required;
- one static bearer key protects every route, and tenant identity still comes from request bodies or query parameters rather than authenticated key context;
- policy mutation, decision reads, and overrides do not yet have tenant-scoped roles;
- policies and overrides are process-local; the current override endpoint returns a record but does not persist it;
- code with direct access to downstream credentials can bypass the SDK wrapper;
- the embeddable MCP gateway derives tool metadata from its local server-owned registry, but direct API callers still submit tool identity and risk class; a durable authenticated registry is needed;
- review, approval, and grant revocation are not durable workflows;
- signing grants uses one secret without key IDs or an overlapping rotation window;
- the existing generated evaluation dataset validates metric plumbing more than real semantic quality;
- the embeddable gateway protects registered handlers, but a standalone authenticated network proxy and credential broker are not implemented.

These limitations should stay visible until the corresponding acceptance criteria pass.

## Delivery plan

### Phase 1 — exact-action enforcement foundation

- [x] Add signed Action Grants with a versioned token format and key separation.
- [x] Include risk class in the canonical action fingerprint.
- [x] Issue grants only for `ALLOW` decisions in `enforce` mode.
- [x] Bind grants to the exact action, policy version, tenant, environment, and actor.
- [x] Add an authenticated consume endpoint with atomic one-time use.
- [x] Reject mutated, tampered, expired, unknown, and replayed grants.
- [x] Keep raw grant tokens out of decision-list and decision-detail APIs.
- [x] Update the TypeScript SDK to consume before executing.
- [x] Add adversarial tests and an enforcement-property benchmark.
- [x] Document what grants do and do not protect without a gateway.

Exit criteria:

- [x] Zero grants for `BLOCK`, `REVIEW`, or shadow-mode outcomes.
- [x] Zero accepted requests after changing any bound action field.
- [x] Zero accepted signature mutations.
- [x] Zero successful replays.
- [x] SDK never executes if authorization or consumption fails.
- [x] Audit APIs never return a raw grant token.

### Phase 2 — durable control plane

- [x] Redis-backed decisions, idempotency leases, grant records, and atomic cross-instance consumption.
- [x] Preserve decision and consumption state across API restarts.
- [x] Fail production startup when configured with process-local storage.
- [ ] Wire PostgreSQL repositories into the API for decisions, policies, reviews, overrides, and long-term audit reporting.
- [x] Store only token hashes and non-secret grant claims.
- [ ] Encrypt sensitive evidence fields.
- [x] Redis transaction for cross-instance grant consumption and idempotency.
- [ ] Tenant-scoped API key hashes, roles, rotation, revocation, and last-used metadata.
- [ ] Grant-signing key rotation with key IDs and overlapping verification windows.
- [ ] Retention, deletion, and audit-export controls.

Exit criteria:

- [x] Concurrent grant consumption across multiple API instances produces exactly one success.
- [x] Redis-backed API restart does not lose decisions, grants, consumption markers, or idempotency state.
- [ ] Policies, reviews, overrides, and long-term audit records survive restart.
- [ ] Authenticated tenant context—not caller input—scopes every read, write, and grant operation.
- [ ] Cross-tenant reads, policy mutations, overrides, and consumes fail closed in integration tests.

### Phase 3 — server-owned policy and tool registry

- [x] Provide a server-owned registry inside the embeddable MCP gateway.
- [x] Normalize and validate MCP arguments before authorization and execution.
- [ ] Register tools, operations, JSON Schemas, owners, risk classes, and data sensitivity in a durable tenant-scoped control plane.
- [ ] Make the authorization API derive tool metadata from that registry instead of trusting caller-supplied risk.
- [ ] Reject unknown tools, invalid arguments, and downgrade attempts consistently across REST, SDK, MCP, and proxy integrations.
- [ ] Policy linter for contradictory rules, missing defaults, unreachable branches, and unsafe fail-open behavior.
- [ ] Policy simulation against historical sanitized traffic before activation.
- [ ] Signed policy bundles and controlled promotion across environments.

### Phase 4 — review and approval

- [ ] Durable review queue with assignee, reason, evidence, SLA, and expiry.
- [ ] Approval and denial endpoints with authenticated reviewer identity.
- [ ] Revalidate current policy and exact action before issuing an approval grant.
- [ ] Require two-person approval for configurable high-impact operations.
- [ ] Notifications and webhook delivery with signed payloads and retries.
- [ ] Persist overrides as immutable audit events rather than returning process-local acknowledgements.
- [ ] Revoke unconsumed grants and disable affected tools during incident response.

### Phase 5 — enforcement integrations

- [x] TypeScript client and guarded tool executor.
- [x] Embeddable MCP authorization gateway that consumes a grant before invoking the tool handler.
- [ ] Standalone MCP network proxy with transport authentication and deployment templates.
- [ ] HTTP tool proxy and sidecar mode.
- [ ] Credential broker issuing narrow, short-lived downstream credentials.
- [ ] Publish versioned SDK and MCP gateway packages with semantic-versioning and migration guidance.
- [ ] Python SDK and framework adapters.
- [ ] Reference deployments demonstrating that direct tool access is unavailable.

### Phase 6 — evidence quality and adaptive operations

- [ ] Version semantic batteries independently from policies.
- [ ] Calibrate thresholds per risk class using reviewed production outcomes.
- [ ] Detect provider/model drift before promotion.
- [ ] Privacy-preserving regression corpus built from operator-approved examples.
- [ ] Explain which deterministic rule or semantic signal changed an outcome.

### Phase 7 — production operations and trust

- [ ] Emit tenant-safe metrics and traces for decisions, provider calls, Redis operations, grants, reviews, latency, and cost.
- [ ] Define service-level objectives and alerts for authorization availability, unsafe allows, review volume, provider errors, and replay attempts.
- [ ] Add per-tenant quotas and rate limits rather than one process-wide limit.
- [ ] Validate Redis backup, restore, replication, and failover procedures.
- [ ] Add automated secret scanning, container scanning, an SBOM, release provenance, and signed release artifacts.
- [ ] Perform an external security review and remediate findings before a production-ready claim.
- [ ] Publish deployment and incident-response runbooks.

## Benchmark specification

No single accuracy number is sufficient. Publish separate suites and never merge them into a marketing score.

### A. Enforcement security suite

For every issued grant, attempt:

- replay;
- signature mutation;
- expiry;
- tenant, environment, agent, tool, operation, arguments, and risk-class mutation;
- consumption of a shadow, blocked, or reviewed decision;
- cross-tenant and cross-policy use;
- concurrent double consumption.

Primary metric: **unauthorized acceptances**. Release gate: `0`.

### B. Semantic safety suite

Maintain human-reviewed cases stratified by risk class and difficulty. Report:

- unsafe-allow rate, with a target of zero on critical cases;
- auto-allow precision;
- safe-task auto-allow coverage;
- review rate and block rate;
- confusion matrix per risk class;
- bootstrap confidence intervals;
- model, policy, prompt/battery version, and dataset revision.

Do not describe label replay or fixture validation as model accuracy.

### C. Reliability suite

- provider timeout, malformed output, unavailable provider, and partial response;
- idempotency conflicts and concurrent identical requests;
- database and replay-store interruption;
- signing-key rotation and process restart;
- audit redaction and tenant isolation.

### D. Performance and cost suite

Measure separately:

- deterministic short-circuit latency;
- semantic-provider latency;
- grant issue and consume latency;
- end-to-end hosted latency at realistic concurrency;
- input/output tokens and provider cost by decision and risk class.

Local in-process numbers are regression baselines, not production throughput claims.

## Decision rules for future work

Prioritize a feature when it does at least one of the following:

1. makes bypass harder at the actual side-effect boundary;
2. improves false-allow safety or useful auto-allow coverage with measured evidence;
3. reduces integration effort without weakening enforcement;
4. creates durable operational data customers cannot get from a direct model call;
5. makes policies, reviews, or incidents safer to operate at scale.

Deprioritize generic dashboards, model-provider breadth, and decorative integrations until the enforcement and durable-state milestones are complete.

## Priority-ordered work remaining

### P0 — required before real multi-tenant use

1. **Tenant-bound authentication and authorization**
   - hash and scope API keys to tenant, environment, and role;
   - derive tenant context from the authenticated key;
   - remove caller-selected tenant access from decision-list and decision-detail routes;
   - authorize policy writes, overrides, reviews, and grant consumption by role;
   - prove cross-tenant denial in API, Redis, SDK, and gateway integration tests.
2. **Durable server-owned tool and policy registry**
   - store tool identity, operation, schema, owner, risk, and data sensitivity per tenant;
   - validate arguments before semantic evaluation;
   - derive risk and policy from the registry on every integration path;
   - reject unknown tools and all caller downgrade attempts.
3. **Key lifecycle and incident response**
   - add signing-key IDs and overlapping rotation windows;
   - revoke individual grants, keys, tools, and operations;
   - preserve immutable incident evidence.
4. **Durable administrative state and data governance**
   - wire PostgreSQL repositories for policies, reviews, overrides, and long-term audits;
   - add encryption for sensitive evidence;
   - implement retention, deletion, export, backup, and restore controls.

### P1 — make bypass materially harder

1. Ship the MCP gateway as an authenticated network service.
2. Add an HTTP proxy/sidecar and credential broker.
3. Publish a reference deployment where the guarded boundary is the only path to the tool credential.
4. Implement durable review, approval, expiry, escalation, and two-person workflows.
5. Publish versioned SDK and gateway packages with stable public APIs.

### P2 — prove quality and operate it safely

1. Replace generated evaluation cases with independently reviewed, versioned examples.
2. Run provider-backed calibration by risk class and publish confidence intervals rather than one aggregate score.
3. Add metrics, traces, SLOs, alerts, per-tenant quotas, and drift detection.
4. Test backup, restore, failover, signing-key rotation, and dependency outages.
5. Complete supply-chain hardening and an external security review.

## Recommended next release

Target **v0.2: tenant-safe registry** before adding more providers or decorative integrations. It is complete only when:

- an API key resolves exactly one tenant, environment scope, and role set;
- tenant IDs supplied by callers cannot expand access;
- every action references a durable registered tool and server-owned risk class;
- cross-tenant decision reads, policy writes, overrides, and grant consumption fail closed;
- policies and overrides survive restart;
- CI includes the tenant-isolation and risk-downgrade test matrix.
