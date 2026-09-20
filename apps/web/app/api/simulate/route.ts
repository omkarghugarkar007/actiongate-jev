import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxies the simulator to the API. The ActionGate key stays server-side: the
 * browser never holds a credential that could authorize a real action.
 */
export async function POST(request: Request) {
  try {
    const response = await fetch(`${process.env.API_URL ?? "http://localhost:8080"}/v1/simulate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.ACTIONGATE_API_KEY ?? "ag_test_local"}`,
        "Content-Type": "application/json"
      },
      body: await request.text(),
      cache: "no-store"
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: { code: "API_UNAVAILABLE" } }, { status: 503 });
  }
}
