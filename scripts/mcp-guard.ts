import "dotenv/config";
import { DEFAULT_POLICY, type Policy } from "@actiongate/core";
import { ActionGate } from "@actiongate/sdk";
import { ActionGateRegistry } from "@actiongate/proxy-core";
import { ActionGateMcpProxy, PolicyRegistry, StdioMcpUpstream, adoptTools, runStdioProxy, semanticOnly } from "@actiongate/mcp-proxy";
import { readFileSync } from "node:fs";

/**
 * Guard any MCP server by editing your MCP client's config. No code.
 *
 * The client spawns this; this spawns the real server; every tools/call is
 * authorized and its grant consumed in between.
 *
 *   "mcpServers": {
 *     "payments": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/actiongate-jev/scripts/mcp-guard.ts"],
 *       "env": {
 *         "UPSTREAM_COMMAND": "npx",
 *         "UPSTREAM_ARGS": "-y @modelcontextprotocol/server-everything",
 *         "TYPESAFE_API_KEY": "..."
 *       }
 *     }
 *   }
 *
 * Every diagnostic goes to stderr: stdout carries the protocol.
 */
const upstreamCommand = process.env.UPSTREAM_COMMAND;
if (!upstreamCommand) {
  process.stderr.write("UPSTREAM_COMMAND is required: the MCP server this should guard.\n");
  process.exit(1);
}

const loaded: Policy = process.env.ACTIONGATE_POLICY_FILE
  ? JSON.parse(readFileSync(process.env.ACTIONGATE_POLICY_FILE, "utf8")) as Policy
  : DEFAULT_POLICY;

// A proxy resolves no deterministic facts, so hard rules it can never satisfy
// would block every call. Semantic guarding is what it can actually provide.
// Turn this off only when the facts are supplied by a provider on an API server.
const enforceHardRules = process.env.ACTIONGATE_ENFORCE_HARD_RULES === "true";
const shouldAdopt = process.env.ACTIONGATE_ADOPT_UPSTREAM_TOOLS !== "false";
const base = enforceHardRules ? loaded : semanticOnly(loaded);

// With no ActionGate server, the policy is also the registry. That is the right
// trade for a desktop client guarding its own tools and the wrong one for a
// shared deployment, which should point ACTIONGATE_URL at a real server.
const upstream = new StdioMcpUpstream({
  command: upstreamCommand,
  args: (process.env.UPSTREAM_ARGS ?? "").split(" ").filter(Boolean),
  ...(process.env.UPSTREAM_CWD ? { cwd: process.env.UPSTREAM_CWD } : {})
});

// Ask upstream once, then build the policy the registry and the engine share.
const upstreamTools = shouldAdopt ? (await upstream.listTools()).map((tool) => tool.name) : [];
const policy = shouldAdopt
  ? adoptTools(base, upstreamTools, (process.env.ACTIONGATE_DEFAULT_RISK ?? "REVERSIBLE_WRITE") as "REVERSIBLE_WRITE")
  : base;

const hosted = process.env.ACTIONGATE_URL && process.env.ACTIONGATE_API_KEY;
const client = hosted
  ? new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY!, baseUrl: process.env.ACTIONGATE_URL! })
  : ActionGate.embedded({ policy });
const registry = hosted
  ? new ActionGateRegistry({ baseUrl: process.env.ACTIONGATE_URL!, apiKey: process.env.ACTIONGATE_API_KEY! })
  : new PolicyRegistry(policy);

const proxy = new ActionGateMcpProxy({
  client,
  registry,
  upstream,
  // The client spawned this process, so nothing else can reach it.
  resolvePrincipal: async () => ({
    tenantId: process.env.ACTIONGATE_TENANT_ID ?? "local",
    environment: (process.env.ACTIONGATE_ENVIRONMENT ?? "development") as "development" | "staging" | "production",
    actor: { agentId: process.env.ACTIONGATE_AGENT_ID ?? "mcp-client" }
  }),
  serverName: "actiongate-guard"
});

process.stderr.write(
  `ActionGate guarding: ${upstreamCommand} ${process.env.UPSTREAM_ARGS ?? ""}`.trim() + "\n"
  + `  registry:   ${hosted ? "server-owned" : shouldAdopt ? `local policy + ${upstreamTools.length} upstream tools at ${process.env.ACTIONGATE_DEFAULT_RISK ?? "REVERSIBLE_WRITE"}` : "local policy only"}\n`
  + `  hard rules: ${enforceHardRules ? "enforced (supply facts, or every guarded call blocks)" : "off — a proxy resolves no facts; semantic guarding only"}\n`
  + `  provider:   ${process.env.TYPESAFE_API_KEY ? "TypeSafe (direct live Jev)" : process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY ? "OpenRouter (live Jev)" : "deterministic fake — set TYPESAFE_API_KEY or OPENROUTER_API_KEY to judge meaning"}\n`
  + (hosted ? "" : "  note:       an adopted tool's risk class is a guess; set it in a policy file before trusting anything costly\n")
);

await runStdioProxy({ proxy });
upstream.close();
