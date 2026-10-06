# Entry improvement plan

Started October 6, 2026. This plan improves evidence and the judging experience;
it does not promise a prize. The [official rubric](https://nebiusglobalaihackathon.devpost.com/rules)
weights implementation, design, impact and idea quality equally.

## Assessment

The core differentiation is strong: a model proposes an action, while a
provider-independent control plane owns authority and enforces an exact-action
permit. The current refund lab demonstrates that locally, and real NVIDIA and
Nebius checks already pass. The weak points are a small live sample, no immediate
public walkthrough, and no independently reviewed semantic labels.

Adding unrelated integrations would dilute the refund story. We will improve
the same developer problem: a schema-valid call can change the wrong payment.

## Iteration 1 — evidence and judge access

| Work | Value | Exit criterion |
|---|---|---|
| Reusable, fail-closed live budget guard | Friction reduction; protects the builder's experiment budget | Catalog-based conservative reservation before dispatch; concurrency/cap/unknown-usage/failure tests; no retry; sanitized persistent record; explicit close |
| Repeated Nebius runs of the four existing scenarios | Evidence | Real resolved model, tokens, latency, every outcome and failure recorded; successful correction/consumption/replay cases shown without selecting away failures |
| Browser evidence workbench | Friction reduction and clearer evidence | Key-free, responsive, clearly labeled playback of recorded live runs; hypothetical first-action impact compared with recorded guarded ledger; no executor or provider call in the page |
| Public static walkthrough on free GitHub Pages | Friction reduction | Anonymous desktop/mobile access; no secret/API credentials; source test build retained for exercising actual enforcement |
| Update application and video material | Evidence | Every claim matches the new records; seeded faults and recorded playback remain explicit |

Implementation reuses existing provider and enforcement code. The cost guard
wraps the provider's existing fetch seam; it does not modify model questions,
confidence thresholds or authorization policy. The public page is an evidence
viewer, not a remotely callable payment boundary.

## Credit budget

The latest screenshot shows $29.50 account balance and $1 trial credit. The
owner confirmed the $29.50 is free promotional/hackathon credit before this
batch started. No top-up or billing change was made.

The completed first iteration used a **$1 maximum
reservation budget**, at most **40 inference requests**, no automatic retries
and serialized scenarios. Use the catalog's full context plus requested output
cap to reserve an upper bound, then settle against valid reported token counts.
Unknown costs retain their reservation and stop the batch. Expected actual
usage is much smaller; report measured tokens and estimates rather than promises.
Keep the rest available for reviewed evaluations and the final capture.

The guard limits this explicitly owned batch. It does not read a billing wallet,
change provider billing, or cover other clients using the account. No top-up,
automatic recharge change, GPU provisioning or paid hosting is planned.

## Iteration 2 — semantic evidence with independent review

1. Freeze a small refund-focused corpus: supported requests, target swaps,
   inquiries, ambiguous references, malicious retrieved instructions and
   paraphrases. Record provenance and proposed labels as unreviewed.
   Prepared: [12 frozen cases and a blind review packet](submission/REVIEW.md),
   using the existing Dataset v2 contract. Run `pnpm hackathon:review:prepare`;
   this makes no model calls and creates no reviewed labels.
2. Have a real independent reviewer label the frozen cases without model outputs.
   Record identity, rationale and disagreements using the existing eval contract.
3. Evaluate Super against that reviewed set under a separately bounded budget.
   Report unsafe allows, useful allows, review rate, false blocks, sample size
   and uncertainty separately. Preserve failures and the exact dataset hash.
4. Compare a cheaper NVIDIA model only if the catalog offers a suitable model
   and the first results justify the experiment. Do not tune and test on the
   same labels, or call a generated case replay “accuracy.”

Independent human review cannot be invented by an agent. Until it happens,
we can report integration/reliability observations and deterministic boundary
assertions, but not reviewed semantic accuracy.

## Iteration 3 — final demonstration and feedback

Record a video under three minutes using the refined walkthrough and one
clearly dated real trace. Complete the entrant declarations, public-access
checks and Devpost fields in [APPLY.md](../../APPLY.md). Keep the source test
build and evidence page available through December judging. Strengthen the
sponsor feedback with reproducible budget and structured-response observations.

## Non-regression gates

- Fake mode stays the zero-config default; no new mandatory environment variables.
- Keys and raw permits never enter public artifacts, model context or logs.
- Models cannot override identity, registry metadata, schema, amount or RBAC.
- Budget exhaustion/dependency loss cannot produce an executed unconsumed action.
- Run the relevant lint, type, unit/integration and desktop/mobile checks.
- Exercise the guarded capture against real Nebius before reporting live success.
- Keep the unresolved Jev/OpenRouter HTTP 401 separate from passing Nebius evidence.

## Status

- [x] Review judging criteria and current gaps.
- [x] Implement/test the batch spending guard.
- [x] Confirm the account balance is free credit.
- [x] Capture and evaluate repeated live runs without hiding failures: [12 records, 20 calls, $0.0089817 estimate](verification/WORKBENCH.md); one safe clarification retained.
- [x] Build/test the static evidence walkthrough, including desktop/mobile playback and zero provider traffic.
- [x] Publish the static walkthrough and verify anonymous desktop/mobile access: [public page](https://omkarghugarkar007.github.io/actiongate-jev/?run=injection-r2), [access record](verification/public-access-2026-10-06.json).
- [x] Refresh submission copy and video script with actual results.
- [x] Freeze 12 draft refund cases and prepare a blind independent-review packet.
- [ ] Obtain independent human labels before semantic accuracy claims.
- [ ] Record/upload video and submit as the eligible entrant.
