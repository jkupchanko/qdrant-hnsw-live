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

export async function loadQueries(): Promise<Query[]> {
  const r = await fetch("/data/queries.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Missing /data/queries.json — run `python scripts/ingest.py`.");
  return r.json();
}
