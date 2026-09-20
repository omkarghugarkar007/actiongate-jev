# @actiongate/decision-provider

Adapters that normalize decision-model evidence, including TypeSafe Jev through
the direct System One API or OpenRouter.

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

Early public release. Not production-ready: no external security review yet.

## License

Apache-2.0
