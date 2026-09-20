import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, staticTokenResolver } from "@actiongate/proxy-core";
import { FetchHttpUpstream } from "./upstream.js";
import { createHttpProxyServer, type HttpProxyServerOptions } from "./server.js";
import type { ProxyRoute } from "./types.js";

export interface SidecarPresetOptions {
  /** ActionGate base URL and key. The key never leaves this process. */
  actionGateUrl: string;
  actionGateApiKey: string;
  /** The service being protected, and the credential that reaches it. */
  upstreamUrl: string;
  upstreamToken?: string;
  /** What the caller presents to the sidecar. Never the ActionGate key. */
  proxyToken: string;
  tenantId: string;
  routes: readonly ProxyRoute[];
  environment?: "development" | "staging" | "production";
  agentId?: string;
  logger?: boolean;
}

/**
 * The `sidecar` preset. Everything a deployment usually wants is wired here, so
 * adding the proxy stays one call rather than six objects. Anything unusual is
 * still available by constructing `createHttpProxyServer` directly.
 */
export function createSidecar(options: SidecarPresetOptions) {
  const client = new ActionGate({ apiKey: options.actionGateApiKey, baseUrl: options.actionGateUrl });
  const server: HttpProxyServerOptions = {
    client,
    registry: new ActionGateRegistry({ baseUrl: options.actionGateUrl, apiKey: options.actionGateApiKey }),
    upstream: new FetchHttpUpstream({
      baseUrl: options.upstreamUrl,
      ...(options.upstreamToken ? { headers: { Authorization: `Bearer ${options.upstreamToken}` } } : {})
    }),
    resolvePrincipal: staticTokenResolver([{
      token: options.proxyToken,
      tenantId: options.tenantId,
      environment: options.environment ?? "production",
      actor: { agentId: options.agentId ?? "sidecar-client" }
    }]),
    routes: options.routes,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  };
  return createHttpProxyServer(server);
}
