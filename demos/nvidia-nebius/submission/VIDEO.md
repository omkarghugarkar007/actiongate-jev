# Demo video: 2 minutes 40 seconds

**Record a desktop walkthrough, not a slide-only pitch.** Show the real offline
application handling a seeded wrong target, issuing/consuming a permit, changing
one sandbox transaction, rejecting replay and enforcing an amount ceiling.
Then show the existing, dated Nebius live verification record. This avoids
additional inference spending while documenting the actual sponsor integration.

The complete spoken script is [VOICEOVER.txt](VOICEOVER.txt). Target 2:40 total;
leave time for cursor movements. The script is a recording plan, not a finished
video. The public YouTube URL remains empty until an actual upload exists.

## Prepare without spending credits

1. Stop any existing live lab server. From the repository root run
   `pnpm demo:nvidia`; open `http://127.0.0.1:8095`.
2. Check that the badge reads **OFFLINE · SCRIPTED FIXTURES**. Use this mode for
   every take. Keep the badge in view at the start, and add the persistent caption
   **Offline walkthrough · scripted model evidence · real permit boundary**.
3. Open the public Nebius JSON record in a second tab. Show the date, provider,
   resolved model, three passing tests, token totals and estimate. Caption it
   **Recorded live Nebius verification · 2026-10-06**.
4. Rehearse the clicks in [JUDGING.md](JUDGING.md). Expand only the relevant
   evidence panels; use browser zoom/crops so IDs and decisions remain legible.
5. Record a landscape screen at 1920×1080 with your usual screen recorder. Hide
   notifications and unrelated tabs. Capture only the lab, public evidence and
   supplied title card; keep `.env`, billing pages and terminals with keys closed.
6. Use your own narration and no background music. Use the supplied ActionGate
   graphics and app screenshot; no sponsor logos or third-party clips are needed.

Never replace the offline caption with “live” for dramatic effect. A new live
capture would require a fresh confirmed free balance and a bounded batch; the
ordinary `demo:nebius` command is not that safeguard. No new live capture is
necessary for this script.

## Shot list and timing

| Time | Capture | Detail to make readable |
|---|---|---|
| 00:00–00:12 | Cover card, then lab overview | Customer intent is about `txn_5512`, not every transaction. |
| 00:12–00:28 | Four-stage flow and offline badge | Planner/evidence vs server-owned authority; disclose mode immediately. |
| 00:28–00:55 | Run **01 · Wrong-target attack**; expand intent/fault and first decision | Untrusted override text, seeded `txn_9981`, `BLOCK`, handler not invoked. The trace appears quickly offline; linger on the evidence afterward. |
| 00:55–01:20 | Scroll to corrected proposal, allow, consumption and execution | `txn_5512`, `4900`, distinct ordered stages, **1 EXECUTION**. |
| 01:20–01:39 | Replay evidence and ledger | Status `409`, only requested transaction refunded, other transaction unchanged. |
| 01:39–01:55 | Run **03 · Above the limit**; brief missing-permission cut | `$250` vs `$100` gives `BLOCK`; inquiry drill gives `REVIEW`; neither executes. |
| 01:55–02:19 | Public Nebius verification JSON | Provider `nebius`, resolved Super ID, 3 passing checks, 5 calls, 5218/697 tokens, `$0.0021927` estimate. Keep the recorded-evidence caption visible. |
| 02:19–02:34 | Return to lab footer/ledger; show boundary text | Sandbox, memory, seeded faults, uncalibrated confidence, at-most-once authorization. |
| 02:34–02:40 | Cover/end card with repository | ActionGate: models supply evidence; the application enforces the permit. |

Do not speed up a model wait or splice separate runs into one purported live
execution. Offline runs are fast; this plan uses pauses and close-ups to explain
their trace. The separate evidence segment reports already recorded calls.

## Edit and upload

- Trim to approximately 2:40 and verify the actual file is **under 3:00**.
- Listen through once; check captions, transaction IDs, timeline and audible voice.
- Preserve the offline and dated-record labels in the final export and thumbnail.
- Export a normal landscape MP4 and make the YouTube upload publicly visible.
- Test the video signed out; record its final URL and duration in `submission.json`.

Suggested title:

**ActionGate | Permits for agent actions | Nebius × NVIDIA demo**

Copy-paste description:

> ActionGate puts an exact-action, expiring, single-use permit between an agent
> proposal and a private sandbox refund handler. This video shows a reproducible
> offline walkthrough with scripted model evidence, followed by the dated record
> of actual NVIDIA Nemotron 3 Super calls through Nebius Token Factory.
>
> The wrong-target and missing-permission faults are deliberately seeded. No
> real money moves. The recorded Nebius batch passed three live checks; five
> requests used 5,218 input and 697 output tokens, estimated $0.0021927 at the
> October 6 catalog rates. This is enforcement verification, not model accuracy.
>
> Source and setup: https://github.com/omkarghugarkar007/actiongate-jev
>
> Nebius evidence: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/verification/nebius-live-2026-10-06.json

Use the timestamps above as draft chapter boundaries, adjusting them to the
actual cut. The final video must show the functioning application, not only
the cover card or JSON record.
