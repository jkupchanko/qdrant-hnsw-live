"use client";

import { useEffect, useRef, useState } from "react";
import { embedText } from "@/lib/embed";
import type { MoviePayload, SearchHit } from "@/lib/types";

/**
 * Compare tab: the same query races four retrieval strategies on the SAME
 * live collection, side by side. Every number is measured by the cluster on
 * this request; nothing is staged. Keyword is allowed to win where it should
 * (rare concrete words), which is exactly the setup for why hybrid exists.
 */

type ArmKey = "keyword" | "exact" | "hnsw" | "hybrid";

interface ArmRow {
  id: number;
  payload: MoviePayload;
  right: string;
}

interface ArmResult {
  ms: number | null;
  rows: ArmRow[];
  note?: string;
  error?: string;
}

const ARM_META: Record<ArmKey, { title: string; caption: string; accent?: boolean }> = {
  keyword: {
    title: "Keyword",
    caption: "Full-text match on the words you typed. The classic search-engine approach.",
  },
  exact: {
    title: "Exact Scan",
    caption: "Brute force against every vector in the collection. Ground truth, no index.",
  },
  hnsw: {
    title: "Qdrant HNSW",
    caption: "Filtrable HNSW graph walk. Checks a fraction of the vectors, keeps recall high.",
    accent: true,
  },
  hybrid: {
    title: "Hybrid RRF",
    caption: "Dense meaning plus exact words, fused with Reciprocal Rank Fusion.",
  },
};

const EXAMPLES: Array<{ q: string; why: string }> = [
  { q: "machines becoming self aware", why: "A paraphrase. The plots never use these words." },
  { q: "a heist that goes sideways", why: "Slang. Keyword needs the literal word, meaning does not." },
  { q: "feel good story about an unlikely friendship", why: "Pure intent, zero plot vocabulary." },
  { q: "vampire", why: "One rare concrete word. Keyword wins this one, and that is fine." },
  { q: "scary movie set deep in the ocean", why: "Concept plus setting. Watch the rankings differ." },
];

const LIMIT = 5;

const GENRES = ["drama", "sci-fi", "thriller", "comedy", "horror"];

/**
 * Factual architecture differences, sourced from Qdrant's competitive
 * positioning docs. Every number here is a published customer result.
 */
const COMPETITORS: Array<{ name: string; arch: string; diff: string; proof: string }> = [
  {
    name: "Pinecone",
    arch: "Closed SaaS. Filtering is limited to post-filtering or approximate filtering, and index tuning is abstracted away.",
    diff: "Qdrant filters inside the HNSW graph walk and exposes every parameter on this demo's settings card.",
    proof: "Dust cut costs 2x. ConvoSearch went from 50-100 ms to 10 ms.",
  },
  {
    name: "Weaviate",
    arch: "Applies filters after the vector search runs and carries higher memory overhead per vector.",
    diff: "One-stage filtering plus quantization and tiered storage keep recall high on cheaper hardware.",
    proof: "Lyzr saw 300-500 ms at scale, then cut latency by 90%.",
  },
  {
    name: "Elasticsearch and MongoDB",
    arch: "Keyword-first engines with vector search added on top of legacy indexing.",
    diff: "Qdrant is purpose built for vectors: metadata and vector search resolve in one query.",
    proof: "GlassDollar moved when search could not scale 10x. Mixpeek wrote 80% less hybrid search code.",
  },
  {
    name: "pgvector",
    arch: "The common starter choice. At scale it means manual partition management and climbing storage.",
    diff: "Native HNSW, automatic segment management, and multitenancy with a filter key instead of partitions.",
    proof: "Bazaarvoice cut storage roughly 100x and dropped thousands of manual partitions.",
  },
  {
    name: "Milvus and Zilliz",
    arch: "Capable but operationally complex, and metadata filtering is JSON only.",
    diff: "Single container or managed cloud, payload-based filtering, EU-based company.",
    proof: "Kakao, SayOne, and Lettria evaluated Milvus and chose Qdrant.",
  },
];

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error ?? `Request failed (${r.status})`);
  return d as T;
}

