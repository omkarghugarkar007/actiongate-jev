import Fastify from "fastify";
import { bearerToken } from "@actiongate/proxy-core";
import { ActionGateHttpProxy, type ActionGateHttpProxyOptions } from "./proxy.js";

export interface HttpProxyServerOptions extends ActionGateHttpProxyOptions {
  logger?: boolean;
  bodyLimit?: number;
}

export function createHttpProxyServer(options: HttpProxyServerOptions) {
  const { logger, bodyLimit = 1_000_000, ...proxyOptions } = options;
  const proxy = new ActionGateHttpProxy(proxyOptions);
  const app = Fastify({
    bodyLimit,
    logger: logger === false ? false : { redact: ["req.headers.authorization"] }
  });

  app.get("/health", async () => ({ status: "ok" }));

  // One catch-all: routing is the proxy's allowlist, not Fastify's.
  app.all("/*", async (request, reply) => {
    const response = await proxy.handle(
      {
        method: request.method,
        path: new URL(request.url, "http://proxy.local").pathname,
        query: request.query as Record<string, string | string[]>,
        headers: request.headers as Record<string, string | string[] | undefined>,
        body: request.body
      },
      bearerToken(request.headers.authorization)
    );
    return reply.code(response.status).headers(response.headers).send(response.body);
  });

  return app;
}
