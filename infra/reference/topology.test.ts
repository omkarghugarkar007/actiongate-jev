import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The reference deployment makes a claim about reachability. These assertions keep
 * that claim true: if someone publishes a port on an internal service, this fails.
 */
const compose = parse(readFileSync(new URL("./docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<string, { ports?: string[]; networks?: string[] }>;
  networks: Record<string, { internal?: boolean } | null>;
};

const INTERNAL_ONLY = ["actiongate", "postgres", "redis", "upstream-tool"];

describe("reference deployment topology", () => {
  it("marks the internal network as unreachable from the host", () => {
    expect(compose.networks.internal?.internal).toBe(true);
  });

  it.each(INTERNAL_ONLY)("keeps %s off the edge network and unpublished", (service) => {
    const definition = compose.services[service];
    expect(definition).toBeDefined();
    expect(definition?.ports ?? []).toEqual([]);
    expect(definition?.networks ?? []).toEqual(["internal"]);
  });

  it("publishes exactly one service, and it is the guarded proxy", () => {
    const published = Object.entries(compose.services).filter(([, definition]) => (definition.ports ?? []).length > 0);
    expect(published.map(([name]) => name)).toEqual(["http-proxy"]);
  });

  it("puts only the proxy on both networks", () => {
    const bridging = Object.entries(compose.services)
      .filter(([, definition]) => (definition.networks ?? []).includes("edge") && (definition.networks ?? []).includes("internal"))
      .map(([name]) => name);
    expect(bridging).toEqual(["http-proxy"]);
  });
});
