export { ActionGateMcpProxy, ProxyError, type ActionGateMcpProxyOptions } from "./proxy.js";
export { HttpMcpUpstream, UpstreamError, type HttpMcpUpstreamOptions } from "./upstream.js";
export { createMcpProxyServer, type McpProxyServerOptions } from "./server.js";
export { createGuardedMcpServer, type McpGatewayPresetOptions } from "./presets.js";
export { StdioMcpUpstream, PolicyRegistry, semanticOnly, adoptTools, runStdioProxy, type StdioUpstreamOptions, type StdioProxyOptions } from "./stdio.js";
// Re-exported from proxy-core so existing imports keep working.
export { ActionGateRegistry, staticTokenResolver, type ActionGateRegistryOptions, type ProxyTokenGrant } from "@actiongate/proxy-core";
export {
  ACTIONGATE_INTENT_META_KEY,
  JSON_RPC,
  type ActionGateEnforcementClient,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpUpstream,
  type ProxyPrincipal,
  type ProxyPrincipalResolver,
  type ProxyRegistry,
  type RegistryTool,
  type UpstreamTool
} from "./types.js";
