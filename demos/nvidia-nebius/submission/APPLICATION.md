# Application copy

Use the sections below in the corresponding Devpost fields. Edit personal/team
information in `submission.json`; these drafts do not assert entrant eligibility.

## Project name

ActionGate — permits for agent actions

## Tagline

Give agents an exact-action, single-use permit before they change anything.

## Short description

ActionGate turns a model's proposed tool call into an enforceable decision. Our
NVIDIA Nemotron refund agent runs through Nebius Token Factory, while server-owned
policy and signed permits control a private sandbox payment handler. The demo
blocks a wrong transaction, permits a supported correction, consumes before
execution and rejects replay. A key-free offline mode makes the boundary easy
to inspect.

## Inspiration

A customer asks for a refund on one transaction. An agent proposes a refund on
another. Both calls pass the same argument schema; only one matches the request.
As agents gain tools, developers need a boundary between plausible model output
and permission to change a system.

ActionGate's premise is simple: model evidence can inform a decision, but the
application must own identity, policy and the execution boundary. For this
hackathon we extended our existing control plane with an open-model support
agent and a visible, testable refund workflow.

## What it does

The refund lab presents four cases: a seeded wrong target, an authorized $49
refund, a $250 request above a $100 ceiling, and a charge inquiry that grants no
refund permission.

In live mode, NVIDIA Nemotron 3 Super uses Nebius Token Factory to propose typed
actions and provide structured semantic evidence. ActionGate authenticates the
actor, loads the server-owned tool definition and trusted ledger facts, validates
the arguments and composes deterministic policy with that evidence. It returns
`ALLOW`, `REVIEW` or `BLOCK` with reasons.

Only enforced `ALLOW` can produce an expiring permit tied to the exact actor,
tenant, environment, tool, operation, arguments, risk, decision and policy
version. The server consumes it before invoking its private ledger handler.
A repeated consumption is refused. The UI connects proposal, decision,
consumption, execution and replay checks without exposing raw permits or keys.

The wrong-target and missing-permission cases deliberately seed unsafe proposals
to make the demonstration reproducible. The offline mode scripts both planning
and semantic evidence; the live mode makes real model calls. No real payments
are connected, and each run begins with a fresh in-memory sandbox.

## How we built it

We reused the existing TypeScript control plane rather than moving authorization
into a prompt. Its provider-independent core owns policy composition,
fingerprints and permit signing; the authenticated API owns registry metadata,
trusted facts and lifecycle records.

We added a strictly validated `nemotron-json-v1` evidence adapter with separate
NVIDIA and Nebius gateway presets. The adapter normalizes answers into the same
provider contract used by Jev. It rejects malformed distributions, unsupported
answers, refusals and truncated output. It cannot issue an authorization.

The planner receives untrusted ticket text and a sandbox ledger. Semantic
evaluation receives the proposed action, explicit customer intent and the
relevant transaction, reducing unrelated context. A private executor closure
retains the handler and permits; neither is available to the planner or browser.

The local interface streams a sanitized action trace, decisions, ledger changes,
latency and token usage. Fixed scenarios, a loopback listener and local
Host/Origin checks keep this recording/test application small. The wider
platform's durable PostgreSQL/Redis modes are separate from this memory demo.

## Challenges we ran into

Separating confidence from authority mattered more than prompt polish. A model
score must never override a missing role, invalid schema, amount ceiling,
duplicate or unavailable dependency. We retained the existing policy thresholds
and kept model parsing strict, even when uncertainty holds an action for review.

We also needed to demonstrate the entire boundary, rather than stop at an
`ALLOW` response. The demo therefore consumes the exact permit before mutation,
records the execution outcome separately and attempts replay afterward.

Live verification had a $1 trial-credit constraint. We checked the catalog,
reserved a conservative maximum before each request, serialized the batch and
stopped it after verification. Cost figures below are token-rate estimates;
ordinary live demo commands do not inherit that original one-off guard. The
later repeated batch uses a reusable, persisted capture guard under a separate
$1 cap; it does not change account-wide billing.

## Accomplishments

- The same enforcement core now accepts strictly normalized Nemotron evidence
  without depending on NVIDIA or Nebius inside the core.
- The refund agent can correct a deliberately seeded wrong target in a real
  model run, then execute one sandbox refund after successful consumption.
- Live Nebius verification passed three checks across API and agent suites:
  gateway attribution, exact-action mutation denial, RBAC denial, single-use
  consumption and wrong-target correction were exercised.
