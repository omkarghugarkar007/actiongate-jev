import type { ProxyPrincipal, ProxyRegistry, RegistryTool } from "./types.js";

export interface ActionGateRegistryOptions {
  baseUrl: string;
  /** An ActionGate key with the `authorize` or `decision_reader` role. */
  apiKey: string;
  /** How long a tenant's tool list may be reused. Zero disables caching. */
  cacheTtlMs?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
}

/**
 * Reads server-owned tool metadata from the ActionGate control plane so the proxy
 * never trusts the upstream server's own description of risk or operation.
 */
export class ActionGateRegistry implements ProxyRegistry {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly cache = new Map<string, { expiresAt: number; tools: RegistryTool[] }>();

  constructor(private readonly options: ActionGateRegistryOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
  }

  async listTools(principal: ProxyPrincipal): Promise<RegistryTool[]> {
    const ttl = this.options.cacheTtlMs ?? 5_000;
    const key = `${principal.tenantId}:${principal.environment}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.clock()) return cached.tools;

    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/v1/tools`, {
      headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`ActionGate registry returned HTTP ${response.status}`);
    const body = await response.json() as { data?: unknown };
    const tools = Array.isArray(body.data) ? body.data.flatMap(toRegistryTool) : [];
    if (ttl > 0) this.cache.set(key, { expiresAt: this.clock() + ttl, tools });
    return tools;
  }
}

function toRegistryTool(value: unknown): RegistryTool[] {
  if (typeof value !== "object" || value === null) return [];
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || typeof tool.operation !== "string" || typeof tool.riskClass !== "string") return [];
  return [{
    name: tool.name,
    operation: tool.operation,
    riskClass: tool.riskClass as RegistryTool["riskClass"],
    enabled: tool.enabled !== false,
    ...(typeof tool.argumentSchema === "object" && tool.argumentSchema !== null
      ? { argumentSchema: tool.argumentSchema as Record<string, unknown> }
      : {})
  }];
}
