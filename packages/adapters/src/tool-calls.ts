import {
  authorizeAndConsume,
  findEnabledTool,
  relayedIntent,
  type ActionGateEnforcementClient,
  type ProxyPrincipal,
  type ProxyRegistry
} from "@actiongate/proxy-core";

/**
 * Adapters for the tool-calling shape most agent frameworks converge on: the
 * model returns a list of named calls with JSON arguments, and the application
 * dispatches them.
 *
 * These are **Guard** integrations. They protect the dispatch path. If the same
 * handler is reachable anywhere else in the process, that path is unguarded, and
 * the adapter's manifest says so.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Frameworks disagree on whether this is a string or an object; both work. */
  arguments: string | Record<string, unknown>;
}

export interface GuardedToolResult {
  id: string;
  name: string;
  /** True only when the handler ran. */
  executed: boolean;
  result?: unknown;
  /** Present when the call was refused, so the model can be told why. */
  refusal?: { code: string; decision?: string; reasons?: { code: string; message: string }[] };
}

export interface GuardToolCallsOptions {
  client: ActionGateEnforcementClient;
  registry: ProxyRegistry;
  principal: ProxyPrincipal;
  /** The user's own words. Relayed evidence, never trusted input. */
  userIntent?: string;
  /** Dispatches a call once it has been authorized and its grant consumed. */
  dispatch(name: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Run calls concurrently. Off by default: a model often emits several calls
   * that each assume the previous one happened, and running them out of order
   * produces side effects the user never described.
   */
  concurrent?: boolean;
}

/**
 * Authorizes and consumes a grant for each proposed call before dispatching it.
 *
 * A refused call does not abort the others: the model gets a per-call refusal it
 * can react to, which is more useful than a single opaque failure. Nothing is
 * dispatched speculatively.
 */
export async function guardToolCalls(
  calls: readonly ToolCall[],
  options: GuardToolCallsOptions
): Promise<GuardedToolResult[]> {
  const run = (call: ToolCall) => guardOne(call, options);
  if (options.concurrent) return Promise.all(calls.map(run));
  const results: GuardedToolResult[] = [];
  for (const call of calls) results.push(await run(call));
  return results;
}

async function guardOne(call: ToolCall, options: GuardToolCallsOptions): Promise<GuardedToolResult> {
  let args: Record<string, unknown>;
  try {
    args = parseArguments(call.arguments);
  } catch {
    return { id: call.id, name: call.name, executed: false, refusal: { code: "INVALID_ARGUMENTS" } };
  }

  const tool = findEnabledTool(await options.registry.listTools(options.principal), call.name);
  // Unknown and disabled look the same, so the model learns nothing from probing.
  if (!tool) return { id: call.id, name: call.name, executed: false, refusal: { code: "TOOL_NOT_AVAILABLE" } };

  const outcome = await authorizeAndConsume(options.client, {
    principal: options.principal,
    tool,
    arguments: args,
    userIntent: relayedIntent(options.userIntent, "No user intent was relayed with this tool call.")
  });

  if (!outcome.ok) {
    if (outcome.kind === "denied") {
      return {
        id: call.id, name: call.name, executed: false,
        refusal: {
          code: "ACTION_DENIED",
          decision: outcome.decision,
          reasons: outcome.reasons.map((reason) => ({ code: reason.code, message: reason.message }))
        }
      };
    }
    return { id: call.id, name: call.name, executed: false, refusal: { code: outcome.kind === "no_grant" ? "GRANT_MISSING" : outcome.kind === "consume_failed" ? "GRANT_NOT_CONSUMED" : "ACTIONGATE_UNAVAILABLE" } };
  }

  // The permit is spent. Dispatch the exact arguments that were authorized.
  const result = await options.dispatch(tool.name, args);
  return { id: call.id, name: call.name, executed: true, result };
}

/**
 * Turns a refusal into a tool result the model can read.
 *
 * Reason codes and messages are safe to show: they are constructed
 * deterministically from rule hits and named signals, never from model prose.
 */
export function toToolMessages(results: readonly GuardedToolResult[]): { tool_call_id: string; role: "tool"; content: string }[] {
  return results.map((result) => ({
    tool_call_id: result.id,
    role: "tool" as const,
    content: JSON.stringify(
      result.executed
        ? { ok: true, result: result.result }
        : { ok: false, refused: result.refusal?.code, decision: result.refusal?.decision, reasons: result.refusal?.reasons }
    )
  }));
}

function parseArguments(value: string | Record<string, unknown>): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}
