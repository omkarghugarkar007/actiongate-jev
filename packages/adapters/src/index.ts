export { guardToolCalls, toToolMessages, type GuardToolCallsOptions, type GuardedToolResult, type ToolCall } from "./tool-calls.js";
export { guardFunction, ActionRefusedError, type GuardFunctionOptions } from "./execute-fn.js";
export { guardWebhook, WebhookRefusedError, type GuardWebhookOptions, type InboundWebhook } from "./webhook.js";
export type { ActionGateEnforcementClient, ProxyPrincipal, ProxyRegistry, RegistryTool } from "@actiongate/proxy-core";
