import { afterEach, describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { ActionGate } from "@actiongate/sdk";
import { ACTIONGATE_GRANT_META_KEY, ActionGateMcpGateway } from "@actiongate/mcp-gateway";
import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("MCP gateway end to end", () => {
  it("authorizes, consumes, and executes while credentials stay in the gateway", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_mcp_test", logger: false });
    apps.push(app);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const client = new ActionGate({ apiKey: "ag_mcp_test", baseUrl: address });
    const events: string[] = [];
    const gateway = new ActionGateMcpGateway<{ emailApiKey: string }>(client).register({
      name: "send_email",
      operation: "send",
      riskClass: "EXTERNAL_COMMUNICATION",
      parseArguments: (value) => ({ to: String(value.to), body: String(value.body) }),
      execute: async (input, runtime) => {
        events.push("executed");
        expect(runtime.emailApiKey).toBe("credential-only-the-gateway-has");
        return { delivered: true, to: input.to };
      }
    });
    const request = toolCall("send_email", { to: "alice@example.com", body: "Receipt 123" });
    const output = await gateway.authorizeAndCall(request, authorizationBase("mcp-e2e"), { emailApiKey: "credential-only-the-gateway-has" });
    expect(output.authorization).toMatchObject({ decision: "ALLOW", mode: "enforce" });
    expect(output.authorization).not.toHaveProperty("grant");
    expect(output.result).toEqual({ delivered: true, to: "alice@example.com" });
    expect(events).toEqual(["executed"]);
  });

  it("blocks changed arguments and replay before the handler runs", async () => {
    const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_mcp_test", logger: false });
    apps.push(app);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const client = new ActionGate({ apiKey: "ag_mcp_test", baseUrl: address });
    let executions = 0;
    const gateway = new ActionGateMcpGateway(client).register({
      name: "send_email",
      operation: "send",
      riskClass: "EXTERNAL_COMMUNICATION",
      execute: async () => { executions += 1; return { delivered: true }; }
    });
    const exactArguments = { to: "alice@example.com", body: "Receipt 123" };
    const base = authorizationBase("mcp-mutation");
    const authorization = await client.authorize({ ...base, proposedAction: gateway.proposedAction("send_email", exactArguments) });
    const context = { tenantId: base.tenantId, environment: base.environment, actor: base.actor };

    const changed = toolCall("send_email", { to: "attacker@example.com", body: "Receipt 123" }, authorization.grant!.token);
    await expect(gateway.callWithGrant(changed, context, {})).rejects.toMatchObject({ code: "GRANT_BINDING_MISMATCH" });
    expect(executions).toBe(0);

    const exact = toolCall("send_email", exactArguments, authorization.grant!.token);
    await expect(gateway.callWithGrant(exact, context, {})).resolves.toEqual({ delivered: true });
    await expect(gateway.callWithGrant(exact, context, {})).rejects.toMatchObject({ code: "GRANT_ALREADY_CONSUMED" });
    expect(executions).toBe(1);
  });
});

function authorizationBase(suffix: string) {
  return {
    requestId: `request-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    tenantId: "tenant-mcp",
    environment: "development" as const,
    mode: "enforce" as const,
    actor: { agentId: "support-agent", userId: "user-42", sessionId: "session-9" },
    userIntent: { text: "Email receipt 123 to alice@example.com", source: "user_message" as const }
  };
}

function toolCall(name: string, args: Record<string, unknown>, token?: string) {
  return {
    jsonrpc: "2.0" as const,
    id: "call-1",
    method: "tools/call" as const,
    params: {
      name,
      arguments: args,
      ...(token ? { _meta: { [ACTIONGATE_GRANT_META_KEY]: token } } : {})
    }
  };
}
