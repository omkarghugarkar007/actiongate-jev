# Sponsor feedback draft

This feedback is grounded in the October 6 implementation and verification.
Review it before submitting; add personal experience only where it actually
happened. The relevant evidence is in the [Nebius record](../verification/nebius-live-2026-10-06.json)
and [verification summary](../verification/README.md).

## Nebius Token Factory

**What helped:** Token Factory let the same NVIDIA open model power our planner
and evidence adapter without GPU provisioning. Its chat-completions API fit a
small HTTPS JSON transport. The authenticated model catalog exposed the exact
model ID, context limit and token prices, which made a conservative trial-credit
reservation possible. We recorded real gateway attribution, token counts and
latencies; three live checks passed.

**Issue observed:** The account showed a $1 trial balance, $0 paid balance and
“Billing: Suspended,” but authenticated catalog access and the bounded inference
batch succeeded. That status made it difficult to know whether a trial call was
allowed. An API key alone also did not tell our client whether a request would
use trial or paid funds. We used a manually confirmed balance and a temporary
local reservation guard rather than infer a spending guarantee from the key.

**Suggested improvement:** Expose trial-versus-paid credit buckets, expiry and
account state through an authenticated API usable by inference clients. Offer
an account-side “trial credits only” limit that rejects a request before it can
create paid usage. Clarify the UI status when billing is suspended but trial
inference is still available. These changes would make hackathon and educational
use easier to automate safely without card charges or polling a billing page.

**Impact:** A programmatic balance plus provider-enforced free-only mode would
reduce uncertainty for small-budget builders and make open-model evaluation
reproducible. Our five-request estimate was $0.0021927, so the issue is confidence
in the spending boundary rather than a complaint about this batch's cost.

## NVIDIA Nemotron and tools used

**What helped:** Nemotron 3 Super produced typed planning responses and
structured semantic evidence for a support-agent workflow. We verified the
resolved `nvidia/nemotron-3-super-120b-a12b` model through both NVIDIA and Nebius
gateways. Real correction after a seeded wrong-target rejection let us exercise
the complete propose → decide → consume → execute boundary.

**Integration work:** We enforced a versioned output schema and validated
answer completeness, choice distributions and confidence consistency. We kept
the proposed action's evidence scoped to the relevant transaction and retained
uncertainty as review rather than increasing scores to force an allow.

**Suggested improvement:** Publish more examples for schema-constrained agent
decisions with explicit refusal/truncation handling, and explain how consumers
should interpret model-reported confidence. Standardized gateway usage/cost
metadata would also help: the demo can report real tokens but the gateway
response did not supply a monetary cost. We computed a separate catalog-rate
estimate rather than present an invented cost inside the product.

**Impact:** Clear evidence schemas and confidence guidance would help builders
use open models without confusing generated confidence with authorization or
calibration. We did not benchmark semantic accuracy and cannot offer a
model-quality ranking from these few enforcement cases.

## Nebius AI Cloud

We did not deploy compute, Serverless Jobs, Serverless Endpoints or DevPods.
Token Factory inference was sufficient for this local application. We have no
firsthand AI Cloud performance or usability feedback to report. We would assess
those services separately if the workflow later needs durable background jobs
or a controlled hosted executor.

## Compact form answer

Token Factory let us verify NVIDIA Nemotron 3 Super without provisioning GPUs;
its model catalog enabled a conservative cost reservation. Three real API/agent
checks passed. The account displayed “Billing: Suspended” despite usable trial
inference, so the status could be clearer. We suggest an authenticated API for
trial/paid balances and expiry, plus a provider-enforced trial-only spending
limit. For Nemotron, schema-constrained decision examples and guidance on
self-reported confidence would help developers separate evidence from authority.
Standardized gateway cost metadata would improve accounting. We did not use
Nebius AI Cloud compute and have no firsthand feedback on it.