export function CompareLab({ active }: { active: boolean }) {
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [ranQuery, setRanQuery] = useState<string | null>(null);
  const [embedMs, setEmbedMs] = useState<number | null>(null);
  const [arms, setArms] = useState<Partial<Record<ArmKey, ArmResult>>>({});
  const [error, setError] = useState<string | null>(null);
  const didAutoRun = useRef(false);

  // Filtering face-off: one-stage filtered search vs the post-filter pipeline.
  const [genre, setGenre] = useState("comedy");
  const [lastVector, setLastVector] = useState<number[] | null>(null);
  const [faceoff, setFaceoff] = useState<{
    native: { ms: number; rows: ArmRow[] };
    post: { ms: number; rows: ArmRow[]; kept: number; fetched: number; depth: number | null };
  } | null>(null);
  const [faceoffRunning, setFaceoffRunning] = useState(false);

  async function runFaceoff(vector: number[], g: string) {
    setFaceoffRunning(true);
    setFaceoff(null);
    try {
      // Both requests hit the same cluster. The second one deliberately runs
      // the way post-filtering architectures work: search first, filter after.
      const [nat, un] = await Promise.all([
        postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
          vector,
          limit: LIMIT,
          ef: 64,
          filter: { genre: g },
        }),
        postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
          vector,
          limit: 20,
          ef: 64,
        }),
      ]);
      const matching = un.hits.filter((h) => h.payload.genres?.includes(g));
      const kept = matching.slice(0, LIMIT);
      const depth =
        kept.length >= LIMIT ? un.hits.findIndex((h) => h.id === kept[LIMIT - 1].id) + 1 : null;
      setFaceoff({
        native: {
          ms: nat.serverTimeMs,
          rows: nat.hits.map((h) => ({
            id: h.id,
            payload: h.payload,
            right: `${Math.round(h.score * 100)}%`,
          })),
        },
        post: {
          ms: un.serverTimeMs,
          rows: kept.map((h) => ({
            id: h.id,
            payload: h.payload,
            right: `rank ${un.hits.findIndex((u) => u.id === h.id) + 1}`,
          })),
          kept: kept.length,
          fetched: un.hits.length,
          depth,
        },
      });
    } catch {
      setFaceoff(null);
    } finally {
      setFaceoffRunning(false);
    }
  }

  function pickGenre(g: string) {
    if (faceoffRunning) return;
    setGenre(g);
    if (lastVector) runFaceoff(lastVector, g);
  }

  // ---- Real tests: every number below is measured on the cluster, on demand.

  const [recallTest, setRecallTest] = useState<{
    exactMs: number;
    rows: Array<{ ef: number; ms: number; recall: number }>;
  } | null>(null);
  const [recallRunning, setRecallRunning] = useState(false);

  async function runRecallTest() {
    if (!lastVector || recallRunning) return;
    setRecallRunning(true);
    setRecallTest(null);
    try {
      // Exact scan is the correct answer by definition. Everything else is
      // scored against it.
      const exact = await postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
        vector: lastVector,
        limit: 10,
        exact: true,
      });
      const truth = new Set(exact.hits.map((h) => h.id));
      const efs = [16, 64, 128, 512];
      const runs = await Promise.all(
        efs.map((ef) =>
          postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
            vector: lastVector,
            limit: 10,
            ef,
          }),
        ),
      );
      setRecallTest({
        exactMs: exact.serverTimeMs,
        rows: runs.map((r, i) => ({
          ef: efs[i],
          ms: r.serverTimeMs,
          recall: r.hits.filter((h) => truth.has(h.id)).length / Math.max(truth.size, 1),
        })),
      });
    } catch {
      setRecallTest(null);
    } finally {
      setRecallRunning(false);
    }
  }

  const LAT_RUNS = 25;
  const [latTest, setLatTest] = useState<{ times: number[]; p50: number; p95: number; max: number } | null>(null);
  const [latProgress, setLatProgress] = useState(0);
  const [latRunning, setLatRunning] = useState(false);

  async function runLatencyTest() {
    if (latRunning) return;
    setLatRunning(true);
    setLatTest(null);
    setLatProgress(0);
    try {
      // Prebuilt query vectors from the corpus bundle: 25 different searches,
      // fired one after another, cluster time recorded for each.
      const r = await fetch("/data/queries.json", { cache: "force-cache" });
      const qs: Array<{ text: string; vector: number[] }> = await r.json();
      const times: number[] = [];
      for (let i = 0; i < LAT_RUNS; i++) {
        const q = qs[(i * 7 + 3) % qs.length];
        const d = await postJson<{ serverTimeMs: number }>("/api/search", {
          vector: q.vector,
          limit: 5,
          ef: 64,
        });
        times.push(d.serverTimeMs);
        setLatProgress(i + 1);
      }
      const sorted = [...times].sort((a, b) => a - b);
      setLatTest({
        times,
        p50: sorted[Math.floor(0.5 * (sorted.length - 1))],
        p95: sorted[Math.floor(0.95 * (sorted.length - 1))],
        max: sorted[sorted.length - 1],
      });
    } catch {
      setLatTest(null);
    } finally {
      setLatRunning(false);
    }
  }

  const INDEX_VARIANTS = [
    { key: "default", label: "Cosine, m 16" },
    { key: "dot", label: "Dot product" },
    { key: "euclid", label: "Euclidean" },
    { key: "m4", label: "Sparse graph, m 4" },
    { key: "m64", label: "Dense graph, m 64" },
  ];
  const [varTest, setVarTest] = useState<Array<{
    key: string;
    label: string;
    ms: number | null;
    top: string;
    overlap: number | null;
  }> | null>(null);
  const [varRunning, setVarRunning] = useState(false);

  async function runVariantTest() {
    if (!lastVector || varRunning) return;
    setVarRunning(true);
    setVarTest(null);
    const results = await Promise.all(
      INDEX_VARIANTS.map((v) =>
        postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
          vector: lastVector!,
          limit: 5,
          ...(v.key !== "default" ? { variant: v.key } : { ef: 64 }),
        })
          .then((d) => ({ ...v, ms: d.serverTimeMs, hits: d.hits }))
          .catch(() => ({ ...v, ms: null, hits: [] as SearchHit[] })),
      ),
    );
    const base = new Set(results[0].hits.map((h) => h.id));
    setVarTest(
      results.map((r, i) => ({
        key: r.key,
        label: r.label,
        ms: r.ms,
        top: r.hits[0]?.payload?.title ?? "no result",
        overlap: i === 0 ? null : r.hits.filter((h) => base.has(h.id)).length,
      })),
    );
    setVarRunning(false);
  }

  async function run(text: string) {
    const clean = text.trim();
    if (!clean || running) return;
    setQuery(clean);
    setRunning(true);
    setError(null);
    setArms({});
    setEmbedMs(null);

    let vector: number[];
    try {
      // Embed once, up front, so each arm's latency is purely its own search.
      const t0 = performance.now();
      vector = await embedText(clean);
      setEmbedMs(performance.now() - t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Embedding failed.");
      setRunning(false);
      return;
    }
    setRanQuery(clean);

    const finish = (key: ArmKey, result: ArmResult) =>
      setArms((prev) => ({ ...prev, [key]: result }));

    const keyword = postJson<{ hits: Array<{ id: number; title: string; payload?: MoviePayload }>; serverTimeMs: number }>(
      "/api/keyword",
      { text: clean, limit: LIMIT },
    )
      .then((d) =>
        finish("keyword", {
          ms: d.serverTimeMs,
          rows: d.hits
            .filter((h) => h.payload)
            .map((h) => ({ id: h.id, payload: h.payload as MoviePayload, right: "match" })),
          note: d.hits.length === 0 ? "Those words never appear in any plot." : undefined,
        }),
      )
      .catch((e) => finish("keyword", { ms: null, rows: [], error: String(e.message ?? e) }));

    const exact = postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
      vector,
      limit: LIMIT,
      exact: true,
    })
      .then((d) =>
        finish("exact", {
          ms: d.serverTimeMs,
          rows: d.hits.map((h) => ({ id: h.id, payload: h.payload, right: `${Math.round(h.score * 100)}%` })),
        }),
      )
      .catch((e) => finish("exact", { ms: null, rows: [], error: String(e.message ?? e) }));

    const hnsw = postJson<{ hits: SearchHit[]; serverTimeMs: number }>("/api/search", {
      vector,
      limit: LIMIT,
      ef: 64,
    })
      .then((d) =>
        finish("hnsw", {
          ms: d.serverTimeMs,
          rows: d.hits.map((h) => ({ id: h.id, payload: h.payload, right: `${Math.round(h.score * 100)}%` })),
        }),
      )
      .catch((e) => finish("hnsw", { ms: null, rows: [], error: String(e.message ?? e) }));

    const hybrid = postJson<{
      hybrid: Array<SearchHit & { kwRank: number | null; semRank: number | null }>;
      serverTimeMs: number;
    }>("/api/hybrid", { vector, text: clean, limit: LIMIT })
      .then((d) =>
        finish("hybrid", {
          ms: d.serverTimeMs,
          rows: d.hybrid.map((h) => ({
            id: h.id,
            payload: h.payload,
            right: h.kwRank && h.semRank ? "both" : h.kwRank ? "kw only" : "sem only",
          })),
        }),
      )
      .catch((e) => finish("hybrid", { ms: null, rows: [], error: String(e.message ?? e) }));

    await Promise.allSettled([keyword, exact, hnsw, hybrid]);
    setRunning(false);
    setLastVector(vector);
    runFaceoff(vector, genre);
  }

  // First time the tab opens, run a query that shows the gap immediately.
  useEffect(() => {
    if (active && !didAutoRun.current) {
      didAutoRun.current = true;
      run(EXAMPLES[0].q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const done = Object.keys(arms).length === 4 && !running;
  const kwEmpty = done && (arms.keyword?.rows.length ?? 0) === 0;
  const maxMs = Math.max(...Object.values(arms).map((a) => a?.ms ?? 0), 1);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* Query bar */}
      <section className="card p-7">
        <h2 className="text-xl font-semibold tracking-tight-brand text-fg-primary">
          One Query, Four Ways to Search It
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary max-w-[62ch]">
          Every column below runs live against the same 20,000 movies on this
          cluster. The latency badge on each column is measured by Qdrant on
          this exact request.
        </p>

        <form
          className="mt-5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(query);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Describe a movie in your own words..."
            className="h-11 flex-1 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08] px-4 text-sm text-fg-primary placeholder:text-fg-secondary/60 outline-none focus:ring-qdrant-red/60"
          />
          <button
            type="submit"
            disabled={running || !query.trim()}
            className="h-11 shrink-0 rounded-lg bg-qdrant-red px-6 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          >
            {running ? "Racing..." : "Race It"}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] tracking-wide text-fg-secondary/70 uppercase">Try</span>
          {EXAMPLES.map(({ q, why }) => (
            <button
              key={q}
              type="button"
              title={why}
              disabled={running}
              onClick={() => run(q)}
              className="rounded-full bg-white/[0.04] ring-1 ring-white/[0.08] px-3 py-1.5 text-[12px] text-fg-primary/85 transition-all hover:ring-qdrant-red/60 disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-4 rounded-lg bg-qdrant-red/10 ring-1 ring-qdrant-red/30 px-4 py-3 text-sm text-fg-primary">
            {error}
          </div>
        )}
        {embedMs != null && ranQuery && (
          <div className="mt-4 text-[12px] text-fg-secondary">
            &ldquo;{ranQuery}&rdquo; embedded in your browser in {Math.round(embedMs)} ms, then sent
            to all four strategies at once.
          </div>
        )}
      </section>

      {/* The four-way race */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {(Object.keys(ARM_META) as ArmKey[]).map((key) => {
          const meta = ARM_META[key];
          const arm = arms[key];
          return (
            <section
              key={key}
              className={`card flex flex-col p-5 ${meta.accent ? "ring-1 ring-qdrant-red/40" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className={`text-base font-semibold tracking-tight-brand ${meta.accent ? "text-qdrant-red" : "text-fg-primary"}`}>
                  {meta.title}
                </h3>
                {arm?.ms != null && (
                  <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-fg-primary">
                    {arm.ms < 1 ? "<1" : Math.round(arm.ms)} ms
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-secondary">{meta.caption}</p>

              {/* Relative latency bar, shared scale across arms */}
              <div className="mt-3 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                {arm?.ms != null && (
                  <div
                    className={`h-full rounded-full ${meta.accent ? "bg-qdrant-red" : "bg-white/40"}`}
                    style={{ width: `${Math.max(4, (arm.ms / maxMs) * 100)}%` }}
                  />
                )}
              </div>

              <div className="mt-3 flex-1 space-y-1">
                {!arm && (
                  <div className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-3 text-center text-[11px] text-fg-secondary">
                    {running ? "running..." : "waiting for a query"}
                  </div>
                )}
                {arm?.error && (
                  <div className="rounded bg-qdrant-red/10 ring-1 ring-qdrant-red/25 px-2 py-2 text-[11px] text-fg-primary/90">
                    {arm.error}
                  </div>
                )}
                {arm && !arm.error && arm.rows.length === 0 && (
                  <div className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-3 text-center text-[11px] text-fg-secondary">
                    {arm.note ?? "no results"}
                  </div>
                )}
                {arm?.rows.map((row) => (
                  <div
                    key={`${key}-${row.id}`}
                    className="flex w-full items-center gap-2 rounded bg-white/[0.04] ring-1 ring-white/[0.06] px-2 py-1.5"
                  >
                    <span
                      aria-hidden
                      className="h-8 w-6 shrink-0 rounded-sm bg-cover bg-center"
                      style={{
                        background: row.payload.poster
                          ? `url(${row.payload.poster}) center/cover`
                          : `linear-gradient(140deg, hsl(${row.payload.hue ?? 220},58%,32%), hsl(${((row.payload.hue ?? 220) + 30) % 360},48%,14%))`,
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-primary/90">
                      {row.payload.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-fg-secondary">{row.right}</span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* The lesson, adapted to what just happened */}
      {done && (
        <section className="card p-6 ring-1 ring-qdrant-red/25">
          <p className="text-sm leading-relaxed text-fg-primary/90 max-w-[90ch]">
            {kwEmpty ? (
              <>
                <span className="font-semibold text-qdrant-red">What happened: </span>
                your words never appear in any plot, so keyword search returned
                nothing. Both vector columns still found the right movies because
                they search by meaning. Exact scan proves the answer; HNSW gets
                the same answer while touching a fraction of the vectors. That
                gap grows with every million points you add.
              </>
            ) : (
              <>
                <span className="font-semibold text-qdrant-red">What happened: </span>
                keyword matched literal words, the vector columns ranked by
                meaning, and hybrid fused both rank lists. When your words match
                the data exactly, keywords are fast and precise. That is why
                Qdrant treats dense vectors, sparse keywords, and filters as
                primitives you combine per query, not an either-or choice.
              </>
            )}
          </p>
        </section>
      )}

      {/* Filtering face-off: the architectural difference, measured live */}
      {lastVector && (
        <section className="card p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
                Filtering Face-Off, Live
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary max-w-[62ch]">
                Same query, same genre filter, two architectures. Pinecone limits
                filtering to post-filtering or approximate filtering, and Weaviate
                applies filters after the search. Qdrant evaluates the filter
                inside the graph walk itself. Both columns run on this cluster so
                you can watch the difference.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {GENRES.map((g) => (
                <button
                  key={g}
                  type="button"
                  disabled={faceoffRunning}
                  onClick={() => pickGenre(g)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-all ${
                    genre === g
                      ? "bg-qdrant-red text-white"
                      : "bg-white/[0.04] ring-1 ring-white/[0.08] text-fg-primary/80 hover:ring-qdrant-red/60"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-lg bg-white/[0.02] ring-1 ring-qdrant-red/40 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-[14px] font-semibold text-qdrant-red">One-Stage Filtering</h4>
                  <p className="mt-0.5 text-[11px] text-fg-secondary">
                    Qdrant walks the graph with the filter applied at every hop.
                  </p>
                </div>
                {faceoff && (
                  <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-fg-primary">
                    {faceoff.native.ms < 1 ? "<1" : Math.round(faceoff.native.ms)} ms
                  </span>
                )}
              </div>
              <div className="mt-2.5 space-y-1">
                {faceoffRunning && (
                  <div className="rounded bg-white/[0.03] px-2 py-3 text-center text-[11px] text-fg-secondary">running...</div>
                )}
                {faceoff?.native.rows.map((row) => (
                  <MovieRow key={`fn-${row.id}`} row={row} />
                ))}
              </div>
              {faceoff && (
                <p className="mt-2.5 text-[11.5px] font-medium text-fg-primary/85">
                  {faceoff.native.rows.length} of {LIMIT} slots filled. Every hit matches the filter.
                </p>
              )}
            </div>

            <div className="rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-[14px] font-semibold text-fg-primary">Post-Filtering Pipeline</h4>
                  <p className="mt-0.5 text-[11px] text-fg-secondary">
                    Search first, discard non-matches after. Run here on the same cluster.
                  </p>
                </div>
                {faceoff && (
                  <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-fg-primary">
                    {faceoff.post.ms < 1 ? "<1" : Math.round(faceoff.post.ms)} ms
                  </span>
                )}
              </div>
              <div className="mt-2.5 space-y-1">
                {faceoffRunning && (
                  <div className="rounded bg-white/[0.03] px-2 py-3 text-center text-[11px] text-fg-secondary">running...</div>
                )}
                {faceoff && faceoff.post.rows.length === 0 && (
                  <div className="rounded bg-white/[0.03] px-2 py-3 text-center text-[11px] text-fg-secondary">
                    none of the top {faceoff.post.fetched} matched the filter
                  </div>
                )}
                {faceoff?.post.rows.map((row) => (
                  <MovieRow key={`fp-${row.id}`} row={row} />
                ))}
              </div>
              {faceoff && (
                <p className="mt-2.5 text-[11.5px] font-medium text-fg-primary/85">
                  {faceoff.post.depth != null
                    ? `Filled ${LIMIT} slots, but had to dig to rank ${faceoff.post.depth} of the unfiltered list.`
                    : `Only ${faceoff.post.kept} of ${LIMIT} slots filled from the top ${faceoff.post.fetched}. The rest silently vanish, or you over-fetch and pay for it.`}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Real tests, run on demand against the live cluster */}
      <section className="card p-6">
        <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
          Run Real Tests
        </h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary max-w-[70ch]">
          Benchmarks you run yourself beat benchmarks someone hands you. Each
          test below fires real requests at this cluster when you press the
          button, and shows whatever comes back.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* Recall vs ground truth */}
          <div className="flex flex-col rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
            <h4 className="text-[14px] font-semibold text-fg-primary">Recall vs Ground Truth</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-secondary">
              Exact scan is the correct answer by definition. Measure how much
              of it HNSW keeps at each ef, and what that costs.
            </p>
            <button
              type="button"
              onClick={runRecallTest}
              disabled={!lastVector || recallRunning}
              className="mt-3 self-start rounded-lg bg-qdrant-red px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {recallRunning ? "Measuring..." : lastVector ? "Measure Recall" : "Run a query first"}
            </button>
            {recallTest && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-16 shrink-0 text-fg-secondary">exact</span>
                  <span className="w-14 shrink-0 tabular-nums text-fg-primary/85">
                    {recallTest.exactMs < 1 ? "<1" : Math.round(recallTest.exactMs)} ms
                  </span>
                  <span className="h-2 flex-1 rounded-sm bg-white/[0.05] overflow-hidden">
                    <span className="block h-full w-full rounded-sm bg-white/40" />
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-fg-secondary">100%</span>
                </div>
                {recallTest.rows.map(({ ef, ms, recall }) => (
                  <div key={ef} className="flex items-center gap-2 text-[11.5px]">
                    <span className="w-16 shrink-0 text-fg-secondary">ef {ef}</span>
                    <span className="w-14 shrink-0 tabular-nums text-fg-primary/85">
                      {ms < 1 ? "<1" : Math.round(ms)} ms
                    </span>
                    <span className="h-2 flex-1 rounded-sm bg-white/[0.05] overflow-hidden">
                      <span
                        className="block h-full rounded-sm bg-qdrant-red"
                        style={{ width: `${Math.max(4, recall * 100)}%` }}
                      />
                    </span>
                    <span className="w-10 shrink-0 text-right tabular-nums text-fg-primary/90">
                      {Math.round(recall * 100)}%
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-[11px] leading-relaxed text-fg-secondary">
                  Recall at 10 against the exact top 10 for your last query.
                  ef is a per-request dial, not a rebuild.
                </p>
              </div>
            )}
          </div>

          {/* Tail latency */}
          <div className="flex flex-col rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
            <h4 className="text-[14px] font-semibold text-fg-primary">Tail Latency, {LAT_RUNS} Searches</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-secondary">
              Averages hide the slow requests your users feel. Fire {LAT_RUNS}
              different searches and look at the tail, not the mean.
            </p>
            <button
              type="button"
              onClick={runLatencyTest}
              disabled={latRunning}
              className="mt-3 self-start rounded-lg bg-qdrant-red px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {latRunning ? `Running ${latProgress}/${LAT_RUNS}...` : "Fire 25 Searches"}
            </button>
            {latTest && (
              <div className="mt-3">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["p50", latTest.p50],
                    ["p95", latTest.p95],
                    ["max", latTest.max],
                  ].map(([k, v]) => (
                    <div key={k as string} className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-1.5 text-center">
                      <div className="text-[10px] tracking-wide text-fg-secondary/70">{k}</div>
                      <div className="text-[15px] font-semibold tabular-nums text-fg-primary">
                        {(v as number) < 1 ? "<1" : Math.round(v as number)}
                        <span className="text-[10px] font-normal text-fg-secondary"> ms</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex h-10 items-end gap-[2px]">
                  {latTest.times.map((t, i) => (
                    <span
                      key={i}
                      className="flex-1 rounded-sm bg-qdrant-red/70"
                      style={{ height: `${Math.max(8, (t / Math.max(latTest.max, 1)) * 100)}%` }}
                      title={`${Math.round(t)} ms`}
                    />
                  ))}
                </div>
                <p className="pt-1.5 text-[11px] leading-relaxed text-fg-secondary">
                  Cluster-reported time per search, in order. Every bar is a
                  real request that just happened.
                </p>
              </div>
            )}
          </div>

          {/* One corpus, five indexes */}
          <div className="flex flex-col rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
            <h4 className="text-[14px] font-semibold text-fg-primary">One Corpus, Five Indexes</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-secondary">
              The same 19,907 movies live on this cluster indexed 5 ways.
              Swapping distance metric or graph density is a routing choice,
              not a migration.
            </p>
            <button
              type="button"
              onClick={runVariantTest}
              disabled={!lastVector || varRunning}
              className="mt-3 self-start rounded-lg bg-qdrant-red px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {varRunning ? "Racing..." : lastVector ? "Race the Indexes" : "Run a query first"}
            </button>
            {varTest && (
              <div className="mt-3 space-y-1.5">
                {varTest.map(({ key, label, ms, top, overlap }) => (
                  <div key={key} className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="font-medium text-fg-primary/90">{label}</span>
                      <span className="shrink-0 tabular-nums text-fg-secondary">
                        {ms == null ? "error" : `${ms < 1 ? "<1" : Math.round(ms)} ms`}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] text-fg-secondary">
                      <span className="min-w-0 truncate">top: {top}</span>
                      {overlap != null && <span className="shrink-0">{overlap}/5 same as cosine</span>}
                    </div>
                  </div>
                ))}
                <p className="pt-1 text-[11px] leading-relaxed text-fg-secondary">
                  Vectors here live on disk. An idle collection pays a one-time
                  warm-up on its first hit, so run the race twice and compare.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Where the architectures differ */}
      <section className="card p-6">
        <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
          Where the Architectures Differ
        </h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary max-w-[70ch]">
          Factual differences, anchored to published customer results. No
          staged benchmarks: the live numbers on this page come from the demo
          cluster you are looking at.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {COMPETITORS.map(({ name, arch, diff, proof }) => (
            <article key={name} className="flex flex-col rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] p-4">
              <h4 className="text-[13.5px] font-semibold text-fg-primary">vs {name}</h4>
              <p className="mt-1.5 text-[12px] leading-relaxed text-fg-secondary">{arch}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-fg-primary/85">
                <span className="font-medium text-qdrant-red">Qdrant: </span>
                {diff}
              </p>
              <p className="mt-auto pt-2 text-[11px] leading-relaxed text-fg-secondary/90 border-t border-white/[0.06]">
                {proof}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Why flexibility wins + who switched */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card p-6">
          <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
            Why Flexibility Wins
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary">
            Different workloads need different retrieval. Everything this demo
            tunes live is a per-query decision in Qdrant, not a re-architecture:
          </p>
          <ul className="mt-3 space-y-1.5 text-[12.5px] text-fg-primary/85">
            {[
              ["ef and exact scan", "trade recall for speed on each request"],
              ["Distance metric and m", "swap collection variants without downtime"],
              ["Payload filters", "filter inside the graph walk, not after it"],
              ["Hybrid RRF and reranking", "add keyword signal or a cross-encoder when a query needs it"],
              ["Multitenancy", "isolate tenants in one collection with one filter key"],
            ].map(([k, v]) => (
              <li key={k} className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-qdrant-red" />
                <span>
                  <span className="font-medium text-fg-primary">{k}.</span> {v}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-fg-secondary">
            Services with a fixed retrieval pipeline make these decisions for
            you at signup. A composable engine lets the problem pick the tool.
          </p>
        </section>

        <section className="card p-6">
          <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
            Teams That Made the Switch
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary">
            Published results from teams that migrated production search to
            Qdrant:
          </p>
          <div className="mt-3 space-y-2">
            {[
              {
                who: "ConvoSearch",
                from: "from Pinecone",
                fact: "Query latency dropped from 50-100 ms to 10 ms after migrating.",
              },
              {
                who: "Bazaarvoice",
                from: "from pgvector",
                fact: "Roughly 100x storage reduction and no more manually managed partitions.",
              },
              {
                who: "GlassDollar",
                from: "from Elasticsearch",
                fact: "Needed to scale search 10x without degrading the experience, then moved.",
              },
              {
                who: "Lyzr",
                from: "from Weaviate",
                fact: "Cut search latency by 90% after seeing 300-500 ms at scale.",
              },
            ].map(({ who, from, fact }) => (
              <div key={who} className="rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] px-3 py-2.5">
                <div className="text-[13px] font-medium text-fg-primary">
                  {who} <span className="ml-1 text-[10px] uppercase tracking-wide text-qdrant-red">{from}</span>
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-fg-secondary">{fact}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function MovieRow({ row }: { row: ArmRow }) {
  return (
    <div className="flex w-full items-center gap-2 rounded bg-white/[0.04] ring-1 ring-white/[0.06] px-2 py-1.5">
      <span
        aria-hidden
        className="h-8 w-6 shrink-0 rounded-sm bg-cover bg-center"
        style={{
          background: row.payload.poster
            ? `url(${row.payload.poster}) center/cover`
            : `linear-gradient(140deg, hsl(${row.payload.hue ?? 220},58%,32%), hsl(${((row.payload.hue ?? 220) + 30) % 360},48%,14%))`,
        }}
      />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-primary/90">{row.payload.title}</span>
      <span className="shrink-0 text-[10px] text-fg-secondary">{row.right}</span>
    </div>
  );
}
