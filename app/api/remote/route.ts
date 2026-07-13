import { NextResponse } from "next/server";
import { pushRemoteQuery, popRemoteQuery, type RemoteOptions } from "@/lib/qdrant";

export const runtime = "nodejs";

/** POST { text, options? } — a phone submits a query (+ chosen options). */
export async function POST(req: Request) {
  let body: { text?: string; options?: RemoteOptions };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "Empty query" }, { status: 400 });
  try {
    const { id, position } = await pushRemoteQuery(text, body.options);
    return NextResponse.json({ ok: true, id, position });
  } catch (err) {
    console.error("[/api/remote] push error:", err);
    return NextResponse.json({ error: "queue unavailable" }, { status: 500 });
  }
}

/** GET — the booth polls for the next phone query (consumes it). */
export async function GET() {
  const next = await popRemoteQuery();
  return NextResponse.json(next ?? { id: null, text: null }, {
    headers: { "cache-control": "no-store" },
  });
}
