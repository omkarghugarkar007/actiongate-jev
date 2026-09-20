export { ActionGateHttpProxy, type ActionGateHttpProxyOptions } from "./proxy.js";
export { createHttpProxyServer, type HttpProxyServerOptions } from "./server.js";
export { createSidecar, type SidecarPresetOptions } from "./presets.js";
export { FetchHttpUpstream, UpstreamError, type HttpUpstreamOptions } from "./upstream.js";
export { RouteTable, defaultArguments } from "./routes.js";
export {
  ACTIONGATE_INTENT_HEADER,
  type HttpMethod,
  type HttpUpstream,
  type ProxyHttpRequest,
  type ProxyHttpResponse,
  type ProxyRoute,
  type RouteMatch
} from "./types.js";
// Re-exported for convenience so a sidecar needs one import.
export { ActionGateRegistry, staticTokenResolver, type ProxyPrincipal, type ProxyTokenGrant } from "@actiongate/proxy-core";
