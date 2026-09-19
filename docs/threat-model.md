# Threat model

## Assets

Protected assets include tool credentials, customer records, funds, destructive operations, outbound communications, policies, API keys, audit evidence, and human override labels.

## Trust boundaries

Agent-generated tool arguments and all user/retrieved text are untrusted. The ActionGate server, immutable policy version, tool registry, deterministic fact providers, secret store, and audit database are trusted only within their deployment boundary. OpenRouter and TypeSafe are external processors for the minimal semantic state sent to Jev.

## Principal threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Agent declares a lower risk | Server compares request against policy-owned risk | Registry mistakes remain possible |
| Prompt injection in state | Structured/minimal state, fixed questions, hard rules, uncertainty review | Semantic model can still misclassify |
| Duplicate side effect | Idempotency key plus canonical action fingerprint | Durable distributed locking is not in the in-memory adapter |
| Secret leakage in logs | Fastify path redaction and recursive audit redaction | Custom unknown secret field names require policy paths |
| Provider timeout/malformed response | Strict validation and risk-aware failure decision | Availability can increase review/block volume |
| API-key theft | Server-only secrets, redacted logs, planned hash/revocation schema | Local MVP uses one configured development key |
| Agent bypasses ActionGate | Future credential broker/execution proxy | Current SDK integration is advisory |
| Policy tampering | New immutable versions; version recorded per decision | Production needs access control and durable checksums |
| Human override abuse | Overrides become explicit labels | Production needs authenticated operator identity |

## Deployment requirements

Before real high-impact enforcement, implement durable tenant isolation, hashed/revocable API keys, Postgres audit writes, Redis concurrency locks, authorization on policy/override routes, configurable secret paths, OpenTelemetry alerts, retention controls, and a security review. Keep tool credentials out of the dashboard and prefer an execution proxy when ActionGate must be an actual enforcement boundary.

