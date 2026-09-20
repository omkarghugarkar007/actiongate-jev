import "dotenv/config";
import { FunctionFactProvider } from "@actiongate/core";
import { ActionGate, ActionBlockedError } from "@actiongate/sdk";

/**
 * Zero infrastructure: no server, no API key, no base URL, no database.
 *
 * Three cases, chosen so the demo is honest whether or not you have a model key:
 * one that should run, one refused by deterministic policy alone, and one that
 * can only be judged by meaning.
 */
const direct = Boolean(process.env.TYPESAFE_API_KEY);
const live = direct || Boolean(process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY);

// Both transactions exist, so the semantic case is refused on meaning rather
// than on a missing record.
const payments = new Map([
  ["txn_5512", { amountCents: 4900, refunded: false }],
  ["txn_9981", { amountCents: 4900, refunded: false }],
  // Genuinely above the policy's $100 limit, so the rules refuse it whatever
  // the model thinks.
  ["txn_bulk", { amountCents: 490_000, refunded: false }]
]);

const gate = ActionGate.embedded({
  // Facts come from local state the agent does not control.
  factProviders: [new FunctionFactProvider({
    name: "local-ledger",
    resolve: ({ request }) => {
      const args = request.proposedAction.arguments as { transactionId?: string; amountCents?: number };
      const payment = payments.get(String(args.transactionId));
      return {
        authenticated: true,
        authorizedByRbac: true,
        duplicate: payment?.refunded ?? false,
        // The ledger's amount, not the caller's: an agent must not be able to
        // understate an amount to slip under a policy limit.
        amountCents: payment?.amountCents ?? Number(args.amountCents ?? 0),
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
const intentFor = (transactionId: string) =>
  transactionId === "txn_bulk" ? "Refund the $4,900 charge on txn_bulk." : said;
const cases = [
  { label: "what the user asked for", args: { transactionId: "txn_5512", amountCents: 4900 }, judged: "either" },
  { label: "above the policy limit", args: { transactionId: "txn_bulk", amountCents: 490_000 }, judged: "rules" },
  { label: "a transaction never named", args: { transactionId: "txn_9981", amountCents: 4900 }, judged: "meaning" }
] as const;

console.log(`\nProvider: ${direct ? "TypeSafe (direct live Jev)" : live ? "OpenRouter (live Jev)" : "deterministic fake — no provider key set"}\n`);

for (const item of cases) {
  // The fake provider cannot judge meaning, so say so rather than letting the
  // result imply the guard does not work.
  if (!live && item.judged === "meaning") {
    console.log(`  skipped   ${item.label} — needs a model; the fake provider answers every semantic question the same way`);
    continue;
  }
  try {
    const result = await refund(item.args, { said: intentFor(item.args.transactionId) });
    console.log(`  EXECUTED  ${item.label} ->`, result);
  } catch (error) {
    if (!(error instanceof ActionBlockedError)) throw error;
    const codes = error.authorization.reasons.map((reason) => reason.code).join(", ");
    console.log(`  refused   ${item.label} -> ${error.authorization.decision} ${codes}`);
  }
}

console.log("\nNo server, no API key, no base URL. Nothing left running.");
if (!live) {
  console.log(
    "\nSet TYPESAFE_API_KEY (direct) or OPENROUTER_API_KEY to judge the third case. Deterministic rules work\n"
    + "without a model, but only a decision model can tell that a refund for a\n"
    + "transaction the user never named is the wrong action.\n"
  );
} else {
  console.log("");
}
