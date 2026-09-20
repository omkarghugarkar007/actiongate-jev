import {
  authorizeAndConsume,
  findEnabledTool,
  relayedIntent,
  type ActionGateEnforcementClient,
  type ProxyPrincipal,
  type ProxyRegistry
} from "@actiongate/proxy-core";

export interface GuardFunctionOptions {
  client: ActionGateEnforcementClient;
  registry: ProxyRegistry;
  principal: ProxyPrincipal;
  /** The registry tool this function corresponds to. */
  tool: string;
  userIntent?: () => string | undefined;
}

export class ActionRefusedError extends Error {
  constructor(
    public readonly code: string,
    public readonly decision?: string,
    public readonly reasons: { code: string; message: string }[] = []
  ) {
    super(`ActionGate refused the action: ${code}${decision ? ` (${decision})` : ""}`);
    this.name = "ActionRefusedError";
  }
}

/**
 * Wraps a plain async function so it cannot run without an authorized,
 * consumed grant. This is the smallest possible adapter: anything that can be
 * expressed as `(args) => Promise<result>` — a workflow step, a queue consumer,
 * a framework's tool callback — fits.
 *
 * **Guard** level. Keep the wrapped function private; the wrapper is what is
 * protected, not the function it calls.
 */
export function guardFunction<Args extends Record<string, unknown>, Result>(
  execute: (args: Args) => Promise<Result>,
  options: GuardFunctionOptions
): (args: Args) => Promise<Result> {
  return async (args: Args): Promise<Result> => {
    const tool = findEnabledTool(await options.registry.listTools(options.principal), options.tool);
    if (!tool) throw new ActionRefusedError("TOOL_NOT_AVAILABLE");

    const outcome = await authorizeAndConsume(options.client, {
      principal: options.principal,
      tool,
      arguments: args,
      userIntent: relayedIntent(options.userIntent?.(), `No user intent was relayed with this ${options.tool} call.`)
    });

    if (!outcome.ok) {
      if (outcome.kind === "denied") {
        throw new ActionRefusedError("ACTION_DENIED", outcome.decision, outcome.reasons.map((reason) => ({ code: reason.code, message: reason.message })));
      }
      throw new ActionRefusedError(outcome.kind === "no_grant" ? "GRANT_MISSING" : outcome.kind === "consume_failed" ? "GRANT_NOT_CONSUMED" : "ACTIONGATE_UNAVAILABLE");
    }
    return execute(args);
  };
}
