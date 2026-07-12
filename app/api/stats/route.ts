import { NextResponse } from "next/server";
import { getCollectionInfo, getVariantsInfo } from "@/lib/qdrant";

export const runtime = "nodejs";

/** GET /api/stats — live cluster info + all variant collections. */
export async function GET() {
  try {
    const [info, variants] = await Promise.all([getCollectionInfo(), getVariantsInfo()]);
    return NextResponse.json(
      { info, variants },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/stats] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
