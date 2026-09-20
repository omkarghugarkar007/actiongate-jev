export { ActionGateRegistry, type ActionGateRegistryOptions } from "./registry.js";
export { staticTokenResolver, bearerToken, type ProxyTokenGrant } from "./tokens.js";
export { authorizeAndConsume, relayedIntent, findEnabledTool, type EnforceInput, type EnforcementResult } from "./enforce.js";
export type {
  ActionGateEnforcementClient,
  ProxyPrincipal,
  ProxyPrincipalResolver,
  ProxyRegistry,
  RegistryTool
} from "./types.js";
