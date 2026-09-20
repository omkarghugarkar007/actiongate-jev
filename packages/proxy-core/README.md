# @actiongate/proxy-core

The shared enforcement path every ActionGate proxy uses: registry reads, constant-time token resolution, relayed-intent handling, and authorize-then-consume.

> `authorizeAndConsume` returns only after the grant is spent, so a caller acting on `ok: true` is acting on a consumed permit.

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
