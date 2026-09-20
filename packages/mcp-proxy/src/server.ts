import Fastify from "fastify";
import { bearerToken } from "@actiongate/proxy-core";
import { ActionGateMcpProxy, type ActionGateMcpProxyOptions } from "./proxy.js";
import type { ProxyPrincipalResolver } from "./types.js";

export interface McpProxyServerOptions extends Omit<ActionGateMcpProxyOptions, "resolvePrincipal"> {
  resolvePrincipal: ProxyPrincipalResolver;
  logger?: boolean;
  path?: string;
  /** Maximum JSON-RPC body size. Keeps a large payload from reaching the provider. */
  bodyLimit?: number;
}

export function createMcpProxyServer(options: McpProxyServerOptions) {
  const { logger, path = "/mcp", bodyLimit = 1_000_000, ...proxyOptions } = options;
  const proxy = new ActionGateMcpProxy(proxyOptions);
  const app = Fastify({
    bodyLimit,
    logger: logger === false ? false : { redact: ["req.headers.authorization"] }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post(path, async (request, reply) => {
    const response = await proxy.handle(request.body, bearerToken(request.headers.authorization));
    // JSON-RPC carries its own error channel, so transport status stays 200 except
    // for authentication, which belongs at the HTTP layer too.
    return reply.code(response.error?.code === -32001 ? 401 : 200).send(response);
  });

  return app;
}
