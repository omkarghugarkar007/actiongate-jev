# Threat model

## Assets

Protected assets include tool credentials, customer records, funds, destructive operations, outbound communications, policies, API keys, Action Grants, audit evidence, and human override labels.

## Trust boundaries

Agent-generated tool arguments and all user/retrieved text are untrusted. The ActionGate server, immutable policy version, tool registry, deterministic fact providers, secret store, and audit database are trusted only within their deployment boundary. OpenRouter and TypeSafe are external processors for the minimal semantic state sent to Jev.

## Principal threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Agent declares a lower risk | Server compares request against policy-owned risk | Registry mistakes remain possible |
| Prompt injection in state | Structured/minimal state, fixed questions, hard rules, uncertainty review | Semantic model can still misclassify |
| Decision reused for different inputs | Grant signature and fingerprint bind tenant, environment, agent, user/session, tool, operation, arguments, risk, and policy | The downstream tool must require the guarded path |
| Grant replay | Atomic one-time consumption; replay returns a conflict | In-memory atomicity covers one process only |
| Stolen grant | Short expiry and exact-action binding | A thief with identical context can race the legitimate consumer until durable identity-bound transport is added |
| Duplicate side effect | Idempotency key plus canonical action fingerprint and one-time grant | Consumption is at-most-once authorization, not exactly-once downstream execution |
| Secret leakage in logs | Fastify path redaction and recursive audit redaction | Custom unknown secret field names require policy paths |
| Provider timeout/malformed response | Strict validation and risk-aware failure decision | Availability can increase review/block volume |
| API-key theft | Server-only secrets, redacted logs, planned hash/revocation schema | Local MVP uses one configured development key |
| Agent bypasses ActionGate | SDK guarded executor consumes before execution | Code with direct downstream credentials can still bypass the wrapper; gateway or credential broker is required |
| Policy tampering | New immutable versions; version recorded per decision | Production needs access control and durable checksums |
| Human override abuse | Overrides become explicit labels | Production needs authenticated operator identity |

## Deployment requirements

Before real high-impact enforcement, implement durable tenant isolation, hashed/revocable API keys, PostgreSQL audit and grant repositories, transactional cross-instance consumption, signing-key rotation, authorization on policy/override routes, configurable secret paths, telemetry alerts, retention controls, and a security review. Keep tool credentials out of the dashboard and require a gateway or credential broker when ActionGate must be a non-bypassable boundary.
