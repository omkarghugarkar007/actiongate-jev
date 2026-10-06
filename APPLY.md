# Apply: ActionGate · Nebius × NVIDIA

Use this file to finish the hackathon submission. The application text, video
script, judging instructions, feedback and existing-project disclosure are
prepared. **The video is not recorded or uploaded, and no entry has been submitted.**
This package reduces submission friction; it does not change authorization.

## Event and deadline

| Item | Value |
|---|---|
| Event | [Nebius x NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/) |
| Track | Best Apps and Agents |
| Submission closes | **October 30, 2026, 10:00 PDT / 22:30 IST** |
| Build period | August 26–October 30, 2026 |
| Keep judging access available through | December 15, 2026, 12:00 PST / December 16, 01:30 IST |
| Project | ActionGate — permits for agent actions |
| Repository | [Public Apache-2.0 source](https://github.com/omkarghugarkar007/actiongate-jev) |

Dates and requirements were checked against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules)
on October 6, 2026. Recheck them before submitting.

## Prepared materials

| Submission material | Ready-to-use file |
|---|---|
| Title, tagline, project story, technology and sponsor usage | [APPLICATION.md](demos/nvidia-nebius/submission/APPLICATION.md) |
| 2:50 video: 20-second personal/project intro, demo, recording steps and upload copy | [VIDEO.md](demos/nvidia-nebius/submission/VIDEO.md) |
| Complete narration | [VOICEOVER.txt](demos/nvidia-nebius/submission/VOICEOVER.txt) |
| Demo/test-build link and judge walkthrough | [JUDGING.md](demos/nvidia-nebius/submission/JUDGING.md) |
| Nebius and NVIDIA feedback | [FEEDBACK.md](demos/nvidia-nebius/submission/FEEDBACK.md) |
| Significant changes to the existing project | [CHANGES.md](demos/nvidia-nebius/submission/CHANGES.md) |
| Gallery images, captions and video cover | [MEDIA.md](demos/nvidia-nebius/submission/MEDIA.md) |
| Frozen refund cases and independent-review instructions | [REVIEW.md](demos/nvidia-nebius/submission/REVIEW.md) |
| Additional-service assessment and prospective Tavily demo | [SERVICE_EXPANSION.md](demos/nvidia-nebius/SERVICE_EXPANSION.md), [Tavily runtime/cost evidence](demos/nvidia-nebius/verification/TAVILY.md) — guarded research implemented |
| Links and remaining entrant fields | [submission.json](demos/nvidia-nebius/submission/submission.json) |
| Live model, boundary and credit evidence | [Verification record](demos/nvidia-nebius/verification/README.md) |
| Interactive recorded evidence and iteration plan | [Repeated batch](demos/nvidia-nebius/verification/WORKBENCH.md), [improvement plan](demos/nvidia-nebius/IMPROVEMENT_PLAN.md) |

