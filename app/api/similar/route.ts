import { NextResponse } from "next/server";
import { recommendById } from "@/lib/qdrant";
import type { SearchHit } from "@/lib/types";

export const runtime = "nodejs";

interface Body {
  id: number;
  limit?: number;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "number") {
    return NextResponse.json({ error: "Body must include numeric `id`" }, { status: 400 });
  }
  const limit = Math.min(Math.max(body.limit ?? 6, 1), 20);

  try {
    const { points } = await recommendById({ positive: [body.id], limit });
    const hits: SearchHit[] = points.map((p) => ({
      id: Number(p.id),
      score: p.score,
      payload: p.payload as SearchHit["payload"],
    }));
    return NextResponse.json({ hits }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/similar] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
