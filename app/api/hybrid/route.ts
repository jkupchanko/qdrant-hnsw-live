import { NextResponse } from "next/server";
import { searchByVector, keywordSearch } from "@/lib/qdrant";

export const runtime = "nodejs";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "about", "into", "movies", "movie", "films", "film", "like"]);

function tokens(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)))];
}

/**
 * Hybrid retrieval with Reciprocal Rank Fusion.
 * Dense: Qdrant vector search (ranked by cosine).
 * Lexical: Qdrant full-text scroll, ranked here by query-token overlap.
 * Fusion: RRF with k=60 over both rank lists.
 */
export async function POST(req: Request) {
  let body: { vector?: number[]; text?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.vector) || !body.text) {
    return NextResponse.json({ error: "Need `vector` and `text`" }, { status: 400 });
  }
  const limit = Math.min(Math.max(body.limit ?? 6, 1), 10);
  const qTokens = tokens(body.text);

  try {
    const t0 = performance.now();
    const [dense, kwRaw] = await Promise.all([
      searchByVector({ vector: body.vector, limit: 20 }),
      keywordSearch({ text: body.text, limit: 50 }),
    ]);

    // Lexical ranking: unique query tokens matched, then shorter docs first.
    const kwRanked = kwRaw.points
      .map((p) => {
        const desc = String((p.payload as { description?: string })?.description ?? "").toLowerCase();
        const matches = qTokens.filter((t) => desc.includes(t)).length;
        return { id: Number(p.id), payload: p.payload, matches, len: desc.length };
      })
      .sort((a, b) => b.matches - a.matches || a.len - b.len);

    // RRF fusion over the two rank lists.
    const K = 60;
    const rrf = new Map<number, { score: number; payload: unknown; kwRank: number | null; semRank: number | null }>();
    dense.points.forEach((p, i) => {
      rrf.set(Number(p.id), { score: 1 / (K + i + 1), payload: p.payload, kwRank: null, semRank: i + 1 });
    });
    kwRanked.forEach((p, i) => {
      const cur = rrf.get(p.id);
      if (cur) {
        cur.score += 1 / (K + i + 1);
        cur.kwRank = i + 1;
      } else {
        rrf.set(p.id, { score: 1 / (K + i + 1), payload: p.payload, kwRank: i + 1, semRank: null });
      }
    });
    const hybrid = [...rrf.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id, v]) => ({ id, score: v.score, payload: v.payload, kwRank: v.kwRank, semRank: v.semRank }));

    return NextResponse.json({
      kw: kwRanked.slice(0, limit).map((p) => ({ id: p.id, payload: p.payload, matches: p.matches })),
      kwTotal: kwRaw.points.length,
      sem: dense.points.slice(0, limit).map((p) => ({ id: Number(p.id), score: p.score, payload: p.payload })),
      hybrid,
      serverTimeMs: Math.round((performance.now() - t0) * 10) / 10,
    }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/hybrid] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