The submission needs English project text, public licensed source with setup
instructions, a working demo or test-build URL, a publicly visible YouTube video
under three minutes, track selection, sponsor feedback and the existing-project
change statement. Judging access must remain free through the judging period.
Personal eligibility and ownership declarations belong to the entrant.
[Requirement source](https://nebiusglobalaihackathon.devpost.com/rules).

## Free-only submission route

Use the [pinned public test-build download](https://github.com/omkarghugarkar007/actiongate-jev/archive/45450584121597b228c7556d347a4c7664a79568.zip)
and the instructions in `JUDGING.md`. It is a source test build that runs locally
with scripted evidence and no credentials. No paid hosting or always-on inference
is needed. The rules allow a test-build URL; confirm that this download-and-run
format is accepted by the final form. A localhost address is not a public demo URL.

The application also links actual Token Factory runtime verification from
October 6. Offline fixtures alone do not establish sponsor runtime use. The
resolved model was `nvidia/nemotron-3-super-120b-a12b`; three live checks passed.
Five requests including connectivity used an **estimated $0.0021927**, under the
observed $1 trial-credit budget. That batch is closed; the estimate is not an
invoice or a current wallet balance.

A later, separately bounded promotional-credit batch recorded twelve live
scenario runs with twenty calls, estimated $0.0089817. Eleven reached the
planned workflow; one safely requested additional confirmation. All outcomes
remain in the [recorded browser walkthrough](https://omkarghugarkar007.github.io/actiongate-jev/?run=injection-r2).
This page has no executor or provider key; its left ledger is hypothetical,
and its right ledger is recorded. Use the source test build to exercise actual
enforcement. Independent semantic review remains outstanding.

The supplied video plan records the working offline application and separately
shows the existing live evidence. Preparing, rehearsing, packaging and checking
these materials makes no model calls. Do not use `demo:nebius` or any live test
for rehearsals: ordinary live commands have no free-credit-only spending guard.
The trial shown on October 6 also expires before December judging; do not depend
on it for judge access.

## Finish and submit

1. Review `APPLICATION.md`, `FEEDBACK.md` and `CHANGES.md`. Keep the disclosure
   that ActionGate already existed. Add genuine team contributions if applicable.
2. Fill the entrant fields in `submission.json`: display name, Devpost profile,
   team members if any, and personally confirm eligibility and ownership.
3. Rehearse with `pnpm demo:nvidia`. Record and edit using `VIDEO.md` and
   `VOICEOVER.txt`; keep offline/recorded labels visible. Upload the finished
   video publicly to YouTube, then enter its URL and actual duration in the JSON.
4. Run `pnpm hackathon:prepare`. It copies the application materials, creates a
   local source-test-build ZIP and writes checksums to
   `demos/nvidia-nebius/submission/dist/`. This is a local packaging command.
5. Open the public ZIP in a signed-out browser and follow `JUDGING.md` from a
   clean directory. Check the YouTube link signed out too. Set the three public
   access confirmations in `submission.json` only after checking them.
6. Run `pnpm hackathon:check`. Missing personal/video fields are expected until
   filled; the command must pass before the final entry is ready.
7. Join the event on Devpost and create a project draft. Paste the prepared text,
   test-build/repository/video URLs, feedback and change statement into the
   matching fields. Upload the cover and application screenshot from `MEDIA.md`.
   The private form may ask additional personal questions; answer them directly.
8. Review the preview, confirm the rules yourself and submit before the deadline.
   Save the submission URL/confirmation in `submission.json` and retain an exact
   copy of the submitted files. Recheck access during December judging.

**Still requires the entrant:** personal declarations, final video recording and
public upload, signed-out access checks, and the Devpost submission. The scripts
do not accept legal terms, upload media or submit an entry.

## Claims to keep accurate

- Wrong-target and missing-permission mistakes are deliberately seeded drills.
  Offline planner/evidence are scripted; the recorded Nebius suite used real calls.
- The private handler changes a sandbox ledger. No payment provider or real money
  is connected. State resets per run; this demo is a local Guard boundary.
- Models supply evidence. Server policy creates authority. Permits are consumed
  before execution; this provides at-most-once authorization.
- Nemotron confidence is self-reported and uncalibrated. These checks establish
  specific boundary behavior, not semantic accuracy or production readiness.
- The refreshed Jev/OpenRouter key passes all five enabled regression checks and the new Tavily research gate. Tavily used four free basic credits; the two Nebius research captures cost an estimated $0.0030396.
- Nebius AI Cloud, physical hardware and AWS are not used in this entry.

The video now includes the optional research lab: `pnpm demo:research` at
`127.0.0.1:8097`, always offline. It shows a permit consumed before a cited
source fixture and a separate permit consumed before refund execution. Actual
Tavily/Nebius/Jev usage is documented separately; choose the Tavily bonus only
with that functional runtime record, subject to the final form and rules.

The pinned test build now includes the research lab. Its anonymous ZIP was
downloaded, installed with the frozen lockfile and exercised without `.env`: a
desktop refund, mobile amount hold, permit checks and no external browser calls.
[Public-access check](demos/nvidia-nebius/verification/tavily-public-access-2026-10-07.json).
