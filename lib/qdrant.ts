/**
 * Thin wrapper over the Qdrant Cloud REST API.
 *
 * We bypass @qdrant/js-client-rest because its URL construction misbehaves
 * with Cloud endpoints (default port 6333 vs 443, and passing host/port/https
 * separately triggers UND_ERR_INVALID_ARG inside undici). Raw fetch to
 * documented REST paths works reliably everywhere.
 */

const URL_ENV = "QDRANT_URL";
const KEY_ENV = "QDRANT_API_KEY";
const COLLECTION_ENV = "QDRANT_COLLECTION";

export const COLLECTION = process.env[COLLECTION_ENV] ?? "movies";

/** Variant collections created by scripts/ingest.py — same data, different index configs. */
export const VARIANTS: Record<string, string> = {
  default: COLLECTION,
  dot: `${COLLECTION}_dot`,
  euclid: `${COLLECTION}_euclid`,
  m4: `${COLLECTION}_m4`,
  m64: `${COLLECTION}_m64`,
};

export function resolveVariant(variant?: string): string {
  return VARIANTS[variant ?? "default"] ?? COLLECTION;
}

function requireEnv(): { url: string; apiKey: string } {
  const url = process.env[URL_ENV];
  const apiKey = process.env[KEY_ENV];
  if (!url || !apiKey) {
    throw new Error(`${URL_ENV} and ${KEY_ENV} must be set in the environment.`);
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

type MatchCondition = { key: string; match: { value: string | number } };
type RangeCondition = { key: string; range: { gte?: number; lte?: number } };
type Condition = MatchCondition | RangeCondition;
type Filter = { must?: Condition[]; should?: Condition[]; must_not?: Condition[] };

async function qdrant<T>(path: string, body: unknown): Promise<T> {
  const { url, apiKey } = requireEnv();
  const r = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(body),
    // Force fresh — this is a query, not cacheable
    cache: "no-store",
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Qdrant ${r.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

interface ScoredPoint {
  id: number | string;
  version?: number;
  score: number;
  payload?: Record<string, unknown>;
}

interface RestResponse<T> {
  result: T;
  status: string;
  time: number;
}

export async function searchByVector(params: {
  vector: number[];
  limit?: number;
  filter?: Filter;
  /** HNSW ef_search — bigger = more candidates checked = higher recall, slower. */
  ef?: number;
  /** exact=true bypasses HNSW entirely: brute-force scan of every vector. */
  exact?: boolean;
  /** Which variant collection to hit (distance / m experiments). */
  variant?: string;
  /** Drop results scoring below this (cosine similarity floor). */
  scoreThreshold?: number;
}): Promise<{ points: ScoredPoint[]; timeMs: number }> {
  const res = await qdrant<RestResponse<ScoredPoint[]>>(
    `/collections/${resolveVariant(params.variant)}/points/search`,
    {
      vector: params.vector,
      limit: params.limit ?? 6,
      with_payload: true,
      ...(params.filter ? { filter: params.filter } : {}),
      ...(params.scoreThreshold != null ? { score_threshold: params.scoreThreshold } : {}),
      params: { ...(params.ef ? { hnsw_ef: params.ef } : {}), exact: params.exact ?? false },
    },
  );
  return { points: res.result, timeMs: res.time * 1000 };
}

export interface CollectionInfo {
  status: string;
  optimizer_status: string | { error: string };
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  config: {
    params: {
      vectors: { size: number; distance: string };
      shard_number: number;
      replication_factor: number;
      on_disk_payload: boolean;
    };
    hnsw_config: {
      m: number;
      ef_construct: number;
      full_scan_threshold: number;
      max_indexing_threads: number;
      on_disk: boolean;
    };
    optimizer_config?: Record<string, unknown>;
  };
  payload_schema?: Record<string, { data_type: string; params?: unknown; points: number }>;
}

/**
 * Honest keyword search: full-text match over descriptions via scroll.
 * Qdrant's text filter requires every token to appear — exactly how a
 * naive keyword engine behaves, which is the point of the comparison.
 */
export async function keywordSearch(params: {
  text: string;
  limit?: number;
}): Promise<{ points: Array<{ id: number | string; payload?: Record<string, unknown> }>; timeMs: number }> {
  const res = await qdrant<RestResponse<{ points: Array<{ id: number | string; payload?: Record<string, unknown> }> }>>(
    `/collections/${COLLECTION}/points/scroll`,
    {
      filter: { must: [{ key: "description", match: { text: params.text } }] },
      limit: params.limit ?? 6,
      with_payload: true,
    },
  );
  return { points: res.result.points, timeMs: res.time * 1000 };
}

/** GET /collections/{name} — status, counts, HNSW config, payload schema. */
export async function getCollectionInfo(): Promise<CollectionInfo> {
  const { url, apiKey } = requireEnv();
  const r = await fetch(`${url}/collections/${COLLECTION}`, {
    method: "GET",
    headers: { "api-key": apiKey },
    cache: "no-store",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Qdrant ${r.status}: ${text.slice(0, 400)}`);
  return (JSON.parse(text) as { result: CollectionInfo }).result;
}

export async function recommendById(params: {
  positive: (number | string)[];
  limit?: number;
}): Promise<{ points: ScoredPoint[]; timeMs: number }> {
  const res = await qdrant<RestResponse<ScoredPoint[]>>(
    `/collections/${COLLECTION}/points/recommend`,
    {
      positive: params.positive,
      limit: params.limit ?? 6,
      with_payload: true,
    },
  );
  return { points: res.result, timeMs: res.time * 1000 };
}
