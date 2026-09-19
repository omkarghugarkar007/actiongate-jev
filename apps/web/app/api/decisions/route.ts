import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const response = await fetch(`${process.env.API_URL ?? "http://localhost:8080"}/v1/decisions?tenantId=tenant-1`, {
      headers: { Authorization: `Bearer ${process.env.ACTIONGATE_API_KEY ?? "ag_test_local"}` },
      cache: "no-store"
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: { code: "API_UNAVAILABLE" } }, { status: 503 });
  }
}
