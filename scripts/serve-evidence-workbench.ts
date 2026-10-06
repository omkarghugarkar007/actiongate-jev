import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../demos/nvidia-nebius/submission/dist/workbench/", import.meta.url));
const paths: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"], "/recording.json": ["recording.json", "application/json"]
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
  let path: [string, string] | undefined;
  try { path = paths[new URL(request.url ?? "/", "http://localhost").pathname]; }
  catch { response.writeHead(400).end(); return; }
  if (!path) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(resolve(directory, path[0]));
    response.writeHead(200, { "Content-Type": path[1], "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(503).end(); }
});
server.listen(8096, "127.0.0.1", () => console.log("Recorded evidence walkthrough: http://127.0.0.1:8096 (no model calls)"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
