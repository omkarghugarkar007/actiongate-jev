# Architecture

ActionGate is a provider-independent authorization and enforcement plane for specialized decision models. Jev is the first semantic evidence provider; deterministic code remains the authority.

![ActionGate platform architecture](assets/platform-architecture.svg)

The architecture separates four concerns:

1. **Integration surface** — SDK, MCP, HTTP, and workflow adapters normalize proposed actions into one authorization contract.
2. **Decision and control boundary** — authenticated identity, server-owned tool metadata, deterministic rules, and decision-model evidence produce `ALLOW`, `REVIEW`, or `BLOCK`.
3. **Guarded execution boundary** — a signed, exact-action grant is consumed once before a handler can use its downstream credential.
4. **Durable state and feedback** — runtime coordination, control-plane records, encrypted audit evidence, and human corrections survive process restarts.

The central rule is: **Jev supplies evidence; ActionGate creates and enforces the permit.**

## Authorization lifecycle

```text
application
    │ proposed action + intent (caller fact claims stay untrusted)
    ▼
tenant authentication ──► roles, environment, tenant
    ▼
server-owned registry ──► operation, schema, risk, owner, sensitivity, policy
    ▼
trusted fact providers ──► authentication, RBAC, resource, amount, duplicate, allowlist
    ▼
argument validation + deterministic rules + idempotency
    │ hard failure stops here
    ▼
minimal semantic state ──► decision-model evidence
    ▼
fixed-precedence composition ──► ALLOW / REVIEW / BLOCK
    │
    ├─ review or block: no grant
    └─ enforced allow: signed, expiring, exact-action grant
                               │
                               ▼
                    atomic consume or revoke
                               │
                               ▼
                       guarded side effect
```

Step by step:

1. The bearer key is verified against a slow hash. Its record supplies the tenant, environment, and roles; request fields cannot select another tenant.
2. The tenant registry resolves the tool. Caller-supplied operation and risk remain in the public contract for explicit binding, but they must exactly match server-owned values.
3. The registered JSON Schema must be a closed top-level object (`additionalProperties: false`) and validates normalized arguments before any semantic-provider request.
4. The registered policy version supplies hard rules, semantic questions, and risk-specific thresholds.
5. Deployment-owned fact providers resolve authentication, RBAC, amount, currency, allowlist, duplicate, and availability evidence. Caller claims cannot satisfy a hard rule; missing, stale, or unavailable evidence blocks.
6. Only a minimal, structured state is sent to the configured `DecisionProvider` for narrow intent, target, conflict, exposure, scope, and missing-intent evidence. The shipped Jev adapters use either TypeSafe's direct System One endpoint or OpenRouter; neither adapter owns authorization policy.
7. Fixed precedence composes the outcome: hard block, critical semantic hazard, deterministic review, semantic uncertainty, then allow. A probability cannot override a failed hard rule.
8. The runtime decision and an encrypted long-term audit event are recorded. Raw API keys and raw grant tokens are never stored in evidence.
9. Only an enforced `ALLOW` receives a signed grant. The grant binds the tenant, environment, actor, tool, operation, canonical arguments, risk, policy version, and decision.
10. The executor presents the same action at consumption time. Signature, key ID, expiry, binding, revocation, and one-time use are checked before execution.

Shadow mode changes the operational response only. It records `wouldHaveDecision` and never creates a grant.

## Control plane and data plane

| Plane | Backing store | Responsibilities |
|---|---|---|
| Runtime data plane | Redis | Decisions, idempotency leases and mappings, grant hashes and claims, atomic consume/revoke, retention minimization index |
| Durable control plane | PostgreSQL | Tenants, slow-hashed API keys, immutable policy versions, tool registry, reviews, corrections, encrypted audit events |
| Development mode | Process memory | Zero-dependency exploration and tests; single-process guarantees only |

Redis scripts provide first-write-wins decisions, distributed idempotency, and exactly one successful grant consumer across connected replicas. PostgreSQL transactions and tenant-qualified queries preserve durable administrative state. `/ready` checks both configured dependencies.

Production configuration fails closed unless Redis and PostgreSQL are enabled and explicit signing and evidence-encryption key rings are present.

## Key and evidence lifecycle

- API keys are random bearer secrets with a searchable non-secret prefix and a slow `scrypt` hash. Plaintext is returned once at issuance.
- API-key records are scoped to one tenant, environment, and role set and include creation, last-use, and revocation metadata.
- Action Grants use a key ID. New grants use the active signing key while previous keys may remain available during an explicit verification overlap.
- Evidence encryption uses independent key IDs and AES-256-GCM with authenticated context binding. New records use the active key while prior keys may decrypt older records during rotation.
- Grant revocation and API-key revocation take effect against shared state without an API restart.
- Tenant export and retention endpoints are role-gated. Retention minimizes old Redis decision detail while preserving the idempotency tombstone, and deletes eligible durable audit, review, and correction payloads.

Secrets belong in a secret manager in deployed environments. Environment variables are the current configuration transport, not the intended long-term secret-management system.

## Integration boundary

An adapter is an enforcement integration only when it consumes the grant immediately before the side effect and the raw handler or downstream credential is unavailable elsewhere.

- The TypeScript wrapper provides a convenient in-process authorize/consume/execute sequence.
- The MCP gateway owns registered tool metadata and invokes private handlers only after consumption.
- Direct REST integration supports any language but leaves handler isolation to the adopter.
- The authenticated MCP proxy and HTTP sidecar own downstream credentials; the credential broker exchanges a consumed grant for a narrow signed request.

See [integrations.md](integrations.md) for the plug-and-play integration strategy.

## Grant lifecycle and failure semantics

1. Enforced authorization stores one grant record after an `ALLOW`.
2. Identical idempotent retries return the original decision and grant; changed payloads conflict.
3. The consumer verifies token version, signing key ID, signature, time window, tenant scope, and exact action fingerprint.
4. The repository atomically transitions the grant from issued to consumed, or from issued to revoked.
5. Mutation, expiry, revocation, unknown grants, and replay fail closed.

This is **at-most-once authorization**, not exactly-once business execution. If a process fails after consumption but before the downstream system commits, the caller must reconcile that system before requesting a fresh authorization.

## Current boundaries

- `deterministicFacts` in a request is untrusted evidence and cannot satisfy a hard rule. A deployment must configure trusted providers for every fact-backed rule it enables; without them, authorization fails closed.
- The standalone authenticated MCP proxy and HTTP sidecar own the downstream credential and consume before forwarding. The credential broker provides the same boundary for downstreams that verify short-lived signed requests. They isolate only when agents cannot route around them.
- Review approval replays the stored sanitized action against the current registry, policy, and trusted facts. It creates a new decision and fresh grant only after revalidation; claim, escalation, distinct-reviewer approval, signed notifications, and dead letters are implemented.
- The local Compose stack does not provide production Redis/PostgreSQL authentication, TLS, replication, backups, or secret management.
- Independently reviewed semantic labels and an external security review remain outstanding. Restore/failover evidence is local reference evidence, not a managed-service availability guarantee.

Read the [threat model](threat-model.md), [product plan](PLANNING.md), and [roadmap](roadmap.md) before deploying high-impact tools.
