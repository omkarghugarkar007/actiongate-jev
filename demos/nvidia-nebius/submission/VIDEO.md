# Demo video: 2 minutes 50 seconds

Start with a short introduction on camera, then switch to the functioning
desktop application. Show both search and refund permit
boundaries, cited untrusted guidance, a seeded wrong target, a corrected refund,
replay and a hard amount ceiling. Show dated runtime evidence separately. This
is a recording script, not a completed video; the YouTube URL remains pending.
The complete narration is [VOICEOVER.txt](VOICEOVER.txt).

## Opening: introduce yourself and the project

Use the first **20 seconds** for your introduction. Look at the camera and use
the lower-third **Omkar Ghugarkar · ActionGate**. A plain background and clear
audio are enough. If you prefer voiceover, show your name and the project cover
during the same introduction.

> Hi, I'm Omkar Ghugarkar. I built ActionGate to help developers control which
> actions their AI agents can execute. For this hackathon, I added a refund agent
> using NVIDIA Nemotron through Nebius Token Factory, with Tavily for research.
> Here's how it works.

Cut to the application on “Here's how it works.” This introduces you and the
product before the demo while accurately describing the hackathon additions
to an existing project. Keep the complete video at 2:50, with 2:30 for the demo,
runtime evidence and closing.

## Prepare with zero spend

1. Run `pnpm demo:research` and open `http://127.0.0.1:8097`. This server is
   always offline, even with keys in `.env`. Leave the seeded snippet checked.
2. In another terminal run `pnpm demo:nvidia`; open `http://127.0.0.1:8095`.
   Confirm the offline badge. Never rehearse with an ordinary live command.
3. Open [Tavily runtime evidence](../verification/TAVILY.md) and the
   [recorded Nebius workbench](https://omkarghugarkar007.github.io/actiongate-jev/?run=injection-r2).
   Keep recorded dates and modes visible. The original twelve records are retained.
4. Capture a 1920×1080 landscape screen. Hide notifications and unrelated tabs;
   keep `.env`, billing screens and key-bearing terminals closed. Use your own
   narration, supplied graphics and no background music.
5. For offline shots use the persistent caption **Offline walkthrough · scripted
   evidence · real permit boundaries**. Runtime evidence shots use **Recorded
   real-provider verification · October 6–7, 2026**.

## Shot list

| Time | Capture | What the viewer should see |
|---|---|---|
| 00:00–00:20 | You on camera; name/project lower-third | Introduce yourself, what ActionGate does and the Nemotron/Nebius/Tavily refund workflow. |
| 00:20–00:30 | Cut to research lab heading, offline badge and flow | Start the demo: the application owns authority; search and refund need separate consumed permits. |
| 00:30–00:55 | Run the requested refund in research lab; show sources and trace | Fixed public query, actor mutation refusal, consumption before sources; seeded snippet labeled as a local drill. |
| 00:55–01:20 | Original lab: wrong-target attack, first BLOCK | Seeded `txn_9981` proposal; no execution until correction. |
| 01:20–01:40 | Corrected proposal, permit, consumption and ledger | `txn_5512`, $49, one execution; replay 409; other transaction unchanged. |
| 01:40–01:55 | Amount-limit and missing-permission cases | $250 above $100 blocked; inquiry requires review; zero executions. |
| 01:55–02:19 | TAVILY.md and refund/limit live records | Real Tavily sources, real Nemotron citation, unchanged target and ceiling; four free searches, $0.0030396 additional Nebius estimate; Jev regression passed. |
| 02:19–02:35 | Recorded workbench: round 2, briefly round 1 | All twelve runs retained; eleven planned outcomes and one safe clarification; hypothetical left vs recorded right. |
| 02:35–02:50 | Research boundary/footer, source/end card | Sandbox, seeded faults, memory state, uncalibrated scores, at-most-once authorization; public source/test build. |

Pause on relevant trace entries; offline events arrive quickly. Do not splice
runs into a purported uninterrupted live run or replace offline badges with
live labels. The malicious snippet is added locally, not naturally returned by
Tavily. For a close-up use the [research screenshot](assets/research-lab.png),
captioned as offline, but keep most of the video in the functioning application.

## Edit and upload

Trim to about 2:50 and verify the exported duration is **under 3:00**. Check
voice, captions, IDs and every mode label. Export a landscape MP4, upload
publicly to YouTube, verify it signed out, then fill the actual URL and duration
in `submission.json`. No script here uploads media or submits the entry.

Title: **ActionGate | Research is evidence. Actions need permits. | Nebius × NVIDIA**

Copy-paste description:

> ActionGate guards both public research and a sandbox refund with exact-action,
> expiring, single-use permits. This video shows a reproducible offline walkthrough
> with scripted evidence and real permit boundaries, then dated actual Tavily,
> NVIDIA Nemotron through Nebius Token Factory, and Jev/OpenRouter verification.
>
> Seeded ticket/snippet attacks do not represent naturally occurring provider
> output. No real money moves. Four basic Tavily searches used free credits;
> the two Nebius research captures cost an estimated $0.0030396. The earlier
> twelve-run batch retains eleven planned outcomes and one safe clarification.
> Its left ledger is hypothetical and its right ledger is recorded. These are
> integration/enforcement observations, not semantic accuracy or production readiness.
>
> Source and setup: https://github.com/omkarghugarkar007/actiongate-jev
>
> Research evidence: https://github.com/omkarghugarkar007/actiongate-jev/blob/main/demos/nvidia-nebius/verification/TAVILY.md
>
> Recorded workbench: https://omkarghugarkar007.github.io/actiongate-jev/?run=injection-r2

Use the shot times as draft chapters and adjust them to the actual cut.
