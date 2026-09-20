import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxies the audit trail to the API so the ActionGate key stays server-side.
 *
 * No `tenantId` query parameter: the API derives the tenant from the key, and
 * naming a different one is a scope violation rather than a filter.
 */
export async function GET() {
  try {
    const response = await fetch(`${process.env.API_URL ?? "http://localhost:8080"}/v1/decisions`, {
      headers: { Authorization: `Bearer ${process.env.ACTIONGATE_API_KEY ?? "ag_test_local"}` },
      cache: "no-store"
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: { code: "API_UNAVAILABLE" } }, { status: 503 });
  }
}
