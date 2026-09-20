import "dotenv/config";
import { randomUUID } from "node:crypto";
import { ActionGate, ActionBlockedError } from "@actiongate/sdk";

const gate = new ActionGate({ apiKey: process.env.ACTIONGATE_API_KEY ?? "ag_test_local", baseUrl: process.env.API_URL ?? "http://localhost:8080" });
const fakePayments = new Map([["txn_duplicate", { amountCents: 4900, refunded: false }]]);
const refundPayment = async ({ transactionId, amountCents }: { transactionId: string; amountCents: number }) => {
  const payment = fakePayments.get(transactionId);
  if (!payment || payment.amountCents !== amountCents) throw new Error("Mock payment validation failed");
  payment.refunded = true;
  return { transactionId, refunded: true };
};
const protectedRefund = gate.wrapTool({
  name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", execute: refundPayment,
  buildRequest: async ({ input }: { input: { transactionId: string; amountCents: number } }) => ({
    requestId: randomUUID(), idempotencyKey: randomUUID(), tenantId: "tenant-1", environment: "development" as const, mode: "enforce" as const,
    actor: { agentId: "refund-demo" }, userIntent: { text: "Refund the duplicate $49 charge.", source: "user_message" as const },
    deterministicFacts: { authenticated: true, authorizedByRbac: true, duplicate: fakePayments.get(input.transactionId)?.refunded === true, amountCents: input.amountCents, currency: "USD", resourceExists: fakePayments.has(input.transactionId) },
    context: { resources: { transaction: fakePayments.get(input.transactionId) } }
  })
});

try { console.log(await protectedRefund({ transactionId: "txn_duplicate", amountCents: 4900 }, {})); }
catch (error) { if (error instanceof ActionBlockedError) console.error(error.authorization); else throw error; }

