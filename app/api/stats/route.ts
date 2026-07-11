import { NextResponse } from "next/server";
import { getCollectionInfo } from "@/lib/qdrant";

export const runtime = "nodejs";

/** GET /api/stats — returns live cluster / collection info. */
export async function GET() {
  try {
    const info = await getCollectionInfo();
    return NextResponse.json(
      { info },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/stats] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
