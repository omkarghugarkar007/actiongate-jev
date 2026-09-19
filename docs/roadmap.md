# ActionGate roadmap

ActionGate is developed in public. Priorities are ordered around establishing a reliable authorization boundary before adding breadth.

## Now — durable MVP

- [x] Signed, expiring, exact-action grants
- [x] Single-process atomic consumption and SDK enforcement
- [ ] PostgreSQL-backed audit and policy repositories
- [ ] PostgreSQL-backed grants with cross-instance atomic consumption
- [ ] Signing-key IDs, rotation, and grant revocation
- [ ] Redis distributed idempotency locks
- [ ] Hashed, scoped, revocable tenant API keys
- [ ] Persistent human overrides and labeled eval export
- [ ] OpenTelemetry traces and Prometheus-compatible metrics
- [ ] Publish `@actiongate/sdk` to npm

## Next — developer adoption

- [ ] Framework adapters for LangChain, Vercel AI SDK, and MCP
- [ ] Additional email and coding-agent examples
- [ ] Policy simulator against historical decisions
- [ ] Provider-backed calibration runner and threshold sweeps
- [ ] Hosted demo and interactive policy playground
- [ ] Generated OpenAPI specification and SDK documentation

## Later — stronger enforcement

- [ ] Credential broker and execution proxy
- [ ] MCP tool gateway
- [ ] Organization policy inheritance and approver roles
- [ ] Additional separately calibrated semantic providers

Community proposals are welcome. Open a feature request with the use case, risk class, desired behavior, and how success should be evaluated.

The detailed strategy, acceptance gates, and living checklist are in the [product plan](PLANNING.md).
