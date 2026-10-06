# Additional services: scope and free-credit plan

Assessed October 6, 2026. No additional Tavily, Nebius AI Cloud or AWS
account or device is configured for this entry yet. This is an implementation
plan, not a record of using these services. The working Token Factory entry,
published evidence, original live records and offline default stay available.

## Selection

| Service | Concrete contribution | Priority and prerequisite |
|---|---|---|
| Tavily | A cited research step in the refund workflow; tests the distinction between retrieved guidance and permission to act | First. Create a free account and provide `TAVILY_API_KEY` locally; verify the plan, remaining free credits and pay-as-you-go setting before search |
| Nebius AI Cloud | A deployment demonstration with the agent separated from a credential-holding executor and restart-safe state | Second, conditional on separate AI Cloud access, confirmed applicable promotional credits and a bounded teardown plan |
| AWS | A later cross-cloud enforcement example against a real downstream service | Defer until a specific customer workflow needs it; an extra host or bucket does not improve the current demonstration |
| Physical hardware | A device action protected by an exact-action permit at its actuator boundary | Defer until an existing safe device and an actual device-control problem are available; a laptop screen recording is not a robotics demonstration |

The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) require
Token Factory **or** AI Cloud runtime use and an NVIDIA open model. Our verified
Token Factory integration already meets the service-use requirement; using
every service is not required. The Best Use of Tavily bonus is $3,000 and needs
a functional runtime Tavily call as part of the solution. Eligibility does not
guarantee an award. AWS is not an additional required technology or listed
service-use prize in those rules. Stay in Best Apps and Agents for this refund
entry unless the actual product and demonstration change substantially.

## Tavily: prepare the account