- Five Nebius requests including connectivity used 5,218 input and 697 output
  tokens, an estimated $0.0021927 at the catalog rates observed October 6, 2026.
- A later bounded promotional-credit batch repeated all four cases three times.
  Twenty real calls used 21,281 input / 2,886 output tokens, estimated $0.0089817.
  Eleven of twelve runs reached the planned flow; one correctly blocked the
  wrong target but asked for an unnecessary confirmation. Every run is retained.
- A key-free browser workbench compares the hypothetical first-proposal ledger
  with each recorded guarded outcome. It has no executor and makes no model
  calls, so judges can inspect evidence after trial credits expire.
- A frozen twelve-case refund corpus and blind JSON/CSV packet prepare genuine
  independent review. Draft labels remain generated, and no semantic quality
  result is claimed from them.
- Existing regression checks covered unit/integration behavior, Redis,
  PostgreSQL, Python, package exports and desktop/mobile UI. Results and the
  unresolved Jev authentication gate are published in the verification record.

These are enforcement/integration results. We have no independently reviewed
semantic accuracy result, production throughput claim or external security review.

## What we learned

Putting an open model behind a stable evidence contract makes the useful part
portable: authority, exact binding, custody of tool definitions and enforcement
do not need to change when the model gateway changes. Recording consumption
and execution as separate events also makes failures easier to explain.

The demo benefits from honest labels. An injected fault tests a boundary; it
does not prove how often a planner would make that mistake naturally. A token
estimate measures one batch; it does not prove future spending or model quality.

## What's next

We plan independent semantic label review, calibration and external security
review before high-impact use. A production refund integration needs durable
state, controlled downstream credentials and a deployment-owned spending limit.
We also want more drop-in HTTP/MCP connectors that reuse the same core boundary.
The local demo and downloadable test build remain useful without those services.

## NVIDIA and Nebius usage

**NVIDIA model:** `nvidia/nemotron-3-super-120b-a12b`, used for typed planning and
structured intent/scope evidence. The live records report this resolved ID.

**Nebius service:** Token Factory inference API at
`https://api.tokenfactory.nebius.com/v1/chat/completions`. The application makes
runtime calls in its explicit Nebius mode; the recorded live API and refund-agent
checks used that gateway. Managed inference let us verify the open model without
provisioning GPUs. The model catalog supplied the rates for our cost estimate.

We also verified the NVIDIA-hosted gateway during development. Those calls are
separate from the Nebius runtime-use record. Nebius AI Cloud compute, Serverless
Jobs/Endpoints, AWS and physical hardware were not used.

**Tavily:** A working public-documentation search stage consumes an exact-query/domain permit before using the private Tavily credential. Retrieved guidance is untrusted planner context. Real Tavily searches returned cited Stripe documentation; Nemotron used a citation while preserving the requested target and amount ceiling under a seeded snippet attack. Four basic searches used free Researcher credits with paid overflow confirmed disabled. Two Nebius research captures used five model calls, estimated $0.0030396. The new Jev research gate also passed. [Actual runtime records](../verification/TAVILY.md). Select Best Use of Tavily as the optional bonus if available in the final form; its eligibility remains subject to the rules.

## Built with

TypeScript, Node.js, pnpm, Fastify, Zod, NVIDIA Nemotron 3 Super, Nebius Token
Factory, Tavily Search, HTML/CSS/JavaScript, Vitest and Playwright. ActionGate's existing wider
platform includes PostgreSQL, Redis, a Next.js dashboard and JS/Python SDKs;
those services are not required for this refund test build.

## Links and evidence

- Repository: https://github.com/omkarghugarkar007/actiongate-jev
- Interactive recorded evidence: https://omkarghugarkar007.github.io/actiongate-jev/?run=injection-r2
- Test build: https://github.com/omkarghugarkar007/actiongate-jev/archive/45450584121597b228c7556d347a4c7664a79568.zip
- Setup/walkthrough: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/submission/JUDGING.md
- Actual Nebius calls: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/verification/nebius-live-2026-10-06.json
- Broader check results: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/verification/README.md
- Existing-project explanation: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/submission/CHANGES.md
- Sponsor feedback: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/submission/FEEDBACK.md
- Public YouTube URL: **pending recording/upload; fill `submission.json`**

The test build runs locally with offline fixtures. The live evidence link is a
record of past calls, not an always-on hosted inference service. Round 2 is the
selected correction example; the workbench includes all three rounds and the
round-1 clarification hold. No reviewed semantic accuracy is claimed.
