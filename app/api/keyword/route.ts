import { NextResponse } from "next/server";
import { keywordSearch } from "@/lib/qdrant";

export const runtime = "nodejs";

/** POST { text, limit? } — keyword (full-text) match over descriptions. */
export async function POST(req: Request) {
  let body: { text?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.text) {
    return NextResponse.json({ error: "Body must include `text`" }, { status: 400 });
  }
  try {
    const { points, timeMs } = await keywordSearch({ text: body.text, limit: body.limit ?? 6 });
    const hits = points.map((p) => ({
      id: Number(p.id),
      title: (p.payload as { title?: string })?.title ?? "",
    }));
    return NextResponse.json(
      { hits, serverTimeMs: Math.round(timeMs * 10) / 10 },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/keyword] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
