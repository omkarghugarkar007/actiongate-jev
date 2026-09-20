import type { RegistryTool } from "@actiongate/proxy-core";

/**
 * Six guarded domains, each with a fake backend.
 *
 * None of these can cause a real side effect: every backend is in-memory. That
 * is deliberate — an example that can spend money or send mail is a liability
 * in a repository people clone.
 *
 * What each example is really showing is the *shape* of a guarded action: a
 * private handler, a registry tool that owns its risk, and the deterministic
 * facts a server-side provider would supply in a real deployment.
 */
export interface GuardedDomain {
  tool: RegistryTool;
  /** The private handler. In a real system this is what must not be reachable. */
  execute(args: Record<string, unknown>): Promise<unknown>;
  /** A realistic call for the demo. */
  sample: { arguments: Record<string, unknown>; intent: string };
  /** What a trusted server-side fact provider would resolve for this action. */
  facts(args: Record<string, unknown>): Record<string, unknown>;
}

const sent: string[] = [];
const refunded = new Set<string>();
const bookings = new Map<string, string>();
const contacts = new Map<string, Record<string, unknown>>([["c_1", { name: "Alice", tier: "pro" }]]);
const deployments: string[] = [];
const repository = new Map<string, string>([["src/index.ts", "export const value = 1;\n"]]);

export const DOMAINS: Record<string, GuardedDomain> = {
  email: {
    tool: { name: "send_email", operation: "send", riskClass: "EXTERNAL_COMMUNICATION", enabled: true },
    execute: async (args) => { sent.push(String(args.to)); return { delivered: true, to: args.to, sentCount: sent.length }; },
    sample: { arguments: { to: "alice@example.com", body: "Your order 8841 has shipped." }, intent: "Let Alice know her order shipped." },
    facts: () => ({ authenticated: true, destinationAllowlisted: true })
  },

  crm: {
    tool: { name: "update_contact", operation: "update", riskClass: "REVERSIBLE_WRITE", enabled: true },
    execute: async (args) => {
      const id = String(args.contactId);
      contacts.set(id, { ...contacts.get(id), ...(args.fields as Record<string, unknown>) });
      return { contactId: id, contact: contacts.get(id) };
    },
    sample: { arguments: { contactId: "c_1", fields: { tier: "enterprise" } }, intent: "Upgrade Alice to the enterprise tier." },
    facts: (args) => ({ authenticated: true, authorizedByRbac: true, resourceExists: contacts.has(String(args.contactId)) })
  },

  booking: {
    tool: { name: "book_appointment", operation: "create", riskClass: "REVERSIBLE_WRITE", enabled: true },
    execute: async (args) => {
      const slot = String(args.slot);
      if (bookings.has(slot)) return { booked: false, reason: "slot taken" };
      bookings.set(slot, String(args.customerId));
      return { booked: true, slot };
    },
    sample: { arguments: { customerId: "c_1", slot: "2026-10-01T09:00:00Z" }, intent: "Book Alice the 9am slot on the first." },
    facts: (args) => ({ authenticated: true, authorizedByRbac: true, duplicate: bookings.has(String(args.slot)) })
  },

  finance: {
    tool: { name: "refund_payment", operation: "refund", riskClass: "FINANCIAL", enabled: true },
    execute: async (args) => {
      const id = String(args.transactionId);
      refunded.add(id);
      return { transactionId: id, refunded: true };
    },
    sample: { arguments: { transactionId: "txn_5512", amountCents: 4900 }, intent: "Refund the duplicate $49 charge on txn_5512." },
    // The amount comes from the ledger, not from the arguments: a caller must not
    // be able to understate an amount to slip under a policy limit.
    facts: (args) => ({
      authenticated: true,
      authorizedByRbac: true,
      duplicate: refunded.has(String(args.transactionId)),
      amountCents: 4900,
      currency: "USD",
      resourceExists: true
    })
  },

  infrastructure: {
    tool: { name: "deploy_service", operation: "deploy", riskClass: "DESTRUCTIVE", enabled: true },
    execute: async (args) => { deployments.push(`${args.service}@${args.version}`); return { deployed: `${args.service}@${args.version}` }; },
    sample: { arguments: { service: "payments-api", version: "1.4.2", environment: "production" }, intent: "Deploy payments-api 1.4.2 to production." },
    facts: () => ({ authenticated: true, authorizedByRbac: true, resourceExists: true })
  },

  coding: {
    tool: { name: "write_file", operation: "write", riskClass: "REVERSIBLE_WRITE", enabled: true },
    execute: async (args) => {
      const path = String(args.path);
      const previous = repository.get(path);
      repository.set(path, String(args.contents));
      return { path, created: previous === undefined, bytes: String(args.contents).length };
    },
    sample: { arguments: { path: "src/index.ts", contents: "export const value = 2;\n" }, intent: "Change the exported value in src/index.ts to 2." },
    facts: (args) => ({ authenticated: true, authorizedByRbac: true, resourceExists: repository.has(String(args.path)) })
  }
};

export function resetDomains(): void {
  sent.length = 0;
  refunded.clear();
  bookings.clear();
  deployments.length = 0;
  contacts.set("c_1", { name: "Alice", tier: "pro" });
  repository.set("src/index.ts", "export const value = 1;\n");
}

export function sentEmails(): readonly string[] { return sent; }
export function deploymentLog(): readonly string[] { return deployments; }
