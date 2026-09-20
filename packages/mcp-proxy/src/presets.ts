import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry, staticTokenResolver } from "@actiongate/proxy-core";
import { HttpMcpUpstream } from "./upstream.js";
import { createMcpProxyServer } from "./server.js";

export interface McpGatewayPresetOptions {
  actionGateUrl: string;
  actionGateApiKey: string;
  upstreamMcpUrl: string;
  upstreamToken?: string;
  proxyToken: string;
  tenantId: string;
  environment?: "development" | "staging" | "production";
  agentId?: string;
  logger?: boolean;
}

/**
 * The `mcp-gateway` preset: point an MCP client at the returned server instead of
 * the upstream one. Both credentials stay in this process.
 */
export function createGuardedMcpServer(options: McpGatewayPresetOptions) {
  return createMcpProxyServer({
    client: new ActionGate({ apiKey: options.actionGateApiKey, baseUrl: options.actionGateUrl }),
    registry: new ActionGateRegistry({ baseUrl: options.actionGateUrl, apiKey: options.actionGateApiKey }),
    upstream: new HttpMcpUpstream({
      url: options.upstreamMcpUrl,
      ...(options.upstreamToken ? { headers: { Authorization: `Bearer ${options.upstreamToken}` } } : {})
    }),
    resolvePrincipal: staticTokenResolver([{
      token: options.proxyToken,
      tenantId: options.tenantId,
      environment: options.environment ?? "production",
      actor: { agentId: options.agentId ?? "mcp-client" }
    }]),
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
}
