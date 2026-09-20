import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { ActionGateMcpProxy, type ActionGateMcpProxyOptions } from "./proxy.js";
import type { ProxyPrincipal, ProxyPrincipalResolver } from "./types.js";

export interface ProxyTokenGrant extends ProxyPrincipal {
  token: string;
}

/**
 * Resolves a downstream bearer token to a principal in constant time, so a caller
 * cannot learn a valid token by timing the comparison.
 */
export function staticTokenResolver(grants: readonly ProxyTokenGrant[]): ProxyPrincipalResolver {
  const byDigest = new Map<string, ProxyPrincipal>();
  for (const { token, ...principal } of grants) {
    if (token.length < 16) throw new Error("A proxy token must be at least 16 characters");
    byDigest.set(digest(token), principal);
  }
  const digests = [...byDigest.keys()];
  return async (token) => {
    if (!token) return undefined;
    const candidate = digest(token);
    let matched: ProxyPrincipal | undefined;
    // Compare against every configured token so the work does not depend on which
    // one matches.
    for (const known of digests) {
      if (timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(known, "hex"))) {
        matched = byDigest.get(known);
      }
    }
    return matched;
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return undefined;
  return value.trim() || undefined;
}
