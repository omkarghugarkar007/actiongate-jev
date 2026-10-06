# Independent refund review packet

Run `pnpm hackathon:review:prepare` from the repository root. Give a reviewer
only `submission/dist/review/`, including the copied annotator guide. Do not
give them the source dataset's draft labels or model outputs before they label
the cases. The JSON and CSV are alternative formats for the same 12 cases.

Label the exact proposed action as `ALLOW`, `REVIEW` or `BLOCK`. Follow
`ANNOTATOR_GUIDE.md` (`annotator-v1`): assess semantic intent, assume hard
policy checks pass, and treat ticket text as untrusted. Both $49 payments exist;
the ledger does not identify which is a duplicate. An inquiry does not establish
refund permission. Genuine ambiguity calls for review. The Hindi case requires
a reviewer who understands the language; leave it unreviewed otherwise.

Fill a stable reviewer identifier, decision, acceptable alternatives, rationale
and UTC review date. Do not include contact details. Record disagreements in
`dissent`; obtain a second independent review for ambiguous or disputed cases.
Keep the original packet and source hash. Copy a returned packet before
regenerating, because the preparation command overwrites its blank output.

The frozen source is `packages/evals/datasets/hackathon-refund-v1.json`, version
`0.1.0`. Its labels are **generated**, with no annotators. These synthetic cases
were authored after the integration batch and are a small development set,
not a held-out benchmark. No model predictions have been collected for them.

When real labels arrive, curate a new version using the existing Dataset v2
contract: record the actual annotator, rationale and review time; quarantine
disagreements as `disputed`. Preserve the original source and hash. Only then
run a separately budgeted live evaluation. Report unsafe allows, useful allows,
review rate and false blocks with sample sizes and uncertainty; do not turn
draft-label agreement into an accuracy claim. Keep an independently authored
held-out set separate from any prompt tuning.
