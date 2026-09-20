import "dotenv/config";
import { FunctionFactProvider } from "@actiongate/core";
import { ActionGate } from "@actiongate/sdk";

/**
 * Zero infrastructure: no server, no API key, no base URL, no database.
 * Just an OpenRouter key and this file.
 */
// Both transactions exist, so the second case is refused on meaning rather than
// on a missing record — which is the point ActionGate is making.
const payments = new Map([
  ["txn_5512", { amountCents: 4900, refunded: false }],
  ["txn_9981", { amountCents: 4900, refunded: false }]
]);

const gate = ActionGate.embedded({
  // Facts come from local state the agent does not control, not from the caller.
  factProviders: [new FunctionFactProvider({
    name: "local-ledger",
    resolve: ({ request }) => {
      const id = String((request.proposedAction.arguments as { transactionId?: string }).transactionId);
      const payment = payments.get(id);
      return {
        authenticated: true,
        authorizedByRbac: true,
        duplicate: payment?.refunded ?? false,
        amountCents: payment?.amountCents ?? 0,
        currency: "USD",
        resourceExists: Boolean(payment)
      };
    }
  })]
});

const refund = gate.wrapTool({
  name: "refund_payment",
  operation: "refund",
  riskClass: "FINANCIAL",
  execute: async (input: { transactionId: string; amountCents: number }) => {
    const payment = payments.get(input.transactionId)!;
    payment.refunded = true;
    return { transactionId: input.transactionId, refunded: true };
  },
  buildRequest: async ({ runtime }) => ({
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    tenantId: "local",
    environment: "development" as const,
    mode: "enforce" as const,
    actor: { agentId: "embedded-agent" },
    userIntent: { text: (runtime as { said: string }).said, source: "user_message" as const }
  })
});

const said = "Refund the duplicate $49 charge on txn_5512.";
for (const [label, args] of [
  ["what the user asked for", { transactionId: "txn_5512", amountCents: 4900 }],
  ["a transaction never named", { transactionId: "txn_9981", amountCents: 4900 }]
] as const) {
  try {
    const result = await refund(args, { said });
    console.log(`  EXECUTED  ${label} ->`, result);
  } catch (error) {
    const decision = (error as { authorization?: { decision: string; reasons: { code: string }[] } }).authorization;
    console.log(`  refused   ${label} -> ${decision?.decision ?? "ERROR"} ${decision?.reasons.map((reason) => reason.code).join(", ") ?? String(error)}`);
  }
}
console.log("\nNo server, no API key, no base URL. Nothing left running.");
