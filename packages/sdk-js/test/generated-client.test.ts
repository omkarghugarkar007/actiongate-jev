import { describe, expect, it, vi } from "vitest";
import { ActionGateApiClient } from "@actiongate/sdk";

/** The generated client exists to stay in step with the description, so these
 * assertions check the contract it was generated from, not hand-written code. */
function clientWith(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: parsed, init });
    return handler(parsed, init);
  });
  const client = new ActionGateApiClient({ baseUrl: "https://gate.example", apiKey: "agk_test", fetch: fetchMock as unknown as typeof fetch });
  return { client, calls };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });

describe("generated API client", () => {
  it("carries the API version it was generated from", () => {
    expect(ActionGateApiClient.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("sends the key as a bearer token and parses JSON", async () => {
    const { client, calls } = clientWith(ok);
    const result = await client.postAuthorize({ requestId: "r" });
    expect(result).toMatchObject({ status: 200, ok: true, data: { ok: true } });
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer agk_test");
    expect(calls[0]?.url.pathname).toBe("/v1/authorize");
  });

  it("escapes path parameters rather than interpolating them raw", async () => {
    const { client, calls } = clientWith(ok);
    await client.getDecisionsById("../../etc/passwd");
    expect(calls[0]?.url.pathname).toBe("/v1/decisions/..%2F..%2Fetc%2Fpasswd");
  });

  it("appends query parameters only when supplied", async () => {
    const { client, calls } = clientWith(ok);
    await client.getExecutions({ decisionId: "abc" });
    await client.getExecutions();
    expect(calls[0]?.url.search).toBe("?decisionId=abc");
    expect(calls[1]?.url.search).toBe("");
  });

  it("returns a failed status rather than throwing, so callers handle denials", async () => {
    const { client } = clientWith(() => new Response(JSON.stringify({ error: { code: "ACTION_DENIED" } }), { status: 403 }));
    const result = await client.postGrantsConsume({ token: "t" });
    expect(result).toMatchObject({ status: 403, ok: false, data: { error: { code: "ACTION_DENIED" } } });
  });

  it("exposes an operation for every documented one", async () => {
    const { paths } = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"))
    ) as { paths: Record<string, Record<string, { operationId: string }>> };
    const client = new ActionGateApiClient({ baseUrl: "https://gate.example", apiKey: "k" });
    for (const operations of Object.values(paths)) {
      for (const operation of Object.values(operations)) {
        expect(typeof (client as unknown as Record<string, unknown>)[operation.operationId], operation.operationId).toBe("function");
      }
    }
  });
});
