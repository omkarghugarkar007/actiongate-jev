# Guard an MCP server with a config edit

No code. Your MCP client spawns ActionGate, ActionGate spawns the real server,
and every `tools/call` is authorized and its grant consumed in between.

```
MCP client ──spawn──► actiongate guard ──spawn──► the real MCP server
                            │
                            └── decides, then consumes a grant, then forwards
```

## Setup

Clone the repository once, then point your client at it. In Claude Desktop this
is `claude_desktop_config.json`; other clients use the same shape.

```json
{
  "mcpServers": {
    "payments": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/actiongate-jev/scripts/mcp-guard.ts"],
      "env": {
        "UPSTREAM_COMMAND": "npx",
        "UPSTREAM_ARGS": "-y @modelcontextprotocol/server-everything",
        "TYPESAFE_API_KEY": "..."
      }
    }
  }
}
```

Replace `UPSTREAM_COMMAND` and `UPSTREAM_ARGS` with whatever you run today. If
that server is already in your config, move its `command` and `args` here.

Restart the client. ActionGate writes what it is doing to stderr, which your
client shows in its MCP logs:

```
ActionGate guarding: npx -y @modelcontextprotocol/server-everything
  registry:   local policy + 8 upstream tools at REVERSIBLE_WRITE
  hard rules: off — a proxy resolves no facts; semantic guarding only
  provider:   TypeSafe (direct live Jev)
  note:       an adopted tool's risk class is a guess; set it in a policy file before trusting anything costly
```

## What it does, and what it does not

**It refuses an action that does not match what you asked for.** A tool call for
a resource you never named is blocked on meaning, not on a schema check.

**It hides tools you have not allowed.** `tools/list` returns the intersection of
what the upstream offers and what the policy enables, so a tool you disabled is
never described to the model.

**It consumes a single-use permit before forwarding.** Nothing reaches the real
server unless a grant was issued for that exact call and spent.

**It does not judge meaning without a model.** With neither `TYPESAFE_API_KEY`
nor `OPENROUTER_API_KEY` the
deterministic fake provider answers every semantic question the same way, so the
guard falls back to rules alone. It says so on startup.

**It does not enforce hard rules by default.** RBAC, spend limits, and duplicate
checks need facts a proxy cannot resolve — it is a client, not your application.
A policy demanding them would block every call it touches, which is safe and
useless. Set `ACTIONGATE_ENFORCE_HARD_RULES=true` only when the facts come from
a [fact provider](integrations.md#trusted-facts) on an API server.

**Adopted risk classes are guesses.** Tools the policy does not mention are
adopted at `REVERSIBLE_WRITE` so an arbitrary server works out of the box. That
is a default, not a judgement about your tools.

**It is not a boundary against your own machine.** The policy lives in the
process your client spawned. Anything that can edit that policy, or call the
upstream server directly, is unguarded. For a boundary an agent cannot reach,
run the [API server](../infra/reference/README.md) and point this at it.

## Tightening it

Write the tools down rather than letting them be adopted:

```bash
ACTIONGATE_POLICY_FILE=/path/to/policy.json
ACTIONGATE_ADOPT_UPSTREAM_TOOLS=false
```

A policy file is the same shape as the bundled default — see
`packages/core/src/policy.ts`. Give each tool its real risk class and a line of
semantic policy describing what it may and may not do.

Point at a server so the registry is somewhere the agent cannot edit:

```bash
ACTIONGATE_URL=https://actiongate.internal
ACTIONGATE_API_KEY=agk_...
```

## Settings

| Variable | Meaning |
|---|---|
| `UPSTREAM_COMMAND` | The MCP server to guard. Required. |
| `UPSTREAM_ARGS` | Space-separated arguments for it. |
| `UPSTREAM_CWD` | Working directory for the upstream server. |
| `TYPESAFE_API_KEY` | Enables semantic judgement through the direct TypeSafe API. Takes precedence in embedded mode. |
| `OPENROUTER_API_KEY` | Alternative Jev access through OpenRouter. Without either provider key, rules only. |
| `ACTIONGATE_POLICY_FILE` | A policy JSON file, replacing the bundled default. |
| `ACTIONGATE_ADOPT_UPSTREAM_TOOLS` | `false` to guard only tools the policy names. |
| `ACTIONGATE_DEFAULT_RISK` | Risk class for adopted tools. Defaults to `REVERSIBLE_WRITE`. |
| `ACTIONGATE_ENFORCE_HARD_RULES` | `true` only when a fact provider supplies RBAC and amounts. |
| `ACTIONGATE_URL`, `ACTIONGATE_API_KEY` | Use a server's registry instead of a local policy. |
