# ActionGate documentation

Start with the [integration guide](integration-guide.md) to protect an agent tool call. The remaining documents explain why ActionGate makes each authorization decision and where its trust boundaries sit.

| Document | Purpose |
|---|---|
| [Quickstarts](quickstarts.md) | One screen per integration level: Observe, Guard, Isolate, Govern |
| [Integration guide](integration-guide.md) | REST and TypeScript SDK setup, rollout modes, response handling, and production checklist |
| [API description](api/openapi.json) | Versioned OpenAPI 3.1 document generated from the server's own schemas |
| [Integration ecosystem](integrations.md) | Adapter levels, shared contract, priority connectors, and contribution acceptance gates |
| [Architecture](architecture.md) | Components, request flow, provider boundary, and decision composition |
| [Product plan](PLANNING.md) | Product thesis, moat, delivery phases, acceptance gates, and living checklist |
| [MCP gateway](mcp-gateway.md) | Guarded tool registration, combined execution, split-grant flow, and security requirements |
| [MCP proxy manifest](integrations.md#worked-example-the-mcp-proxy-manifest) | The standalone network proxy: what it protects, what it requires, and what still bypasses it |
| [Threat model](threat-model.md) | Assets, trust boundaries, abuse cases, mitigations, and current limitations |
| [Roadmap](roadmap.md) | Planned durability, integrations, observability, and release milestones |
| [Engineering plan](engineering-plan.md) | Original product and implementation specification |

For a runnable integration, see the [refund-agent example](../examples/refund-agent/). For API routes and the shortest setup path, return to the [project README](../README.md).
