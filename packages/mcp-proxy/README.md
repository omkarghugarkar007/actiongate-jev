# @actiongate/mcp-proxy

Standalone MCP network proxy. Point an MCP client at it instead of the upstream server; both credentials stay in the proxy process.

> Isolate level, but only when the upstream MCP endpoint is not routable from the agent.

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
