import { NextResponse } from "next/server";
import { lexicalSearch } from "@/lib/lexical";

export const runtime = "nodejs";

/** POST { text, limit? } — BM25-ranked keyword search over title and plot. */
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
    const lex = await lexicalSearch({ text: body.text, limit: body.limit ?? 6 });
    return NextResponse.json(
      {
        hits: lex.hits.map((h) => ({
          id: h.id,
          title: String(h.payload.title ?? ""),
          score: h.score,
          matched: h.matched,
          payload: h.payload,
        })),
        totalMatching: lex.totalMatching,
        tokens: lex.tokens,
        serverTimeMs: Math.round(lex.timeMs * 10) / 10,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/keyword] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