1. Create an account at [Tavily](https://app.tavily.com/). Its documented free
   plan includes 1,000 API credits per month without a credit card. Keep the free
   plan and avoid paid upgrades or pay-as-you-go billing.
2. Create an API key. Add `TAVILY_API_KEY=...` to the existing ignored `.env`.
   Do not put it in a message, screenshot, browser bundle or committed example.
   No key is necessary for the existing offline application.
3. Before runtime searches, use the authenticated
   [usage endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/usage)
   to check the actual account plan, plan/key usage and limits, and pay-as-you-go
   usage/limit. A key alone is not proof of free-only funding. Reject unknown
   billing state or paid usage in the first integration preset.
4. The first live verification should make at most **five basic searches**,
   with a **five-credit local reservation cap**, no automatic retries and a
   sanitized record. Reserve before dispatch, retain unknown usage on failure,
   and stop if the free plan/key limit cannot cover the call.

Pricing and search options were checked against
[Tavily pricing](https://docs.tavily.com/documentation/api-credits) and the
[Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search).
Basic search costs one credit. Explicitly set `search_depth: "basic"`,
`auto_parameters: false`, `include_usage: true`, `include_answer: false`,
`include_raw_content: false` and a small `max_results`. Automatic parameter
selection can choose an advanced search costing two credits.

## Tavily: implementation contract

The customer workflow becomes: research relevant refund-processing guidance,
show cited sources, propose the exact requested sandbox refund, then enforce
the existing permit boundary. The research helps the support agent explain
processing behavior; it does not establish transaction ownership, permission,
amount limits or whether a charge is a duplicate.

- Register a versioned read-only research tool with a strict argument schema.
  Server configuration owns provider, approved documentation domains, query
  constraints and credit settings. Keep the Tavily credential and raw handler
  inside the executor. The agent sees only the guarded tool.
- Bind authorization to the exact query and domain restrictions; consume the
  grant before the billable request. Record the consumed authorization and the
  external outcome separately. This advances **Custody, Binding, Enforcement
  and Evidence**, rather than adding an unguarded search wrapper.
- Use public documentation queries, such as refund processing/idempotency
  guidance, without sending customer identity, ticket text, transaction IDs or
  the private ledger to a search engine. Reject private-data queries before
  dispatch.
- Normalize bounded title, URL and snippet fields into versioned evidence.
  Validate returned URL schemes and hosts; do not automatically fetch returned
  URLs. Render snippets as text, preserve source attribution and treat content
  as untrusted even when the domain is approved.
- Keep web content outside server-owned policy and trusted fact fields. If
  snippets reach the planner, label them as untrusted context. A retrieved
  instruction cannot grant permission, change the target or raise the ceiling.
- Ship an explicitly scripted offline source fixture and an opt-in live mode.
  Existing four scenarios and the twelve published live records stay frozen;
  new records identify the optional research stage separately.

Before describing this integration as working, verify a genuine Tavily search
and live NVIDIA-model attribution, usage and enforcement. Test failed search,
unknown billing, budget exhaustion, query mutation, disallowed/private queries,
raw credential absence, replay and consume-before-dispatch. A seeded malicious
snippet should not become authority. Follow the repository's live-provider
gate when model context changes; the existing Jev/OpenRouter HTTP 401 remains
an unresolved prerequisite for that regression, not a passing or skipped check.
Do not merge an unverified change to the decision path as a completed feature.

## Prospective video segment and application changes

After the runtime integration is verified, keep the video under three minutes.
Use about 15 seconds to show a cited research result, its untrusted-content
label and its consumed search authorization. Then show that a seeded snippet
asking for `txn_9981` cannot change the original request for `txn_5512`.
Continue to the exact refund permit, consumption, single sandbox mutation and
replay refusal. Keep the research credit count and offline/recorded/live mode
visible. An injected snippet is a reproducible drill, not proof Tavily naturally
returned malicious text.

Add only the actually implemented service to `APPLICATION.md`, `CHANGES.md`,
`FEEDBACK.md`, `VIDEO.md`, the media captions and `APPLY.md`. Include actual
runtime dates, returned sources, request count, usage and failures. Until then,
the existing statement that Tavily is not used remains accurate. Do not select
a bonus category based only on this plan or a mocked result.

## Nebius AI Cloud: bounded deployment candidate

Token Factory and AI Cloud use distinct credentials and consoles in Nebius's
[own integration guide](https://github.com/nebius/nebius-physical-ai/blob/main/docs/workbench/composing-cloud-and-token-factory.md).
Treat the confirmed $29.50 Token Factory balance as **not confirmed for Cloud**.
Check the Cloud console's billing account, eligible products, remaining credits
and expiry before provisioning. No free-only Cloud deployment is authorized by
an unverified inference-key balance.

If credits apply, prefer a short CPU deployment of the existing enforcement
stack; managed inference already supplies the GPU model. Show private raw
handlers/downstream credentials, authenticated ingress, consume-before-execute,
durable state and a dependency-loss/restart check. Plan TLS and deployment-owned
trusted facts before exposing an execution route. The current single-node
reference topology is not a completed public production deployment.

The [Cloud pricing page](https://nebius.com/prices), effective October 1, lists
CPU instances starting at $0.06/hour. At that starting rate, 30 continuous days
are $43.20 **before** disks, networking or other resources. That exceeds $29.50
even if the credits were transferable. Reserve GitHub Pages and the downloadable
build for free December judge access. Estimate all resources from the actual
regional quote, time-box the recording deployment, preserve sanitized evidence,
then delete only resources created for the experiment, including billable disks
and addresses. Verify teardown; a stopped process is not a billing boundary.

## AWS and hardware: conditions for reconsidering

An AWS credential-broker example could later protect a Lambda/S3 side effect
in another cloud, with verification enforced by the downstream handler. Proceed
only when that boundary serves a concrete demonstration and the account is
verified on the [AWS Free account plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
with adequate credits and eligible services. A paid account's free-tier allowance
is not a hard spending cap. Do not upgrade the plan or enroll in services that
automatically upgrade it to paid.

Hardware is appropriate when an existing device can safely demonstrate a bounded
actuator action. A simulation must be labeled as simulation. Do not buy hardware
or present the laptop running this web app as a Physical AI integration. That
track adds its own genuine physical/robotics workflow and demonstration work.

## Next actions

- [x] Compare requirements, prize relevance, credit scope and current pricing.
- [x] Prepare the Tavily workflow, enforcement contract and prospective demo.
- [ ] Owner creates the free Tavily account and adds `TAVILY_API_KEY` locally.
- [ ] Confirm free-only usage state; implement/test the connector and run a bounded live check.
- [ ] Check separate AI Cloud promotional eligibility before deciding on a deployment.
- [ ] Reconsider AWS/hardware only with a concrete workflow and available free resources.

No new account, cloud resource, purchase, billable API call or submission was
created while preparing this plan.
