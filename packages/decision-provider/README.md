# @actiongate/decision-provider

Adapters that normalize decision-model evidence, including TypeSafe Jev through
the direct System One API or OpenRouter, plus experimental Nemotron evidence
through NVIDIA or Nebius Token Factory.

> A provider supplies evidence. It never decides, and never issues or consumes a grant.

```ts
import { TypeSafeJevProvider } from "@actiongate/decision-provider";

const provider = new TypeSafeJevProvider({
  apiKey: process.env.TYPESAFE_API_KEY!,
  model: "jev-1.13.0"
});
```

The direct adapter sends `state`, `model`, and typed `questions` to
`https://api.typesafe.ai/v1/systemone`, strictly validates the answer shape, and
retries only documented transient `429` and `529` responses within the caller's
total timeout. Keep the key server-side.

Part of [ActionGate](https://github.com/omkarghugarkar007/actiongate-jev): Jev supplies
evidence, ActionGate creates and enforces the permit. See the
[quickstarts](https://github.com/omkarghugarkar007/actiongate-jev/blob/main/docs/quickstarts.md)
for one screen per integration level, and the
[threat model](https://github.com/omkarghugarkar007/actiongate-jev/blob/main/docs/threat-model.md)
for the security boundary.

## Status

`NemotronDecisionProvider({ apiKey, backend: "nvidia" | "nebius" })` implements
the existing provider interface. Its v1 JSON schema supports `noul` and `choice`
questions and rejects missing/extra answers, invalid distributions, refusals,
truncation and unsupported score questions. It sends one bounded request with
no retry or fallback; redirects are refused. API keys stay out of error messages.

Nemotron's scores are **self-reported and uncalibrated**. Policy thresholds are
unchanged, and no provider can override deterministic failures. Legacy `JEV_*`
error codes remain compatible; gateway attribution is `nvidia` or `nebius`.
NVIDIA and Nebius live authorization/agent gates pass. The recorded Nebius batch
used an estimated $0.00219 of observed trial credit with local reservation limits.
See the [refund lab](../../demos/nvidia-nebius/README.md) for setup and limitations.

Early public release. Not production-ready: no external security review yet.

## License

Apache-2.0
