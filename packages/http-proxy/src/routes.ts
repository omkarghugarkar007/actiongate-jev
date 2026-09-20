import type { ProxyRoute, RouteMatch } from "./types.js";

interface CompiledRoute {
  route: ProxyRoute;
  segments: string[];
}

/** Compiles declarative routes once so matching is a plain segment walk. */
export class RouteTable {
  private readonly compiled: CompiledRoute[];

  constructor(routes: readonly ProxyRoute[]) {
    this.compiled = routes.map((route) => {
      if (!route.path.startsWith("/")) throw new Error(`Route path must start with "/": ${route.path}`);
      return { route, segments: splitPath(route.path) };
    });
  }

  match(method: string, path: string): { route: ProxyRoute; params: Record<string, string> } | undefined {
    const actual = splitPath(path);
    const upperMethod = method.toUpperCase();
    for (const { route, segments } of this.compiled) {
      if (route.method !== upperMethod) continue;
      if (segments.length !== actual.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < segments.length; index += 1) {
        const expected = segments[index]!;
        const value = actual[index]!;
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(value);
          continue;
        }
        if (expected !== value) { matched = false; break; }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }
}

/** Default canonical arguments: path params, then query, then a JSON body. */
export function defaultArguments(match: RouteMatch): Record<string, unknown> {
  const body = match.request.body;
  const fromBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { ...match.params, ...match.request.query, ...fromBody };
}

function splitPath(path: string): string[] {
  return path.split("?")[0]!.split("/").filter((segment) => segment.length > 0);
}
