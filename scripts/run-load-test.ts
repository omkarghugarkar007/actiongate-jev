const url = process.env.API_URL ?? "http://localhost:8080";
const count = Number(process.argv[2] ?? 20);
const started = performance.now();
const results = await Promise.all(Array.from({ length: count }, async (_, i) => {
  const response = await fetch(`${url}/health`);
  return { i, status: response.status };
}));
console.log({ requests: count, successful: results.filter((x) => x.status === 200).length, totalMs: Math.round(performance.now() - started) });

