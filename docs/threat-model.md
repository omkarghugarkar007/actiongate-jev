# Threat model

ActionGate authorizes proposed actions; it does not make an unsafe network topology safe by itself. The most important deployment property is that the guarded executor is the only route to the downstream handler or credential.

## Assets

Protected assets include tenant identity, API keys, signing and encryption keys, tool credentials, customer records, funds, destructive operations, outbound communications, policies, the tool registry, Action Grants, review decisions, corrections, and audit evidence.

## Trust boundaries

- Agent-generated arguments, user or retrieved text, request tenant fields, requested operation/risk, and model-visible state are untrusted.
- Authenticated tenant/environment/roles, the durable tool registry, immutable policy version, trusted fact adapters, secret manager, Redis, PostgreSQL, and guarded executor are trusted only within their deployment boundary.
- The semantic provider is an external evidence processor. It never has authority to issue or consume a grant.
- Administrator and reviewer credentials are powerful principals and require operational protection outside this repository.

## Principal threats and controls

| Threat | Implemented control | Residual risk or required deployment control |
|---|---|---|
| Caller selects another tenant or environment | Slow-hashed API key derives tenant, environment, and roles; mismatches fail before evaluation | A stolen key retains its scoped authority until revocation |
| Caller declares a safer operation or risk | Tenant registry owns operation, schema, risk, owner, sensitivity, and policy; mismatch and unknown tools fail closed | Registry administrators can misconfigure metadata |
| Invalid or adversarial arguments | Registered JSON Schema is validated at registration and before evaluation | Business invariants still need deterministic rules and trusted resource lookup |
| Caller fabricates or omits RBAC or resource facts | Hard rules take precedence over semantic evidence, and a configured rule whose fact is absent blocks rather than passing | Facts still enter through the integration contract; deployments must populate them from trusted server-side adapters. The MCP proxy asserts no facts of its own, so tools with hard rules fail closed there until a fact provider is configured |
| Prompt injection or misleading retrieved text | Minimal structured state, fixed narrow questions, strict response validation, and uncertainty review | A decision model can still misclassify; representative calibration remains necessary |
| Model score overrides a hard failure | Fixed precedence makes authentication, RBAC, schema, limit, duplicate, and dependency failures authoritative, and an unevaluable control counts as a failure | New rule types must preserve this invariant and must treat an absent fact as unsatisfied, never as satisfied |
| Decision reused for another action | Signed fingerprint binds tenant, environment, actor, tool, operation, canonical arguments, risk, policy, and decision | The downstream system must be reachable only through the guarded path |
| Grant replay or concurrent double use | Atomic Redis consumption; exactly one connected replica succeeds | Redis compromise or loss can disrupt availability; consumption is not exactly-once business execution |
| Grant is stolen | Short expiry, exact-action binding, tenant-scoped consumption, and explicit revocation | A thief with the same API authority and exact context can race until sender-constrained transport is added |
| Signing key is rotated | Versioned key IDs allow an active signing key and overlapping verification keys | Operators must remove retired keys and protect key material in a secret manager |
| API key leaks | Plaintext shown once, `scrypt` storage, non-secret prefix lookup, role/environment scope, last-used metadata, immediate revocation | Bearer keys are not sender-constrained; use TLS, narrow roles, short operational rotation, and secret storage |
| Secret or grant leaks into logs/audit | HTTP log redaction, recursive evidence redaction, no raw grant storage, encrypted Redis/PostgreSQL evidence | Unknown custom secret field names require upstream minimization or added redaction rules |
| Evidence disclosure at rest | AES-256-GCM envelopes use a key ID and context-bound authenticated encryption | Memory, logs, exports, database metadata, and key-management systems remain separate attack surfaces |
| Cross-tenant data access | Tenant-qualified Redis keys/indices, tenant-qualified SQL, role gates, and denial tests | Database superusers and shared infrastructure administrators remain privileged |
| Idempotency race or mutation | Canonical fingerprint, distributed lease, first-write-wins record, and conflict response | A lease shorter than provider execution can duplicate evaluation; startup validates lease exceeds configured timeout |
| Provider timeout, malformed response, or outage | Strict validation and risk-aware fail-safe outcome | Availability failures increase review/block volume |
| Grant or key must be stopped during an incident | Shared-state grant revocation, API-key revocation, and tool disablement | Already completed downstream side effects require domain-specific reversal |
| Excessive data retention | Tenant-scoped export and cutoff-based minimization/deletion | Retention scheduling, legal policy, backups, and replicas are deployment responsibilities |
| Audit tampering | Append-oriented event model, actor key IDs, encrypted payloads, and tenant export | A PostgreSQL writer can alter history; signed/tamper-evident exports are not implemented yet |
| Reviewer abuse | Authenticated reviewer role, durable identity, expiry, and immutable audit events | Two-person approval, escalation, and fresh approval grants remain P1 |
| Agent bypasses ActionGate | SDK wrapper and MCP gateway consume before calling private handlers; the standalone MCP proxy owns the upstream credential and consumes before forwarding | Any separately exposed handler or credential still bypasses enforcement. The proxy only isolates when the upstream MCP endpoint is not routable from the agent; an HTTP reverse proxy and credential broker remain |

## Production configuration guardrails

Production startup rejects:

- process-local runtime state instead of Redis;
- an in-memory control plane instead of PostgreSQL;
- a legacy static API key;
- missing signing key ring or active signing key ID;
- missing evidence-encryption key ring or active encryption key ID;
- an idempotency lease that does not exceed the provider timeout;
- a provider configuration without its required server-side credential.

These checks prevent known unsafe defaults, but they do not configure infrastructure security.

## Deployment requirements

Before high-impact use:

1. keep downstream handlers and credentials private to the guarded executor, proxy, or credential broker;
2. derive deterministic facts from authenticated systems rather than agent-controlled payloads;
3. terminate TLS and isolate the API, Redis, and PostgreSQL on private networks;
4. enable Redis/PostgreSQL authentication, encryption, persistence, replication, backups, monitoring, and tested restore/failover;
5. store signing, encryption, provider, and tenant bootstrap secrets in a managed secret system and document rotation/retirement;
6. assign narrow API roles and separate runtime keys from administrative/reviewer keys;
7. configure retention and protect audit exports as sensitive tenant data;
8. add service telemetry, quotas, alerts, incident runbooks, and dependency-loss tests;
9. calibrate semantic thresholds on independently reviewed, representative cases;
10. complete supply-chain hardening and an external security review.

See [architecture.md](architecture.md) for the trust flow and [PLANNING.md](PLANNING.md) for remaining work.
