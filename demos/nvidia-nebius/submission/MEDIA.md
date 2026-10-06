# Submission media

The gallery should show the application and the boundary, with modes labeled.
The assets below are our repository graphics/screenshots; no third-party stock
image, logo or music is needed.

| Use | Asset | Caption / alt text |
|---|---|---|
| Gallery cover / video title and end card | [cover.png](assets/cover.png), editable [cover.svg](assets/cover.svg) | ActionGate puts a bound permit and consume-before-execute boundary between an agent proposal and a private sandbox refund handler. |
| Functioning application | [refund-lab.png](../assets/refund-lab.png) | Offline scripted walkthrough: a seeded wrong-target refund is blocked; a corrected target is allowed, consumed and executed once; replay is refused. No real money moves. |
| Technical explanation, optional | [platform architecture](../../../docs/assets/platform-architecture.svg) | The wider ActionGate platform separates provider evidence from authenticated policy, registry, grant lifecycle and guarded integration boundaries, with memory and opt-in durable storage. This is broader than the refund demo. |

For Devpost, start with the cover and actual lab screenshot. Add a screenshot of
the public Nebius JSON record only if its date, gateway, token totals and
“recorded verification” label are legible. Do not upload the account billing
screenshot; its organization details are unrelated to judging the application.

The cover is 1920×1080. The preparation command copies its PNG and the lab PNG
into `submission/dist/` alongside the text drafts and test-build ZIP. Use the
supplied screenshot's offline caption even if a new video also shows past live
evidence. A still image is not evidence of a fresh live call.
