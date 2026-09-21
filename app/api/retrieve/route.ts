import { NextResponse } from "next/server";
import { retrieve, MODE_LABELS, type RetrievalMode, type SparseVector } from "@/lib/qdrant";

export const runtime = "nodejs";

const ALL: RetrievalMode[] = ["dense", "bm25", "minicoil", "hybrid"];

/**
 * The search act, in one call.
 *
 * POST { vector, bm25?, minicoil?, modes?, limit?, ef? }
 *
 * Runs each requested mode against the hybrid collection in parallel and
 * returns them side by side, each with the cluster's own reported time. The
 * screen races them; this is the starter pistol.
 *
 * A mode whose query vector is missing is reported as unavailable rather than
 * quietly dropped — that is how a typed query (dense only, because the
 * browser cannot build a sparse one and this cluster has no Cloud Inference)
 * shows up honestly on screen instead of looking like a failure.
 */
export async function POST(req: Request) {
  let body: {
    vector?: number[];
    bm25?: SparseVector;
    minicoil?: SparseVector;
    modes?: RetrievalMode[];
    limit?: number;
    ef?: number;
    exact?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const modes = (body.modes ?? ALL).filter((m): m is RetrievalMode => ALL.includes(m));
  if (modes.length === 0) {
    return NextResponse.json({ error: "No valid modes requested" }, { status: 400 });
  }
  const limit = Math.min(Math.max(body.limit ?? 6, 1), 20);

  const available = (mode: RetrievalMode): boolean =>
    mode === "dense" ? !!body.vector
      : mode === "bm25" ? !!body.bm25
      : mode === "minicoil" ? !!body.minicoil
      : !!body.vector || !!body.bm25 || !!body.minicoil;

  const results = await Promise.all(
    modes.map(async (mode) => {
      if (!available(mode)) {
        return {
          mode,
          label: MODE_LABELS[mode],
          available: false,
          reason:
            mode === "hybrid"
              ? "Needs at least one query vector"
              : "No sparse vector for this query — typed queries are dense only on this cluster",
          hits: [],
          serverTimeMs: null as number | null,
          arms: [] as string[],
        };
      }
      try {
        const r = await retrieve({
          mode,
          vector: body.vector,
          bm25: body.bm25,
          minicoil: body.minicoil,
          limit,
          ef: body.ef,
          exact: body.exact,
        });
        return {
          mode,
          label: MODE_LABELS[mode],
          available: true,
          reason: null,
          hits: r.points.map((p) => ({ id: Number(p.id), score: p.score, payload: p.payload })),
          serverTimeMs: Math.round(r.timeMs * 10) / 10,
          arms: r.arms,
        };
      } catch (err) {
        return {
          mode,
          label: MODE_LABELS[mode],
          available: false,
          reason: err instanceof Error ? err.message : "Retrieval failed",
          hits: [],
          serverTimeMs: null as number | null,
          arms: [] as string[],
        };
      }
    }),
  );

  return NextResponse.json({ results }, { headers: { "cache-control": "no-store" } });
}
