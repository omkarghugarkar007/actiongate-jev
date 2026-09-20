import Fastify from "fastify";

/**
 * Stands in for a real internal service. It is deliberately naive: it trusts any
 * caller that holds its credential. That is the point — the network topology, not
 * this service, is what makes the guarded path the only way to reach it.
 */
const token = process.env.UPSTREAM_TOKEN ?? "upstream-token";
const app = Fastify({ logger: false });
const refunded = new Set<string>();

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  if (request.headers.authorization !== `Bearer ${token}`) {
    await reply.code(401).send({ error: "upstream credential required" });
  }
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/orders/:orderId", async (request) => ({ orderId: (request.params as { orderId: string }).orderId, status: "SHIPPED" }));
app.post("/refunds", async (request) => {
  const body = request.body as { transactionId?: string; amountCents?: number };
  const id = String(body.transactionId ?? "unknown");
  const duplicate = refunded.has(id);
  refunded.add(id);
  return { transactionId: id, amountCents: body.amountCents ?? 0, refunded: true, duplicate };
});

const port = Number(process.env.PORT ?? 9000);
await app.listen({ port, host: "0.0.0.0" });
console.log(JSON.stringify({ service: "upstream-tool", port }));
