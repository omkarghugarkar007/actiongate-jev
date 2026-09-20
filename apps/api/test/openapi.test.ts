import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeDecisionProvider } from "@actiongate/decision-provider";
import { buildApp } from "../src/app.js";

/**
 * The description is only useful if it matches the server. These assertions fail
 * when a route is added without documenting it, or documented without existing.
 */
const document = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")) as {
  openapi: string;
  info: { version: string };
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, { operationId: string; security?: unknown[]; responses: Record<string, unknown> }>>;
};

/** Fastify prints `:param`; OpenAPI uses `{param}`. */
function normalize(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/\*$/, "").replace(/\/$/, "") || "/";
}

function actualRoutes(): Set<string> {
  const app = buildApp({ provider: FakeDecisionProvider.allow(), apiKey: "ag_doc_test", logger: false });
  const printed = app.printRoutes({ commonPrefix: false });
  void app.close();

  // Fastify prints a tree: each level is a four-character indent, and a node's
  // path is its own segment appended to its ancestors'.
  const routes = new Set<string>();
  const stack: string[] = [];
  for (const line of printed.split("\n")) {
    const match = line.match(/^([\s│├└─]*?)(?:├──|└──)\s(\S*)\s\(([A-Z, ]+)\)\s*$/);
    if (!match) continue;
    const depth = Math.floor(match[1]!.length / 4);
    stack.length = depth;
    stack[depth] = match[2]!;
    const path = stack.slice(0, depth + 1).join("");
    if (path.startsWith("*")) continue;
    for (const method of match[3]!.split(",")) {
      const verb = method.trim().toLowerCase();
      if (verb === "head" || verb === "options") continue;
      routes.add(`${verb} ${normalize(path)}`);
    }
  }
  return routes;
}

const documented = new Set(
  Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`))
);

describe("OpenAPI description", () => {
  it("is a valid 3.1 document with a version and security scheme", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(document.components.securitySchemes.ActionGateKey).toBeDefined();
  });

  it("documents every route the server actually serves", () => {
    const missing = [...actualRoutes()].filter((route) => !documented.has(route)).sort();
    expect(missing).toEqual([]);
  });

  it("documents no route the server does not serve", () => {
    const actual = actualRoutes();
    const phantom = [...documented].filter((route) => !actual.has(route)).sort();
    expect(phantom).toEqual([]);
  });

  it("gives every operation a unique id and at least one response", () => {
    const ids = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.operationId, `${method} ${path}`).toBeTruthy();
        expect(ids.has(operation.operationId), `duplicate operationId ${operation.operationId}`).toBe(false);
        ids.add(operation.operationId);
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      }
    }
  });

  it("requires authentication everywhere except the probes", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const open = path === "/health" || path === "/ready";
        expect((operation.security ?? []).length > 0, `${method} ${path}`).toBe(!open);
      }
    }
  });

  it("resolves every schema reference it uses", () => {
    const refs = [...JSON.stringify(document).matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map((match) => match[1]!);
    for (const ref of new Set(refs)) expect(document.components.schemas[ref], `missing schema ${ref}`).toBeDefined();
  });
});
