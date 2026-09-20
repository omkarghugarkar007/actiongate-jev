# @actiongate/sdk

TypeScript client for ActionGate. `wrapTool` authorizes, consumes a single-use grant, then calls a private handler.

> Guard level: it protects the wrapper, not the callee. Keep the handler private to its module.

Runs in-process with `ActionGate.embedded()` — no server, no API key, no base URL —
or against a server with `new ActionGate({ apiKey, baseUrl })`. Same guarantees,
same `wrapTool` code. Embedded keeps grants in memory, so they do not survive a
restart or coordinate across replicas, and the policy sits in the agent's own
process.

Its full boundary, including what it does **not** protect, is in [`connector.manifest.json`](./connector.manifest.json).


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
