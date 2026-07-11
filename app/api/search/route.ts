import { NextResponse } from "next/server";
import { searchByVector } from "@/lib/qdrant";
import type { SearchHit } from "@/lib/types";

export const runtime = "nodejs";

interface Body {
  vector: number[];
  limit?: number;
  ef?: number;
  filter?: {
    genre?: string;
    mood?: string;
  };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.vector) || body.vector.length === 0) {
    return NextResponse.json(
      { error: "Body must include a non-empty `vector` array." },
      { status: 400 },
    );
  }
  const limit = Math.min(Math.max(body.limit ?? 6, 1), 20);

  const must = [] as Array<{ key: string; match: { value: string } }>;
  if (body.filter?.genre) must.push({ key: "genres", match: { value: body.filter.genre } });
  if (body.filter?.mood) must.push({ key: "mood", match: { value: body.filter.mood } });

  try {
    const { points, timeMs } = await searchByVector({
      vector: body.vector,
      limit,
      ef: body.ef,
      filter: must.length ? { must } : undefined,
    });
    const hits: SearchHit[] = points.map((p) => ({
      id: Number(p.id),
      score: p.score,
      payload: p.payload as SearchHit["payload"],
    }));
    return NextResponse.json(
      { hits, serverTimeMs: Math.round(timeMs * 10) / 10 },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/search] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
