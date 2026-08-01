import { NextResponse } from "next/server";
import { searchByVector } from "@/lib/qdrant";
import { lexicalSearch } from "@/lib/lexical";

export const runtime = "nodejs";

/**
 * Hybrid retrieval with Reciprocal Rank Fusion.
 * Dense: Qdrant vector search, ranked by cosine.
 * Lexical: BM25 over title and plot (see lib/lexical.ts).
 * Fusion: RRF with k=60 over both rank lists.
 *
 * The lexical arm used to rank by raw query-token overlap, tie-broken by
 * shorter document first, over whatever scroll returned in id order. Both the
 * candidate selection and the ordering were arbitrary, which quietly rigged
 * every hybrid comparison against the keyword side.
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

  try {
    const [dense, lex] = await Promise.all([
      searchByVector({ vector: body.vector, limit: 20 }),
      lexicalSearch({ text: body.text, limit: 20 }),
    ]);
    // Both sub-searches run in parallel on the cluster, so the honest figure is
    // the slower of the two, not our wall clock (which includes round trips).
    const clusterMs = Math.max(dense.timeMs, lex.timeMs);

    const K = 60;
    const rrf = new Map<
      number,
      { score: number; payload: unknown; kwRank: number | null; semRank: number | null }
    >();
    dense.points.forEach((p, i) => {
      rrf.set(Number(p.id), { score: 1 / (K + i + 1), payload: p.payload, kwRank: null, semRank: i + 1 });
    });
    lex.hits.forEach((h, i) => {
      const cur = rrf.get(h.id);
      if (cur) {
        cur.score += 1 / (K + i + 1);
        cur.kwRank = i + 1;
      } else {
        rrf.set(h.id, { score: 1 / (K + i + 1), payload: h.payload, kwRank: i + 1, semRank: null });
      }
    });
    const hybrid = [...rrf.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id, v]) => ({ id, score: v.score, payload: v.payload, kwRank: v.kwRank, semRank: v.semRank }));

    return NextResponse.json(
      {
        kw: lex.hits.slice(0, limit).map((h) => ({ id: h.id, payload: h.payload, matches: h.matched })),
        kwTotal: lex.totalMatching,
        sem: dense.points.slice(0, limit).map((p) => ({ id: Number(p.id), score: p.score, payload: p.payload })),
        hybrid,
        serverTimeMs: Math.round(clusterMs * 10) / 10,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/hybrid] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
