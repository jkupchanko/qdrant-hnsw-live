import { NextResponse } from "next/server";
import { pushRemoteResult, popRemoteResult } from "@/lib/qdrant";

export const runtime = "nodejs";

/** POST { id, summary } — the booth reports a finished search back. */
export async function POST(req: Request) {
  let body: { id?: number; summary?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.id !== "number" || !body.summary) {
    return NextResponse.json({ error: "Need `id` and `summary`" }, { status: 400 });
  }
  try {
    await pushRemoteResult(body.id, body.summary);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/remote/result] error:", err);
    return NextResponse.json({ error: "store unavailable" }, { status: 500 });
  }
}

/** GET ?id= — the phone polls for its summary (consumes it). */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Need ?id=" }, { status: 400 });
  }
  const summary = await popRemoteResult(id);
  return NextResponse.json({ summary }, { headers: { "cache-control": "no-store" } });
}
