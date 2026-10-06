# Existing-project change statement

ActionGate is an existing open-source project. This entry is a significant
extension of that project, not a claim that the entire platform was built during
the hackathon. The changes below merged on October 6, 2026, within the published
August 26–October 30 submission period.

## Existing foundation

Before this hackathon extension, ActionGate already had its provider-independent
policy core, Jev adapters, authenticated tenant/registry API, exact-action grant
lifecycle, trusted fact providers, durable storage options, JS/Python SDKs,
HTTP/MCP integrations, dashboard and regression suites. Those existing controls
form the foundation of the entry; they are not presented as new hackathon work.

The immediate pre-feature baseline is
[commit 72ffdc8](https://github.com/omkarghugarkar007/actiongate-jev/commit/72ffdc8).
This is the baseline for the extension, not a statement that all its contents
predate the start of the event.

## Significant hackathon additions

| Addition | Why it changes the project | Evidence |
|---|---|---|
| Versioned Nemotron evidence adapter and NVIDIA/Nebius presets | A second model family can supply strictly normalized evidence to the same enforcement core. No vendor dependency was added to core authorization. | [PR #19](https://github.com/omkarghugarkar007/actiongate-jev/pull/19), `packages/decision-provider/src/nemotron.ts` |
| Agent refund workflow with a private sandbox handler | Planning, correction and evidence now connect to consume-before-execute enforcement, separate execution outcomes and replay rejection. | PR #19, `demos/nvidia-nebius/src/runtime.ts` |
| Dedicated demo UI, CLI and four cases | Developers can inspect an entire lifecycle with zero credentials, or explicitly select real NVIDIA/Nebius inference. Unsafe proposals are labeled seeded faults. | PR #19, `demos/nvidia-nebius/frontend/`, `src/cli.ts` |
| Live NVIDIA integration record | Actual gateway/model resolution, correction, holds, permit consumption and replay were exercised. | [NVIDIA trace](../verification/nvidia-live-2026-10-06.json) |
| Live Nebius Token Factory verification under trial credits | Sponsor runtime use was established with three live checks and a closed, bounded five-request batch. | [PR #21](https://github.com/omkarghugarkar007/actiongate-jev/pull/21), [Nebius record](../verification/nebius-live-2026-10-06.json) |
| Submission and recording package | Application copy, judge setup, video script, sponsor feedback, media and offline packaging reduce evaluation/adoption friction. | [APPLY.md](../../../APPLY.md) and this directory |

Dependency/workflow maintenance and security patches were reviewed separately.
They are baseline upkeep, not the main innovation claimed for the entry.

## Why this is more than a provider wrapper

The extension applies all five ActionGate values: **Authority** through
deterministic policy, **Binding** to the exact action, **Enforcement** through
consume-before-execute, **Custody** of registry/identity/handler, and **Evidence**
connecting the lifecycle. Calling Nemotron directly supplies none of that
authority or execution control. The new adapter makes those existing guarantees
usable with an NVIDIA open model through Nebius.

## Boundaries and attribution

The refund demo changes fixtures, not real payments. Its memory state resets
each run. Nemotron scores are self-reported and uncalibrated; the recorded cases
are integration/security evidence rather than accuracy benchmarks. ActionGate
remains an early public release, and the independent Jev/OpenRouter regression
rerun is still blocked by HTTP 401.

Entrants should add each actual team member's contribution before submitting.
Do not assign contributions, ownership or eligibility to someone without their
confirmation; those personal fields are intentionally unfinished in
`submission.json`.

## Compact form answer

ActionGate existed before this entry. Its original policy core, identity,
registry, exact-action permits, SDKs and durable storage are the foundation.
During the hackathon period we added strict NVIDIA Nemotron evidence adapters
for NVIDIA and Nebius gateways, a support-agent refund lab with a private handler,
four visible scenarios, safe streaming/CLI output, live gateway tests and recorded
Token Factory verification under trial credits. The new workflow demonstrates
wrong-target rejection, correction, consume-before-execute and replay refusal.
These additions merged October 6, 2026 in PRs #19 and #21. We do not claim the
pre-existing platform as newly built, production readiness or calibrated accuracy.
