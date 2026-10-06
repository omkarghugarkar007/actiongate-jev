# Verification record — October 6, 2026

Verified on Node.js 22.21.1 and pnpm 10.27.0. The baseline includes dependency
PRs #12–#17 and the independently verified security-fix PR #20.
The development-dependency update #18 remains unmerged because TypeScript 7
fails the installed lint tooling. It supersedes #11.

| Check | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck` | Pass |
| `pnpm test` | 316 tests pass |
| `pnpm test:integration` | 74 tests pass |
| `pnpm test:redis` | 2 tests pass against an isolated Redis 8 container |
| `pnpm db:migrate`, `pnpm test:postgres` | Migrations and 1 integration test pass against isolated PostgreSQL 17 |
| `pnpm test:python` | 56 tests pass in an isolated Python test environment |
| `pnpm build` | Pass, including the existing Next.js dashboard |
| `pnpm e2e` | 5 tests pass, including existing UI and desktop/mobile refund-lab scenarios |
| `pnpm build:packages`, `pnpm packages:check` | Pass for all eight published package surfaces |
| Manifests, API/client generation, cross-language conformance | Pass; recorded generated contracts unchanged |
| `pnpm audit --prod`, `pnpm audit` | No known vulnerabilities after `source-map-js` 1.2.2 and `shell-quote` 1.11.0 overrides |
| `pnpm test:nemotron:live` | 3 tests pass against the actual NVIDIA gateway |
| `pnpm test:jev:live` | Fails: existing OpenRouter credential returns HTTP 401 |
| Nebius live gate | Not run: `NEBIUS_API_KEY` unavailable |

The [sanitized NVIDIA trace](nvidia-live-2026-10-06.json) records actual model
resolution, timing, tokens, held decisions, one sandbox execution and replay
rejection. Raw permits and credentials are excluded. This verifies specific
enforcement cases, not model accuracy, calibration or stable production latency.

The [delivery plan](../PLAN.md) tracks Nebius verification, controlled hosting
and the public submission video separately. No production readiness or complete
provider-regression pass is claimed while these gates remain outstanding.
