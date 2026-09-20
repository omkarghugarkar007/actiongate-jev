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
- HTTP reverse proxy and sidecar with declarative route-to-tool mapping and a `sidecar` preset
- Credential broker: `POST /v1/grants/exchange` plus `verifySignedRequest` for downstream verification
- Execution outcomes recorded separately from authorization, and a review queue with claim, escalation, revalidation at approval, a fresh approval grant, and two-person approval
- Bulk incident tool disablement and outstanding-grant revocation
- Signed notification webhooks with a replay window, bounded retries, destination allowlisting, and dead letters
- A reference deployment where the guarded proxy is the only reachable service, with a topology test
- Versioned publishable packages, a generated OpenAPI 3.1 description, a generated typed client, validated connector manifests, and one-screen quickstarts
- Dataset label provenance, provider-backed calibration with confidence intervals, per-tool false-block reporting, and a drift gate that blocks promotion on any increase in unsafe allows
- Tenant-safe Prometheus metrics with hashed tenant labels, per-tenant rate limits and provider-cost budgets, and an OTLP exporter
- Hash-chained, signed audit exports, a dependency-loss and restore drill, SLOs and alerts, a CycloneDX SBOM, and a release workflow with image scanning and build provenance
- Runbooks for deployment, migration, key rotation, retention, restore, and incidents
- Python SDK, adapter conformance suite, generated connector catalog, framework and webhook adapters, six guarded examples, secret resolution, and a non-persisting policy simulator
- Trusted fact providers: a server-side interface plus function and HTTP adapters that resolve deterministic facts ActionGate can vouch for
- Fact provenance and freshness in decision evidence, with mandatory trusted evidence for hard rules and optional `maxFactAgeSeconds`

### Changed

- Canonical action fingerprints now bind risk class plus optional user and session identity
- The default evaluation command reports dataset integrity only and no longer presents label replay as accuracy
- Every registered tool schema must be a closed top-level object; default schemas also constrain identifiers, amounts, email recipients, and body lengths

### Security

- Raw Action Grant tokens are excluded from decision audit APIs
- Production startup rejects the development grant-signing secret
- Enforced SDK calls fail closed when a grant is missing or consumption fails
- Production refuses process-local storage, and Redis repository failures fail closed
- The MCP gateway derives tool operation and risk from its server-owned registry before executing
- **Hard rules are now satisfied affirmatively rather than by silence.** A configured rule whose deterministic fact was absent used to pass: omitting `deterministicFacts` entirely returned `ALLOW` with a grant for a `FINANCIAL` tool carrying `requireAuthenticatedUser`, `requireRbac`, and `denyDuplicate`. A control that cannot be evaluated now blocks, with `AUTH_FACT_MISSING`, `RBAC_FACT_MISSING`, `DUPLICATE_FACT_MISSING`, `AMOUNT_FACT_MISSING`, `CURRENCY_FACT_MISSING`, and `DESTINATION_FACT_MISSING` distinguishing an unverifiable control from an explicit denial
- The MCP proxy refuses methods it does not handle instead of forwarding them, and strips `_meta` so a model cannot smuggle a grant upstream
- Caller-supplied `deterministicFacts` can no longer satisfy any fact-backed hard rule, regardless of the legacy `requireTrustedFacts` setting, closing the remaining "agent vouches for its own RBAC" path; a trusted fact resolved longer ago than `maxFactAgeSeconds` is rejected as stale
- Trusted facts override contradicting caller claims, and a fact provider that fails contributes nothing, so the rule it would have satisfied fails closed
- The release workflow pins the known-safe immutable Trivy action commit, and database seeding writes a one-time bootstrap key to a gitignored mode-0600 file instead of terminal logs

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
