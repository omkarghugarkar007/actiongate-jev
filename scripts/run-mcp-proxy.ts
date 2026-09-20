import "dotenv/config";
import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, HttpMcpUpstream, createMcpProxyServer, staticTokenResolver } from "@actiongate/mcp-proxy";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required("ACTIONGATE_URL");
const apiKey = required("ACTIONGATE_API_KEY");

const server = createMcpProxyServer({
  client: new ActionGate({ apiKey, baseUrl }),
  registry: new ActionGateRegistry({ baseUrl, apiKey }),
  upstream: new HttpMcpUpstream({
    url: required("UPSTREAM_MCP_URL"),
    // Stays in this process. The model never receives it.
    ...(process.env.UPSTREAM_TOKEN ? { headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` } } : {})
  }),
  resolvePrincipal: staticTokenResolver([{
    token: required("ACTIONGATE_PROXY_TOKEN"),
    tenantId: required("ACTIONGATE_TENANT_ID"),
    environment: (process.env.ACTIONGATE_ENVIRONMENT ?? "development") as "development" | "staging" | "production",
    actor: { agentId: process.env.ACTIONGATE_AGENT_ID ?? "mcp-client" }
  }])
});

const port = Number(process.env.PORT ?? 8091);
await server.listen({ port, host: "0.0.0.0" });
console.log(JSON.stringify({ service: "actiongate-mcp-proxy", port, endpoint: "/mcp" }, null, 2));
