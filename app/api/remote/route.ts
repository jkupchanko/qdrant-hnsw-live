import { NextResponse } from "next/server";
import { pushRemoteQuery, popRemoteQuery } from "@/lib/qdrant";

export const runtime = "nodejs";

/** POST { text } — a phone submits a query for the booth screen. */
export async function POST(req: Request) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "Empty query" }, { status: 400 });
  try {
    await pushRemoteQuery(text);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/remote] push error:", err);
    return NextResponse.json({ error: "queue unavailable" }, { status: 500 });
  }
}

/** GET — the booth polls for the next phone query (consumes it). */
export async function GET() {
  const text = await popRemoteQuery();
  return NextResponse.json({ text }, { headers: { "cache-control": "no-store" } });
}
