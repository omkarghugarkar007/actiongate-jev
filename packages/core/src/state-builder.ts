import type { AuthorizationRequest } from "./contracts.js";
import type { ToolPolicy } from "./policy.js";

const selectRelevantResource = (resources: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!resources) return {};
  const allowed = ["target", "transaction", "transactions", "order", "recipient", "record", "semanticLabel"];
  return Object.fromEntries(Object.entries(resources).filter(([key]) => allowed.includes(key)));
};

export function buildMinimalState(req: AuthorizationRequest, tool: ToolPolicy) {
  return {
    user_intent: { text: req.userIntent.text, source: req.userIntent.source },
    proposed_action: {
      tool: req.proposedAction.tool,
      operation: req.proposedAction.operation,
      arguments: req.proposedAction.arguments
    },
    relevant_resource: selectRelevantResource(req.context?.resources),
    semantic_policy: { statements: tool.semanticPolicy }
  };
}

