# ActionGate roadmap

ActionGate is developed in public. Work is ordered around making the authorization boundary durable and difficult to bypass before adding integration breadth.

Last reconciled: **2026-09-19**. ActionGate remains an early public MVP, not a production-ready multi-tenant authorization service.

## Shipped foundation

- [x] Deterministic policy combined with structured Jev semantic evidence
- [x] Shadow and enforce modes with named, auditable reasons
- [x] Signed, expiring grants bound to the exact tenant, actor, tool, operation, arguments, risk class, and policy
- [x] Mutation, expiry, unknown-grant, and replay rejection
- [x] TypeScript client and guarded tool executor
- [x] Redis-backed decisions, distributed idempotency leases, and atomic cross-instance grant consumption
- [x] Restart and cross-replica enforcement tests
- [x] Embeddable MCP gateway with server-owned tool metadata and consume-before-execute ordering
- [x] Sanitized decision records, provider token/cost reporting, public security policy, CI, and security scanning

## P0 — tenant-safe control plane

These items block a production-ready claim.

- [ ] Replace the single configured bearer key with hashed, scoped, revocable tenant API keys
- [ ] Derive tenant and role context from authentication instead of request bodies or query parameters
- [ ] Add cross-tenant denial tests for decisions, grants, policies, and overrides
- [ ] Build a durable tenant tool registry with operation, JSON Schema, owner, risk class, and data sensitivity
- [ ] Make every authorization path derive tool metadata from the registry and reject risk downgrades
- [ ] Wire PostgreSQL repositories into the API for policies, overrides, reviews, and long-term audit records
- [ ] Add signing-key IDs, overlapping key rotation, revocation, and incident-response controls
- [ ] Add encryption, retention, deletion, and tenant audit-export controls

## P1 — non-bypassable enforcement and review

- [ ] Package the gateway as a standalone MCP network proxy with authenticated transport
- [ ] Add an HTTP tool proxy/sidecar for applications that cannot embed the SDK
- [ ] Add a credential broker for narrow, short-lived downstream credentials
- [ ] Publish a reference deployment where raw handlers and credentials are not directly reachable
- [ ] Implement a durable review queue with authenticated approve/deny actions, expiry, and exact-action revalidation
- [ ] Add configurable two-person approval, signed webhooks, retries, and escalation
- [ ] Persist human overrides as immutable audit events

## P2 — evidence and production operations

- [ ] Replace the generated dataset with versioned, independently reviewed cases and annotator guidance
- [ ] Add provider-backed calibration, threshold sweeps, confidence intervals, and per-risk-class reports
- [ ] Detect semantic-provider drift before model, battery, policy, or threshold promotion
- [ ] Emit tenant-safe metrics and traces for decisions, providers, Redis, grants, reviews, latency, and cost
- [ ] Define service-level objectives and alerts; test Redis backup, restore, replication, and failover
- [ ] Add per-tenant quotas and rate limits
- [ ] Add container scanning, an SBOM, release provenance, signed artifacts, and an external security review

## P3 — developer adoption

- [ ] Publish versioned `@actiongate/sdk` and `@actiongate/mcp-gateway` packages
- [ ] Generate an OpenAPI specification and complete SDK/API reference documentation
- [ ] Add Python, LangChain, and Vercel AI SDK adapters
- [ ] Add more guarded examples for email, coding, CRM, and booking agents
- [ ] Add a hosted sandbox demo and interactive policy simulator
- [ ] Publish deployment, migration, and incident-response runbooks

Community proposals are welcome. Open a feature request with the use case, risk class, desired behavior, and a measurable success criterion.

The detailed strategy, acceptance gates, and implementation checklist are in the [product plan](PLANNING.md).
