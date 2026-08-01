/**
 * Keyword search that actually ranks.
 *
 * The previous implementation scrolled Qdrant with an AND-ed full-text filter
 * and showed whatever came back. Scroll returns points in id order, so for a
 * common word the "keyword" column was the lowest-id films containing that
 * word, in insertion order, with no relevance involved. That made the
 * side-by-side comparison unfair: keyword search lost because it was crippled,
 * not because keyword search is bad.
 *
 * This is BM25, the ranking function real lexical engines use:
 *
 *   idf(t) = ln(1 + (N - n_t + 0.5) / (n_t + 0.5))
 *   score  = sum_t idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * |d| / avgdl))
 *
 * N and n_t come from Qdrant counts, so the term weights reflect the real
 * collection rather than a guess. Terms are OR-ed, which is what Elasticsearch
 * does by default: a paraphrase returns poorly-ranked matches rather than
 * nothing, which is both more accurate and harder for a booth visitor to
 * dispute.
 *
 * Known limit: Qdrant cannot rank by BM25 without sparse vectors in the
 * collection, so we rank a bounded candidate pool client-side. That is fine at
 * 20K documents and will not hold at millions. The engine-side fix is to store
 * BM25 sparse vectors and fuse them with the dense query server-side.
 */
import { qdrantOn, datasetCollection } from "./qdrant";
import { getDataset } from "./datasets";

const K1 = 1.2;
const B = 0.75;
/** Candidate ceiling. Raising this improves ranking and costs payload transfer. */
const POOL = 2000;
const MAX_TOKENS = 8;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "about", "into", "are",
  "was", "were", "has", "have", "had", "its", "his", "her", "their", "they",
  "you", "your", "who", "whom", "which", "what", "when", "where", "will",
  "movie", "movies", "film", "films", "like", "some", "something", "someone",
]);

export function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ].slice(0, MAX_TOKENS);
}

interface ScrollPoint {
  id: number | string;
  payload?: Record<string, unknown>;
}

function fieldText(payload: Record<string, unknown> | undefined, key: string): string {
  const v = payload?.[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  return "";
}

/** Occurrences of `token` as a whole word. */
function termFreq(haystack: string, token: string): number {
  if (!haystack) return 0;
  let n = 0;
  for (const w of haystack.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w === token) n++;
  return n;
}

export interface LexicalHit {
  id: number;
  payload: Record<string, unknown>;
  score: number;
  /** How many distinct query terms this document contains. */
  matched: number;
}

export interface LexicalResult {
  hits: LexicalHit[];
  /** Qdrant time for the counts + pool fetch. */
  timeMs: number;
  /** Documents in the collection matching at least one term. */
  totalMatching: number;
  /** How many candidates were actually ranked. */
  pooled: number;
  tokens: string[];
  /** True when the pool hit its ceiling, so ranking saw only part of the matches. */
  truncated: boolean;
}

export async function lexicalSearch(params: {
  dataset?: string;
  text: string;
  limit?: number;
}): Promise<LexicalResult> {
  const cfg = getDataset(params.dataset);
  const collection = datasetCollection(params.dataset);
  const limit = params.limit ?? 6;
  const tokens = tokenize(params.text);
  if (tokens.length === 0) {
    return { hits: [], timeMs: 0, totalMatching: 0, pooled: 0, tokens, truncated: false };
  }

  const shouldFor = (token: string) =>
    cfg.lexicalFields.map((f) => ({ key: f.key, match: { text: token } }));
  const allShould = tokens.flatMap(shouldFor);

  let qdrantMs = 0;
  const track = <T extends { time: number }>(r: T) => {
    qdrantMs += r.time * 1000;
    return r;
  };

  // Collection size and per-term document frequency: the inputs to IDF.
  const [total, ...perToken] = await Promise.all([
    qdrantOn<{ result: { count: number }; time: number }>(params.dataset, `/collections/${collection}/points/count`, {
      exact: true,
    }).then(track),
    ...tokens.map((t) =>
      qdrantOn<{ result: { count: number }; time: number }>(params.dataset, `/collections/${collection}/points/count`, {
        filter: { should: shouldFor(t) },
        exact: true,
      }).then(track),
    ),
  ]);

  const N = Math.max(total.result.count, 1);
  const idf = new Map<string, number>();
  tokens.forEach((t, i) => {
    const n = perToken[i].result.count;
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  });

  const [matching, pool] = await Promise.all([
    qdrantOn<{ result: { count: number }; time: number }>(params.dataset, `/collections/${collection}/points/count`, {
      filter: { should: allShould },
      exact: true,
    }).then(track),
    qdrantOn<{ result: { points: ScrollPoint[] }; time: number }>(
      params.dataset,
      `/collections/${collection}/points/scroll`,
      { filter: { should: allShould }, limit: POOL, with_payload: true },
    ).then(track),
  ]);

  const points = pool.result.points;
  // Average document length over the pool, in tokens, weighted the same way
  // the scoring is, so the length normalization is self-consistent.
  const lengths = points.map((p) =>
    cfg.lexicalFields.reduce(
      (sum, f) => sum + fieldText(p.payload, f.key).split(/[^\p{L}\p{N}]+/u).filter(Boolean).length,
      0,
    ),
  );
  const avgdl = Math.max(lengths.reduce((a, b) => a + b, 0) / Math.max(lengths.length, 1), 1);

  const hits: LexicalHit[] = points.map((p, i) => {
    const len = lengths[i];
    let score = 0;
    let matched = 0;
    for (const t of tokens) {
      // Field weights let a title hit count for more than a plot mention,
      // the way a real engine boosts fields.
      let f = 0;
      for (const field of cfg.lexicalFields) {
        f += termFreq(fieldText(p.payload, field.key), t) * field.weight;
      }
      if (f === 0) continue;
      matched++;
      score += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgdl)));
    }
    return { id: Number(p.id), payload: p.payload ?? {}, score, matched };
  });

  hits.sort((a, b) => b.score - a.score || a.id - b.id);

  return {
    hits: hits.filter((h) => h.matched > 0).slice(0, limit),
    timeMs: qdrantMs,
    totalMatching: matching.result.count,
    pooled: points.length,
    tokens,
    truncated: points.length >= POOL,
  };
}
