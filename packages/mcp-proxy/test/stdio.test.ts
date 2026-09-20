import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@actiongate/core";
import type { ProxyPrincipal } from "@actiongate/proxy-core";
import { ActionGateMcpProxy, PolicyRegistry, adoptTools, runStdioProxy, semanticOnly, type McpUpstream } from "@actiongate/mcp-proxy";

const PRINCIPAL: ProxyPrincipal = { tenantId: "local", environment: "development", actor: { agentId: "mcp-client" } };

describe("semanticOnly", () => {
  it("removes hard rules a proxy could never satisfy, keeping semantic policy", () => {
    const stripped = semanticOnly(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.tools.refund_payment!.hardRules).toBeDefined();
    expect(stripped.tools.refund_payment!.hardRules).toBeUndefined();
    expect(stripped.tools.refund_payment!.semanticPolicy).toEqual(DEFAULT_POLICY.tools.refund_payment!.semanticPolicy);
    expect(stripped.tools.refund_payment!.riskClass).toBe("FINANCIAL");
  });

  it("leaves the original policy untouched", () => {
    semanticOnly(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.tools.refund_payment!.hardRules?.requireRbac).toBe(true);
  });
});

describe("adoptTools", () => {
  it("adds unknown upstream tools so an arbitrary server is usable", () => {
    const adopted = adoptTools(DEFAULT_POLICY, ["echo", "add"], "READ_ONLY");
    expect(adopted.tools.echo).toMatchObject({ enabled: true, riskClass: "READ_ONLY", thresholdProfile: "read-only-v1" });
    expect(adopted.tools.echo!.semanticPolicy.length).toBeGreaterThan(0);
  });

  it("never overrides a tool the policy already defines", () => {
    const adopted = adoptTools(DEFAULT_POLICY, ["refund_payment"], "READ_ONLY");
    // A guessed risk class must not downgrade an explicitly configured one.
    expect(adopted.tools.refund_payment!.riskClass).toBe("FINANCIAL");
    expect(adopted.tools.refund_payment!.hardRules?.requireRbac).toBe(true);
  });

  it("maps risk class to a matching threshold profile", () => {
    expect(adoptTools(DEFAULT_POLICY, ["a"], "DESTRUCTIVE").tools.a!.thresholdProfile).toBe("destructive-v1");
    expect(adoptTools(DEFAULT_POLICY, ["b"], "FINANCIAL").tools.b!.thresholdProfile).toBe("financial-v1");
    expect(adoptTools(DEFAULT_POLICY, ["c"], "REVERSIBLE_WRITE").tools.c!.thresholdProfile).toBe("reversible-write-v1");
  });

  it("keeps the registry and the policy agreeing on which tools exist", async () => {
    const adopted = adoptTools(DEFAULT_POLICY, ["echo"], "READ_ONLY");
    const names = (await new PolicyRegistry(adopted).listTools(PRINCIPAL)).map((tool) => tool.name);
    expect(names).toContain("echo");
    expect(Object.keys(adopted.tools)).toEqual(expect.arrayContaining(names));
  });
});

describe("runStdioProxy", () => {
  function harness(handle: (request: unknown) => Promise<unknown>) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => { for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(line); });
    const proxy = { handle: vi.fn(handle) } as unknown as ActionGateMcpProxy;
    const done = runStdioProxy({ proxy, input, output });
    return { input, lines, proxy, done };
  }

  const ok = async () => ({ jsonrpc: "2.0" as const, id: 1, result: { ok: true } });

  it("answers a request on stdout", async () => {
    const { input, lines, done } = harness(ok);
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    input.end();
    await done;
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { ok: true } });
  });

  it("writes a parse error rather than crashing the stream", async () => {
    const { input, lines, done } = harness(ok);
    input.write("not json\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    input.end();
    await done;
    expect(JSON.parse(lines[0]!).error.code).toBe(-32700);
    expect(lines).toHaveLength(2);
  });

  it("stays silent for a notification, which expects no reply", async () => {
    const { input, lines, done } = harness(ok);
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end();
    await done;
    // Writing a response to a notification corrupts the protocol.
    expect(lines).toEqual([]);
  });

  it("ignores blank lines", async () => {
    const { input, lines, proxy, done } = harness(ok);
    input.write("\n   \n");
    input.end();
    await done;
    expect(lines).toEqual([]);
    expect(proxy.handle).not.toHaveBeenCalled();
  });

  it("writes one JSON object per line so a client can frame replies", async () => {
    const { input, lines, done } = harness(async (request) => ({ jsonrpc: "2.0" as const, id: (request as { id: number }).id, result: {} }));
    for (const id of [1, 2, 3]) input.write(`{"jsonrpc":"2.0","id":${id},"method":"ping"}\n`);
    input.end();
    await done;
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3]);
  });
});

describe("PolicyRegistry", () => {
  it("exposes the policy's tools with their enabled state", async () => {
    const tools = await new PolicyRegistry(DEFAULT_POLICY).listTools(PRINCIPAL);
    const disabled = tools.find((tool) => tool.name === "delete_record");
    expect(disabled?.enabled).toBe(false);
    expect(tools.find((tool) => tool.name === "refund_payment")?.riskClass).toBe("FINANCIAL");
  });

  it("hides nothing the policy contains, so the engine and registry agree", async () => {
    const tools = await new PolicyRegistry(DEFAULT_POLICY).listTools(PRINCIPAL);
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(DEFAULT_POLICY.tools).sort());
  });
});

// A guarded upstream is never reached when the decision refuses.
describe("stdio guard end to end", () => {
  it("does not call upstream for a tool the policy does not enable", async () => {
    const calls: string[] = [];
    const upstream: McpUpstream = {
      listTools: async () => [{ name: "delete_record" }],
      callTool: async (name) => { calls.push(name); return {}; }
    };
    const proxy = new ActionGateMcpProxy({
      client: { authorize: async () => { throw new Error("should not authorize"); }, consumeGrant: async () => { throw new Error("no"); } } as never,
      registry: new PolicyRegistry(DEFAULT_POLICY),
      upstream,
      resolvePrincipal: async () => PRINCIPAL
    });
    const response = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_record", arguments: {} } }, "stdio");
    expect(response.error?.code).toBe(-32601);
    expect(calls).toEqual([]);
  });
});
