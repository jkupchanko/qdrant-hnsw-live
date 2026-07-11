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

function requireEnv(): { url: string; apiKey: string } {
  const url = process.env[URL_ENV];
  const apiKey = process.env[KEY_ENV];
  if (!url || !apiKey) {
    throw new Error(`${URL_ENV} and ${KEY_ENV} must be set in the environment.`);
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

type MatchCondition = { key: string; match: { value: string | number } };
type Filter = { must?: MatchCondition[]; should?: MatchCondition[]; must_not?: MatchCondition[] };

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
}): Promise<{ points: ScoredPoint[]; timeMs: number }> {
  const res = await qdrant<RestResponse<ScoredPoint[]>>(
    `/collections/${COLLECTION}/points/search`,
    {
      vector: params.vector,
      limit: params.limit ?? 6,
      with_payload: true,
      ...(params.filter ? { filter: params.filter } : {}),
      ...(params.ef ? { params: { hnsw_ef: params.ef } } : {}),
    },
  );
  return { points: res.result, timeMs: res.time * 1000 };
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
