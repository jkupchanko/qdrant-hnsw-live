import type { Movie, Query } from "./types";

/**
 * Prebuilt data bundles from /public/data. Written by
 * `python scripts/ingest.py`.
 */
export async function loadMovies(): Promise<Movie[]> {
  const r = await fetch("/data/movies.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Missing /data/movies.json — run `python scripts/ingest.py`.");
  return r.json();
}

/**
 * The pipeline's queries.
 *
 * rank-queries.json, not queries.json: every band on the one screen runs the
 * same query, and only these carry the sparse vectors the four-way race needs
 * AND survive the re-ranking check. See scripts/build_rank_queries.py.
 */
export async function loadQueries(): Promise<Query[]> {
  const r = await fetch("/data/rank-queries.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Missing /data/rank-queries.json — run `python scripts/build_rank_queries.py`.");
  return r.json();
}
