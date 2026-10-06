# ActionGate refund lab · NVIDIA × Nebius

**Nemotron proposes. ActionGate decides and enforces.** A customer asks for a
duplicate-charge refund; the agent must obtain an exact-action, expiring,
single-use permit before its private handler changes a sandbox payment ledger.

This advances **Authority, Binding, Enforcement, Custody and Evidence**. The
model cannot change the registered risk, operation, amount ceiling or identity,
and receives neither a permit token nor a payment credential.

![Offline refund lab showing a seeded wrong-target block, corrected allow, consumed permit, one sandbox execution and rejected replay.](assets/refund-lab.png)

## Run it

From the repository root, with Node 22+ and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm demo:nvidia                # offline; no credentials, DB or container
# Open http://127.0.0.1:8095
```

For a live NVIDIA run, put `NVIDIA_API_KEY` in the root `.env`, then stop the
offline server and run:

```bash
pnpm demo:nvidia:live
pnpm test:nemotron:live         # explicit opt-in; spends inference credits
pnpm nemotron:smoke             # one semantic call, resolution and token usage
```

`NVIDIA_API_KEY` is the
[documented key name](https://docs.nvidia.com/nemo/datadesigner/concepts/models/model-providers).
The default is `nvidia/nemotron-3-super-120b-a12b`. `NVIDIA_MODEL` is an optional
override, never agent input. All secrets stay server-side.

For Nebius, add `NEBIUS_API_KEY` and use:

```bash
pnpm demo:nebius
pnpm test:nebius:live
pnpm nemotron:smoke -- --nebius
```

The Token Factory preset uses `nvidia/nemotron-3-super-120b-a12b`, following the
[official model guide](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md).
`NEBIUS_MODEL` can select a model available to the account. Its transport and
normalization are fixture-tested; a Nebius key was unavailable for live validation.
There is no fallback to another backend. Missing live keys fail loudly.

You can also run without a browser:

```bash
pnpm demo:nvidia:run -- --scenario=injection        # offline trace
pnpm demo:nvidia:run -- --live --scenario=injection # NVIDIA
pnpm demo:nvidia:run -- --nebius --scenario=refund   # Token Factory
```

## What the four scenarios show

| Scenario | Behavior |
|---|---|
| Wrong-target attack | A labeled fixture seeds `txn_9981` for intent naming `txn_5512`. Semantic evidence blocks it. Nemotron sees safe decision reasons and proposes a correction; ActionGate consumes its permit before a refund and rejects replay. |
| Authorized refund | Nemotron selects the requested $49 refund; policy and evidence must allow it before execution. |
| Above the limit | A $250 request hits the server-owned $100 ceiling. No model score can override it. |
| Missing permission | A labeled fixture proposes a refund for an inquiry. Semantic uncertainty requires review, so the handler stays idle. |

Seeded faults make the boundary reproducible; they are not presented as natural
planner mistakes. Offline planning and evidence are scripted fixtures. Live
mode performs real model calls for planning and semantic evaluation. These are
demonstration cases, not an independently reviewed accuracy benchmark.

## Architecture and boundary

```text
Browser selects a fixed scenario (no keys, grants or arbitrary code)
  → Nemotron planner proposes typed arguments
  → Existing authenticated ActionGate API
      server-owned identity, tool registry, schema, trusted ledger facts, policy
      + Nemotron semantic evidence (versioned, strictly validated JSON)
  → ALLOW / REVIEW / BLOCK with named reasons and stable decision ID
  → Exact-action grant, retained only by the server
  → Consume before private sandbox ledger mutation
  → Separate execution record and explicit replay rejection
  → Sanitized streaming trace and token usage
```

**Guard level.** The handler and raw permits are private to the server's run
closure. Each run has a fresh authenticated tenant and ledger. All authority
stays in the existing API; the planner cannot edit the registry or policy.
Privileged host code could bypass an in-process boundary. No payment service
or real payment credential is connected, and no production isolation is claimed.

The server listens only on loopback, checks local Host/Origin on runs, accepts
fixed scenarios, permits one active run and spaces live starts by at least 15
seconds. Runs use memory and disappear afterward. For a real deployment, use
the hardened API, durable stores and an executor whose downstream credentials
cannot be reached through another path.

Nemotron scores are **self-reported and uncalibrated**. Existing policy thresholds
remain unchanged. The adapter rejects extra/missing answers, invalid numbers,
unknown choices, inconsistent distributions, refusals and truncated output.
There is no retry or fake fallback. Legacy `JEV_*` errors and semantic reason
source `JEV` are retained for public-contract compatibility; `model.provider`
and `resolvedModel` attribute evidence to the actual gateway.

The normal API can explicitly select `DECISION_PROVIDER=nvidia` or `nebius`.
Those presets use a 10-second semantic timeout; `DECISION_TIMEOUT_MS` overrides
it, and the idempotency lease must be longer. Jev's 2-second default and the
fake provider remain unchanged. Financial tools still require deployment-owned
trusted facts. For embedded JS, pass a `NemotronDecisionProvider` through the
existing `ActionGate.embedded({ provider })` option.

## Verification and submission status

The planner receives the ticket and ledger; the authorization provider receives
only explicit intent, the current proposed action and its relevant transaction.
This minimizes unrelated evidence and cost. A supported proposal can still be
held for review if the model's self-reported confidence is insufficient; no
score is increased and no threshold is lowered to make the demo pass.

NVIDIA's live gate verifies actual gateway attribution, model resolution,
authorization, exact-action mutation rejection, one successful consumption and
replay denial. The live agent gate verifies wrong-target refusal, model-planned
correction and one sandbox refund. The UI shows latency and actual input/output
tokens; the gateway does not report cost, so the demo does not invent it.

The [delivery plan](PLAN.md) separates completed local work from remaining
submission work. The [competition](https://nebiusglobalaihackathon.devpost.com/rules)
requires actual Token Factory runtime calls or Nebius AI Cloud execution.
NVIDIA-hosted inference alone does not meet that requirement. A Nebius live
trace, controlled hosted test build and public video remain pending.

## 90-second demo script

The [sanitized NVIDIA live report](verification/nvidia-live-2026-10-06.json)
records the resolved Super model, a 4.55-second attack/correction/execution run,
3,638 input and 472 output tokens, and separate held intent/limit cases. It is
one enforcement trace, not a claim of model accuracy or stable hosted latency.

1. **0–15s:** Explain the customer's exact request and the wrong transaction a
   tool call could target despite passing schema validation.
2. **15–40s:** Run the wrong-target drill in live mode. Open the first decision's
   evidence: semantic scope/policy refusal, no handler invocation.
3. **40–65s:** Show Nemotron's corrected proposal, the allowed exact action,
   consumed permit and separate sandbox execution record.
4. **65–80s:** Show the rejected replay and ledger: only `txn_5512` was refunded.
5. **80–90s:** Run the amount-limit scenario. State that code owns authority,
   the model supplies evidence, and the sample moves no real money.
