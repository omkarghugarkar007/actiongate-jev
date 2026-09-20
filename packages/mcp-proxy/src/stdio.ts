import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Policy } from "@actiongate/core";
import type { ProxyPrincipal, ProxyRegistry, RegistryTool } from "@actiongate/proxy-core";
import { ActionGateMcpProxy } from "./proxy.js";
import type { McpUpstream, UpstreamTool } from "./types.js";

/**
 * A stdio MCP proxy, so guarding a server is a config edit rather than code.
 *
 * Most desktop MCP clients spawn a process and speak JSON-RPC over stdin and
 * stdout; they do not call an HTTP endpoint. This is the shape those clients can
 * actually use: the client launches this, this launches the real server, and
 * every tools/call is authorized and its grant consumed in between.
 *
 * Diagnostics go to stderr. Anything written to stdout that is not a JSON-RPC
 * response corrupts the protocol.
 */
export interface StdioUpstreamOptions {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

/** Speaks JSON-RPC over stdio to a child MCP server that it owns. */
export class StdioMcpUpstream implements McpUpstream {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: StdioUpstreamOptions) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
      ...(this.options.cwd ? { cwd: this.options.cwd } : {})
    });
    // The upstream's own logging must never reach our stdout.
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[upstream] ${chunk}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.on("exit", (code) => {
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Upstream MCP server exited with code ${code}`));
      }
      this.pending.clear();
      this.child = undefined;
    });
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? "Upstream MCP server returned an error"));
    else waiter.resolve(message.result);
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Upstream MCP server timed out"));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async listTools(): Promise<UpstreamTool[]> {
    const result = await this.send("tools/list", {});
    const tools = (result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (typeof tool !== "object" || tool === null) return [];
      const entry = tool as { name?: unknown; description?: unknown };
      if (typeof entry.name !== "string") return [];
      return [{ name: entry.name, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }];
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // `_meta` is not forwarded: reserved keys stay on this side of the boundary.
    return this.send("tools/call", { name, arguments: args });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * A registry backed by a local policy, for running without an ActionGate server.
 *
 * The honest caveat: the policy lives in the same process as the proxy, so this
 * is not the server-owned registry an agent cannot reach. It is the right trade
 * for a desktop client guarding its own tools, and the wrong one for a shared
 * deployment.
 */
export class PolicyRegistry implements ProxyRegistry {
  constructor(private readonly policy: Policy) {}
  async listTools(_principal: ProxyPrincipal): Promise<RegistryTool[]> {
    return Object.entries(this.policy.tools).map(([name, tool]) => ({
      name,
      operation: tool.operation,
      riskClass: tool.riskClass,
      enabled: tool.enabled
    }));
  }
}

/**
 * Adds any upstream tool the policy does not mention, at `riskClass`.
 *
 * Without this, guarding an arbitrary MCP server hides every one of its tools,
 * because none are in the bundled policy. With it, the guard works out of the
 * box — but an adopted tool's risk class is a *guess*, not the server-owned
 * metadata a real deployment relies on. Set explicit tools in a policy file
 * before trusting it with anything costly.
 *
 * Adoption happens in the policy rather than only in the registry, so the
 * registry and the decision engine cannot disagree about which tools exist.
 */
export function adoptTools(
  policy: Policy,
  toolNames: readonly string[],
  riskClass: RegistryTool["riskClass"] = "REVERSIBLE_WRITE"
): Policy {
  const profile =
    riskClass === "DESTRUCTIVE" || riskClass === "CREDENTIAL_OR_SECRET" ? "destructive-v1"
    : riskClass === "FINANCIAL" ? "financial-v1"
    : riskClass === "READ_ONLY" ? "read-only-v1"
    : "reversible-write-v1";

  const tools = { ...policy.tools };
  for (const name of toolNames) {
    if (tools[name]) continue;
    tools[name] = {
      enabled: true,
      operation: "call",
      riskClass,
      semanticPolicy: [
        "Only act on the exact resource, recipient, or target the user named.",
        "Do not expand the action beyond what the user explicitly asked for."
      ],
      thresholdProfile: profile
    };
  }
  return { ...policy, tools };
}

/**
 * Strips hard rules from every tool, leaving semantic policy intact.
 *
 * A proxy resolves no deterministic facts — it is a client from the API's
 * perspective — so a policy demanding RBAC or ledger amounts blocks every call
 * it touches. That is safe and useless. Semantic guarding is what a proxy can
 * actually provide; hard rules belong wherever the facts live.
 */
export function semanticOnly(policy: Policy): Policy {
  return {
    ...policy,
    tools: Object.fromEntries(
      Object.entries(policy.tools).map(([name, tool]) => {
        const rest = { ...tool };
        delete rest.hardRules;
        return [name, rest];
      })
    )
  };
}

export interface StdioProxyOptions {
  proxy: ActionGateMcpProxy;
  /** The token the proxy expects. Omit to accept any caller, which is correct
   * only when the client spawns this process and nothing else can reach it. */
  token?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Runs the proxy over stdin and stdout until the stream closes.
 *
 * Authentication is deliberately optional here: a spawned stdio server is
 * reachable only by the process that spawned it, so a bearer token adds nothing
 * a local attacker could not already bypass. Over a network, use the HTTP proxy.
 */
export function runStdioProxy(options: StdioProxyOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input });

  return new Promise((resolve) => {
    lines.on("line", (line) => {
      if (!line.trim()) return;
      void (async () => {
        let request: unknown;
        try {
          request = JSON.parse(line);
        } catch {
          output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          return;
        }
        // A notification has no id and expects no reply.
        const id = (request as { id?: unknown }).id;
        const response = await options.proxy.handle(request, options.token ?? "stdio");
        if (id === undefined || id === null) return;
        output.write(`${JSON.stringify(response)}\n`);
      })();
    });
    lines.on("close", () => resolve());
  });
}
