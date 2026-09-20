export { ActionGateMcpProxy, ProxyError, type ActionGateMcpProxyOptions } from "./proxy.js";
export { HttpMcpUpstream, UpstreamError, type HttpMcpUpstreamOptions } from "./upstream.js";
export { ActionGateRegistry, type ActionGateRegistryOptions } from "./registry.js";
export { createMcpProxyServer, staticTokenResolver, type McpProxyServerOptions, type ProxyTokenGrant } from "./server.js";
export {
  ACTIONGATE_INTENT_META_KEY,
  JSON_RPC,
  type ActionGateEnforcementClient,
  type DeterministicFactProvider,
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
