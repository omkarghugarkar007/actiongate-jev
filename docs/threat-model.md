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
| Grant replay | Atomic one-time consumption; Redis mode covers all connected instances | Memory mode covers one process; Redis durability depends on deployment configuration |
| Stolen grant | Short expiry and exact-action binding | A thief with identical context can race the legitimate consumer until durable identity-bound transport is added |
| Duplicate side effect | Idempotency key plus canonical action fingerprint and one-time grant | Consumption is at-most-once authorization, not exactly-once downstream execution |
| Secret leakage in logs | Fastify path redaction and recursive audit redaction | Custom unknown secret field names require policy paths |
| Provider timeout/malformed response | Strict validation and risk-aware failure decision | Availability can increase review/block volume |
| API-key theft | Server-only secrets, redacted logs, planned hash/revocation schema | Local MVP uses one configured development key |
| Agent bypasses ActionGate | SDK guarded executor or MCP gateway consumes before execution | Any separately exposed raw handler or downstream credential can bypass the boundary |
| Cross-instance idempotency race | Redis lease plus first-write-wins decision transaction | A lease configured shorter than provider execution can permit duplicate evaluation |
| Redis loss or compromise | Fail-closed repository errors, token hashes instead of tokens, recommended persistence and isolation | Lost state blocks valid grants; write access can disrupt availability and audit evidence |
| Unbounded retained state | Records are namespaced and contain sanitized requests; retention work is explicit in the roadmap | The current Redis adapter does not expire decision or grant records |
| Policy tampering | New immutable versions; version recorded per decision | Production needs access control and durable checksums |
| Human override abuse | Overrides become explicit labels | Production needs authenticated operator identity |

## Deployment requirements

Before real high-impact enforcement, implement durable tenant isolation, hashed/revocable API keys, signing-key rotation, authorization on policy/override routes, configurable secret paths, telemetry alerts, retention controls, and a security review. Operate Redis with authentication, TLS, persistence, replication, backups, and private networking. Keep tool credentials out of the dashboard and expose tools only through the guarded gateway or a future credential broker when ActionGate must be non-bypassable.
