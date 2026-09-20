import "dotenv/config";
import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, FetchHttpUpstream, createHttpProxyServer, staticTokenResolver, type ProxyRoute } from "@actiongate/http-proxy";

/**
 * Runnable HTTP sidecar. Routes are supplied as JSON so a deployment declares its
 * guarded surface in configuration rather than in code.
 */
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const routes = JSON.parse(required("ACTIONGATE_PROXY_ROUTES")) as ProxyRoute[];
if (!Array.isArray(routes) || routes.length === 0) throw new Error("ACTIONGATE_PROXY_ROUTES must be a non-empty array");

const baseUrl = required("ACTIONGATE_URL");
const apiKey = required("ACTIONGATE_API_KEY");

const server = createHttpProxyServer({
  client: new ActionGate({ apiKey, baseUrl }),
  registry: new ActionGateRegistry({ baseUrl, apiKey }),
  upstream: new FetchHttpUpstream({
    baseUrl: required("UPSTREAM_URL"),
    // Stays in this process. The caller never receives it.
    ...(process.env.UPSTREAM_TOKEN ? { headers: { Authorization: `Bearer ${process.env.UPSTREAM_TOKEN}` } } : {})
  }),
  resolvePrincipal: staticTokenResolver([{
    token: required("ACTIONGATE_PROXY_TOKEN"),
    tenantId: required("ACTIONGATE_TENANT_ID"),
    environment: (process.env.ACTIONGATE_ENVIRONMENT ?? "development") as "development" | "staging" | "production",
    actor: { agentId: process.env.ACTIONGATE_AGENT_ID ?? "proxy-client" }
  }]),
  routes
});

const port = Number(process.env.PORT ?? 8090);
await server.listen({ port, host: "0.0.0.0" });
console.log(JSON.stringify({ service: "actiongate-http-proxy", port, guardedRoutes: routes.map((route) => `${route.method} ${route.path} -> ${route.tool}`) }, null, 2));
