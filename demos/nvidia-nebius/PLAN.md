# NVIDIA × Nebius delivery plan

Started October 6, 2026. Target: **Best Apps and Agents** at the
[Nebius × NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/rules).
The deadline is October 30, 2026, 10:00 PDT / 22:30 IST.

## Product story

A support agent can understand a customer's problem and propose a refund.
ActionGate supplies what a direct model call cannot: **Authority, Binding,
Enforcement, Custody and Evidence**. Nemotron supplies semantic evidence;
server-owned policy decides, and an exact-action permit is consumed before the
private payment handler runs. A seeded unsafe proposal makes the boundary
visible; a real model plans its correction. The demonstration moves no money.

## Delivery sequence

1. **Prepare the baseline — complete.** Review all seven open PRs. Merge passing
   production/workflow updates #12–#17. Hold the development updates because
   TypeScript 7 breaks the installed lint tooling. Dependabot superseded #11
   with #18; #18 still fails CI lint and remains unmerged. Preserve secrets and
   fake-provider defaults.
2. **Add typed Nemotron evidence — complete for NVIDIA.** Reuse the existing
   provider contract and six-question battery. Validate a versioned JSON object,
   choice distributions, refusals and truncation. No policy-threshold change,
   provider fallback or core vendor dependency. Nebius has a documented preset
   and fixture coverage; its live test requires a key.
3. **Build the agent and product demo — complete locally.** Provide offline and
   explicit live modes, four scenarios, model-planned correction, private ledger,
   authorize → issue → consume → execute → replay, sanitized streaming, token
   usage, responsive UI and a headless runner.
4. **Verify — local and NVIDIA gates complete; Jev live authentication blocked.**
   Record model resolution, latency and usage. Check adversarial output, hard
   failures, exact-action binding and replay. Keep semantic accuracy distinct
   from enforcement correctness. Refresh the OpenRouter credential and rerun its
   required gate before calling the full provider regression verification complete.
5. **Finish the submission — pending.** Add `NEBIUS_API_KEY`, run
   `pnpm test:nebius:live`, record an actual Nebius runtime trace, host a controlled
   test build and record a public video under three minutes. The local demo is
   deliberately not a production server; public hosting needs authentication or
   restricted access, shared spend limits and an explicit deployment boundary.

## Acceptance gates

- Tier 0 still starts with no model key, database or container.
- Both semantic adapters and the planner receive no signing secret or raw permit.
- A wrong target has no side effect; its correction can execute only after consume.
- Policy ceiling and absent intent hold the ledger unchanged.
- Invalid evidence and dependency failure issue no permit.
- Permit mutation and replay fail closed; execution outcomes carry the decision ID.
- Live evidence names the real gateway, resolved model, latency and actual tokens.
- A Nebius failure never silently switches to NVIDIA or fixtures.
- README, architecture, trust model and adoption ladder describe the shipped code.

## Submission evidence still needed

The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) require a
working demo/test-build URL, public open-source source, setup instructions,
clear NVIDIA/Nebius usage and a publicly visible YouTube demonstration under
three minutes. Actual Token Factory inference or Nebius AI Cloud execution is
required. NVIDIA-hosted inference alone is development evidence, not eligibility.

No AWS integration is included in this scope. Future demos can reuse the same
core and live in a separate folder without duplicating enforcement.
