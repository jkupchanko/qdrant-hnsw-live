import { NextResponse } from "next/server";
import { searchDataset, keywordDataset, datasetInfo } from "@/lib/qdrant";
import { getDataset, toDisplay, type DatasetKey } from "@/lib/datasets";

export const runtime = "nodejs";

/** GET /api/dataset?key=products — live size and config of that collection. */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "movies";
  try {
    return NextResponse.json(await datasetInfo(key), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface Body {
  dataset?: DatasetKey;
  /** "vector" | "keyword" */
  mode?: string;
  vector?: number[];
  text?: string;
  limit?: number;
  ef?: number;
  exact?: boolean;
  /** Value for this dataset's filterField (genre / category). */
  filterValue?: string;
}

/** POST /api/dataset — vector or keyword search against any configured dataset. */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cfg = getDataset(body.dataset);
  const limit = Math.min(Math.max(body.limit ?? 5, 1), 20);

  try {
    if (body.mode === "keyword") {
      if (!body.text) {
        return NextResponse.json({ error: "Keyword mode needs `text`" }, { status: 400 });
      }
      const { points, timeMs } = await keywordDataset({
        dataset: cfg.key,
        text: body.text,
        limit,
      });
      return NextResponse.json(
        {
          dataset: cfg.key,
          hits: points.map((p) => ({
            id: Number(p.id),
            score: null,
            payload: toDisplay(p.payload, cfg.key),
          })),
          serverTimeMs: Math.round(timeMs * 10) / 10,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      return NextResponse.json({ error: "Body must include a non-empty `vector`" }, { status: 400 });
    }
    // A vector from the wrong model would still "work" and return nonsense, so
    // fail loudly instead.
    if (body.vector.length !== cfg.dim) {
      return NextResponse.json(
        { error: `${cfg.label} expects ${cfg.dim}-d vectors, got ${body.vector.length}. Wrong embedding model.` },
        { status: 400 },
      );
    }

    const { points, timeMs } = await searchDataset({
      dataset: cfg.key,
      vector: body.vector,
      limit,
      ef: body.ef,
      exact: body.exact,
      ...(body.filterValue
        ? { filter: { must: [{ key: cfg.filterField, match: { value: body.filterValue } }] } }
        : {}),
    });
    return NextResponse.json(
      {
        dataset: cfg.key,
        hits: points.map((p) => ({
          id: Number(p.id),
          score: p.score,
          payload: toDisplay(p.payload, cfg.key),
        })),
        serverTimeMs: Math.round(timeMs * 10) / 10,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/dataset] error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
