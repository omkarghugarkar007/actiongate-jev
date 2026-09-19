# Architecture

ActionGate is a decision service, not an execution proxy. The caller provides user intent, a proposed tool call, narrowly selected context, and deterministic facts. The API validates the envelope, verifies the server-owned tool policy, applies hard rules, asks the configured `DecisionProvider` one batch of narrow semantic questions, and composes a final outcome with fixed precedence.

```text
SDK → API auth → schema → idempotency → policy → deterministic rules
                                                  │
                                                  ├─ hard BLOCK
                                                  ▼
                                         minimal state builder
                                                  ▼
                                     DecisionProvider (Jev/fake)
                                                  ▼
                                     deterministic composition
                                                  ▼
                                  sanitized append-only audit event
```

Precedence is: hard deterministic block, critical semantic-hazard block, deterministic review, semantic uncertainty review, then allow. Shadow mode changes only the operational result; `wouldHaveDecision` retains the composed enforcement result.

## Seams

- `DecisionProvider` isolates OpenRouter's alpha Decisions API from core authorization logic.
- `DecisionRepository` isolates audit/idempotency storage.
- immutable policy documents select a risk-specific threshold profile.
- state builders whitelist relevant resources rather than serializing arbitrary application context.
- tool execution remains outside the service.

The next production step is a PostgreSQL-backed audit repository plus Redis lock adapter implementing `SET NX` around the same canonical fingerprint. A later execution proxy can require a signed, expiring grant bound to the decision fingerprint.

