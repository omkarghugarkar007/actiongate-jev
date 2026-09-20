# MCP gateway integration

`@actiongate/mcp-gateway` places grant consumption inside the tool server, immediately before the registered handler. The gateway owns each tool's operation and risk class, and the handler can keep downstream credentials in a server-only runtime object.

This is the preferred boundary when an agent must not be able to call the underlying tool directly.

## Combined authorize-and-call flow

The combined flow keeps the Action Grant entirely inside the gateway:

```ts
import { ActionGate } from "@actiongate/sdk";
import { ActionGateMcpGateway } from "@actiongate/mcp-gateway";

const actionGate = new ActionGate({
  apiKey: process.env.ACTIONGATE_API_KEY!,
  baseUrl: process.env.ACTIONGATE_URL!
});

const gateway = new ActionGateMcpGateway<{ emailApiKey: string }>(actionGate)
  .register({
    name: "send_email",
    operation: "send",
    riskClass: "EXTERNAL_COMMUNICATION",
    parseArguments(value) {
      if (typeof value.to !== "string" || typeof value.body !== "string") {
        throw new Error("to and body are required");
      }
      return { to: value.to, body: value.body };
    },
    async execute(input, runtime) {
      return emailProvider.send({
        apiKey: runtime.emailApiKey,
        to: input.to,
        body: input.body
      });
    }
  });

const result = await gateway.authorizeAndCall(
  {
    jsonrpc: "2.0",
    id: "call-42",
    method: "tools/call",
    params: {
      name: "send_email",
      arguments: { to: "alice@example.com", body: "Receipt 123" }
    }
  },
  {
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    tenantId: "acme",
    environment: "production",
    mode: "enforce",
    actor: {
      agentId: "support-agent",
      userId: "user-42",
      sessionId: "session-7"
    },
    userIntent: {
      text: "Email receipt 123 to alice@example.com",
      source: "user_message"
    }
  },
  { emailApiKey: process.env.EMAIL_API_KEY! }
);
```

The sequence is fixed:

1. resolve the server-registered tool;
2. validate and normalize its arguments;
3. derive the server-owned operation and risk class;
4. authorize the exact action;
5. consume the returned Action Grant;
6. invoke the handler.

`BLOCK`, `REVIEW`, a missing grant, mutation, expiry, or replay stops before step 6. `authorizeAndCall` refuses Shadow Mode because observational decisions are not execution authority.

The returned authorization receipt excludes the raw grant token. Only the gateway-local call stack sees it.

## Split flow with MCP metadata

When authorization and the tool server are separate, put the permit in request metadata rather than tool arguments:

```json
{
  "jsonrpc": "2.0",
  "id": "call-42",
  "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "to": "alice@example.com",
      "body": "Receipt 123"
    },
    "_meta": {
      "actiongate/grant": "ag1.<payload>.<signature>"
    }
  }
}
```

Call `gateway.callWithGrant(request, authenticatedContext, runtime)`. The tenant, environment, and actor context must come from the authenticated server session—not from model-controlled metadata. The gateway reconstructs the action from its registry and consumes the grant before invoking the handler.

## Security requirements

- Keep the raw handler and downstream credential private to the gateway process.
- Do not also expose an unguarded route to the same tool.
- Authenticate the MCP transport and derive tenant and actor context server-side.
- Never place the grant inside tool arguments, prompts, logs, or model-visible history.
- Use Redis storage for multi-instance deployments so all gateways share consumption state.
- Use Redis authentication, TLS, persistence, replication, backups, and network isolation in production.
- Treat consumption as at-most-once authorization. Reconcile downstream state before requesting another permit after an execution timeout.

The package is currently consumed from the workspace because registry names are unresolved. For a network boundary, the shipped `@actiongate/mcp-proxy` package provides an authenticated standalone proxy that owns the upstream credential; see [guarding an MCP server](guard-an-mcp-server.md).
