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

async function qdrant<T>(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const { url, apiKey } = requireEnv();
  const r = await fetch(`${url}${path}`, {
    method,
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

export interface VariantInfo {
  key: string;
  name: string;
  status: string;
  points: number;
  distance: string;
  m: number;
}

/** Status + config of every variant collection, for the scaling story. */
export async function getVariantsInfo(): Promise<VariantInfo[]> {
  const { url, apiKey } = requireEnv();
  const out: VariantInfo[] = [];
  await Promise.all(
    Object.entries(VARIANTS).map(async ([key, name]) => {
      try {
        const r = await fetch(`${url}/collections/${name}`, {
          headers: { "api-key": apiKey },
          cache: "no-store",
        });
        if (!r.ok) return;
        const d = (await r.json()) as {
          result: {
            status: string;
            points_count: number;
            config: {
              params: { vectors: { distance: string } };
              hnsw_config: { m: number };
            };
          };
        };
        out.push({
          key,
          name,
          status: d.result.status,
          points: d.result.points_count,
          distance: d.result.config.params.vectors.distance,
          m: d.result.config.hnsw_config.m,
        });
      } catch { /* variant missing — fine */ }
    }),
  );
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/* ── Remote-query queue: Qdrant as a tiny message bus ─────────────
   Phones write query text into a 1-dim dummy collection; the booth
   screen polls and consumes. No extra infrastructure needed. */

const REMOTE = "remote_queries";
const REMOTE_RESULTS = "remote_results";

export interface RemoteOptions {
  ef?: number | null;
  topK?: number;
  genre?: string | null;
  rerank?: boolean;
  hybrid?: boolean;
}

async function ensureTinyCollection(name: string): Promise<void> {
  const { url, apiKey } = requireEnv();
  const r = await fetch(`${url}/collections/${name}`, { headers: { "api-key": apiKey } });
  if (r.ok) return;
  await fetch(`${url}/collections/${name}`, {
    method: "PUT",
    headers: { "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ vectors: { size: 1, distance: "Dot" } }),
  });
}

export async function pushRemoteQuery(text: string, options?: RemoteOptions): Promise<number> {
  await ensureTinyCollection(REMOTE);
  const id = Math.floor(Date.now() % 2147483647);
  await qdrant(`/collections/${REMOTE}/points?wait=true`, {
    points: [{
      id,
      vector: [0],
      payload: { text: text.slice(0, 200), options: options ?? {}, ts: Date.now() },
    }],
  }, "PUT");
  return id;
}

export async function popRemoteQuery(): Promise<{ id: number; text: string; options: RemoteOptions } | null> {
  try {
    const res = await qdrant<RestResponse<{ points: Array<{ id: number; payload?: { text?: string; options?: RemoteOptions } }> }>>(
      `/collections/${REMOTE}/points/scroll`,
      { limit: 5, with_payload: true },
    );
    const points = res.result.points;
    if (!points.length) return null;
    await qdrant(`/collections/${REMOTE}/points/delete?wait=true`, {
      points: points.map((p) => p.id),
    });
    const first = points[0];
    if (!first.payload?.text) return null;
    return { id: first.id, text: first.payload.text, options: first.payload.options ?? {} };
  } catch {
    return null; // collection may not exist yet — nothing queued
  }
}

/** The booth posts a result summary back for the phone that asked. */
export async function pushRemoteResult(id: number, summary: unknown): Promise<void> {
  await ensureTinyCollection(REMOTE_RESULTS);
  await qdrant(`/collections/${REMOTE_RESULTS}/points?wait=true`, {
    points: [{ id, vector: [0], payload: { summary, ts: Date.now() } }],
  }, "PUT");
}

export async function popRemoteResult(id: number): Promise<unknown | null> {
  try {
    const res = await qdrant<RestResponse<Array<{ id: number; payload?: { summary?: unknown } }>>>(
      `/collections/${REMOTE_RESULTS}/points`,
      { ids: [id], with_payload: true },
    );
    const point = res.result[0];
    if (!point?.payload?.summary) return null;
    await qdrant(`/collections/${REMOTE_RESULTS}/points/delete?wait=true`, { points: [id] });
    return point.payload.summary;
  } catch {
    return null;
  }
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
