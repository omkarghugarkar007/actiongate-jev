# Changelog

All notable changes to ActionGate will be documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use semantic versioning after the first stable release.

## [Unreleased]

### Added

- Signed, short-lived Action Grants for enforced `ALLOW` decisions
- Authenticated one-time grant consumption with replay, expiry, mutation, and unknown-token rejection
- SDK guarded execution that consumes a grant immediately before invoking a tool
- PostgreSQL Action Grant schema and migration using token hashes rather than raw tokens
- Living product plan, enforcement architecture diagram, and grant lifecycle documentation
- Redis-backed decisions, distributed idempotency leases, and atomic cross-instance grant consumption
- Embeddable MCP gateway with combined authorize-and-call and split metadata-grant flows
- Cross-instance restart, race, mutation, replay, and gateway integration tests
- Standalone MCP network proxy that authenticates the caller, owns the upstream credential, and consumes a grant before forwarding
- Live OpenRouter gates covering the authorize/grant/consume path and the MCP proxy chain

### Changed

- Canonical action fingerprints now bind risk class plus optional user and session identity
- The default evaluation command reports dataset integrity only and no longer presents label replay as accuracy

### Security

- Raw Action Grant tokens are excluded from decision audit APIs
- Production startup rejects the development grant-signing secret
- Enforced SDK calls fail closed when a grant is missing or consumption fails
- Production refuses process-local storage, and Redis repository failures fail closed
- The MCP gateway derives tool operation and risk from its server-owned registry before executing
- **Hard rules are now satisfied affirmatively rather than by silence.** A configured rule whose deterministic fact was absent used to pass: omitting `deterministicFacts` entirely returned `ALLOW` with a grant for a `FINANCIAL` tool carrying `requireAuthenticatedUser`, `requireRbac`, and `denyDuplicate`. A control that cannot be evaluated now blocks, with `AUTH_FACT_MISSING`, `RBAC_FACT_MISSING`, `DUPLICATE_FACT_MISSING`, `AMOUNT_FACT_MISSING`, `CURRENCY_FACT_MISSING`, and `DESTINATION_FACT_MISSING` distinguishing an unverifiable control from an explicit denial
- The MCP proxy refuses methods it does not handle instead of forwarding them, and strips `_meta` so a model cannot smuggle a grant upstream

## [0.1.0] - 2026-09-19

### Added

- Runtime `ALLOW`, `REVIEW`, and `BLOCK` authorization engine
- TypeSafe Jev 1.13 integration through OpenRouter's Decisions API
- Six-signal semantic decision battery with deterministic composition
- Shadow Mode, idempotency, audit redaction, and provider cost tracking
- Fastify API, TypeScript SDK, Next.js dashboard, and refund sandbox
- PostgreSQL schema/migration, Redis/Docker infrastructure, CI, and evaluation tooling
- Unit, contract, integration, browser, live-provider, adversarial, and load-test paths

### Security

- Server-owned risk classes and hard-rule precedence
- Risk-aware fail-safe behavior for provider errors
- Strict provider response validation and secret redaction

[Unreleased]: https://github.com/omkarghugarkar007/actiongate-jev/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/omkarghugarkar007/actiongate-jev/releases/tag/v0.1.0
