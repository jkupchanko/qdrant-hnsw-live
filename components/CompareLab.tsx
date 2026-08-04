"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { embedText } from "@/lib/embed";
import { DATASET_META, type DatasetKey, type DisplayPayload } from "@/lib/datasets";
import type { SearchHit } from "@/lib/types";

/**
 * Compare tab: the same query races four retrieval strategies on the SAME
 * live collection, side by side. Every number is measured by the cluster on
 * this request; nothing is staged. Keyword is allowed to win where it should
 * (rare concrete words), which is exactly the setup for why hybrid exists.
 *
 * The dataset is chosen from the registry in lib/datasets.ts. Adding a second
 * entry there (a larger movie collection, say) turns on the switcher above the
 * query bar and re-runs everything against whichever is selected.
 */

type ArmKey = "keyword" | "exact" | "hnsw" | "hybrid";

interface ArmRow {
  id: number;
  payload: DisplayPayload;
  right: string;
}

interface ArmResult {
  ms: number | null;
  rows: ArmRow[];
  /** Documents in the collection matching at least one query term. */
  total?: number;
  note?: string;
  error?: string;
}

interface DatasetStats {
  collection: string;
  points: number;
  indexed: number;
  status: string;
  dim: number;
  distance: string;
  onDisk: boolean;
}

const ARM_META: Record<ArmKey, { title: string; caption: string; accent?: boolean }> = {
  keyword: {
    title: "Keyword",
    caption: "BM25 over title and plot, the ranking function real keyword engines use.",
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

const EXAMPLES: Record<DatasetKey, Array<{ q: string; why: string }>> = {
  movies: [
    { q: "machines becoming self aware", why: "A paraphrase. The plots never use these words." },
    { q: "a heist that goes sideways", why: "Slang. Keyword needs the literal word, meaning does not." },
    { q: "feel good story about an unlikely friendship", why: "Pure intent, zero plot vocabulary." },
    { q: "vampire", why: "One rare concrete word. Keyword wins this one, and that is fine." },
    { q: "scary movie set deep in the ocean", why: "Concept plus setting. Watch the rankings differ." },
  ],
};

const LIMIT = 5;
const LAT_RUNS = 25;

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

/**
 * The tab is a five-step story a person can walk someone through in order.
 * The sticky navigator makes the order explicit instead of leaving a visitor
 * to infer it from a long scroll.
 */
const STEPS = [
  { id: "step-race", n: "01", label: "The Race" },
  { id: "step-faceoff", n: "02", label: "Filtering" },
  { id: "step-tests", n: "03", label: "Prove It" },
  { id: "step-competitors", n: "04", label: "vs Competitors" },
  { id: "step-switch", n: "05", label: "Why Teams Switch" },
];

function StepChip({ n }: { n: string }) {
  return (
    <span className="mr-2 inline-flex h-5 min-w-5 items-center justify-center rounded bg-qdrant-red/15 px-1.5 align-middle text-[10px] font-semibold tabular-nums text-qdrant-red ring-1 ring-qdrant-red/30">
      {n}
    </span>
  );
}

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

interface DatasetHits {
  hits: Array<{ id: number; score: number | null; payload: DisplayPayload }>;
  serverTimeMs: number;
}

function ms(v: number | null | undefined) {
  if (v == null) return "";
  return v < 1 ? "<1 ms" : `${Math.round(v)} ms`;
}

function ResultRow({ row, dim }: { row: ArmRow; dim?: boolean }) {
  return (
    <div
      className={`flex w-full items-center gap-2 rounded bg-white/[0.04] ring-1 ring-white/[0.06] px-2 py-1.5 ${
        dim ? "opacity-65" : ""
      }`}
    >
      <span
        aria-hidden
        className="h-8 w-6 shrink-0 rounded-sm bg-cover bg-center"
        style={{
          background: row.payload.poster
            ? `url(${row.payload.poster}) center/cover`
            : `linear-gradient(140deg, hsl(${row.payload.hue},58%,32%), hsl(${(row.payload.hue + 30) % 360},48%,14%))`,
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-fg-primary/90">{row.payload.title}</span>
        {row.payload.subtitle && (
          <span className="block truncate text-[10px] text-fg-secondary">{row.payload.subtitle}</span>
        )}
      </span>
      <span className="shrink-0 text-[10px] text-fg-secondary">{row.right}</span>
    </div>
  );
}

export function CompareLab({ active }: { active: boolean }) {
  const [dataset, setDataset] = useState<DatasetKey>("movies");
  const cfg = DATASET_META.find((d) => d.key === dataset)!;

  const [stats, setStats] = useState<Partial<Record<DatasetKey, DatasetStats>>>({});
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [ranQuery, setRanQuery] = useState<string | null>(null);
  const [embedMs, setEmbedMs] = useState<number | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [arms, setArms] = useState<Partial<Record<ArmKey, ArmResult>>>({});
  const [error, setError] = useState<string | null>(null);
  const didAutoRun = useRef<Partial<Record<DatasetKey, boolean>>>({});

  const [lastVector, setLastVector] = useState<number[] | null>(null);
  const [filterValue, setFilterValue] = useState(cfg.filterValues[0]);
  const [faceoff, setFaceoff] = useState<{
    native: { ms: number; rows: ArmRow[] };
    post: { ms: number; rows: ArmRow[]; kept: number; fetched: number; depth: number | null };
  } | null>(null);
  const [faceoffRunning, setFaceoffRunning] = useState(false);

  // Live collection sizes for both datasets, so the switcher can show real scale.
  useEffect(() => {
    if (!active) return;
    for (const d of DATASET_META) {
      fetch(`/api/dataset?key=${d.key}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => s && !s.error && setStats((prev) => ({ ...prev, [d.key]: s })))
        .catch(() => {});
    }
  }, [active]);

  const runFaceoff = useCallback(
    async (vector: number[], value: string, ds: DatasetKey) => {
      setFaceoffRunning(true);
      setFaceoff(null);
      try {
        // Both requests hit the same cluster. The second one deliberately runs
        // the way post-filtering architectures work: search first, filter after.
        const [nat, un] = await Promise.all([
          postJson<DatasetHits>("/api/dataset", {
            dataset: ds, vector, limit: LIMIT, ef: 64, filterValue: value,
          }),
          postJson<DatasetHits & { hits: Array<{ id: number; payload: DisplayPayload }> }>("/api/dataset", {
            dataset: ds, vector, limit: 20, ef: 64,
          }),
        ]);
        // Post-filtering can only keep what the unfiltered search happened to
        // return. Match on the full facet list, never the truncated subtitle.
        const matching = un.hits.filter((h) => h.payload.facets.includes(value));
        const kept = matching.slice(0, LIMIT);
        const depth =
          kept.length >= LIMIT ? un.hits.findIndex((h) => h.id === kept[LIMIT - 1].id) + 1 : null;
        setFaceoff({
          native: {
            ms: nat.serverTimeMs,
            rows: nat.hits.map((h) => ({
              id: h.id, payload: h.payload, right: h.score != null ? `${Math.round(h.score * 100)}%` : "",
            })),
          },
          post: {
            ms: un.serverTimeMs,
            rows: kept.map((h) => ({
              id: h.id, payload: h.payload,
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
    },
    [],
  );

  // filterVal is passed in rather than read from state: switching datasets sets
  // both at once, and state updates are not visible to this closure yet.
  const run = useCallback(
    async (text: string, ds: DatasetKey, filterVal?: string) => {
      const clean = text.trim();
      if (!clean) return;
      const conf = DATASET_META.find((d) => d.key === ds)!;
      const faceoffValue = filterVal ?? conf.filterValues[0];
      setQuery(clean);
      setRunning(true);
      setError(null);
      setArms({});
      setEmbedMs(null);
      setFaceoff(null);

      let vector: number[];
      try {
        // Each collection can only be searched with the model it was built
        // with, so the model comes from the dataset config.
        setModelLoading(true);
        const t0 = performance.now();
        vector = await embedText(clean, conf.model);
        setEmbedMs(performance.now() - t0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Embedding failed.");
        setRunning(false);
        setModelLoading(false);
        return;
      }
      setModelLoading(false);
      setRanQuery(clean);

      const finish = (key: ArmKey, result: ArmResult) =>
        setArms((prev) => ({ ...prev, [key]: result }));

      const base = { dataset: ds, limit: LIMIT };

      const keywordP = postJson<DatasetHits & { totalMatching?: number }>("/api/dataset", {
        ...base, mode: "keyword", text: clean,
      })
        .then((d) => {
          finish("keyword", {
            ms: d.serverTimeMs,
            rows: d.hits.map((h) => ({
              id: h.id,
              payload: h.payload,
              right: h.score != null ? h.score.toFixed(1) : "match",
            })),
            total: d.totalMatching,
            note: d.hits.length === 0 ? "No document contains any of these words." : undefined,
          });
          return d.hits;
        })
        .catch((e) => {
          finish("keyword", { ms: null, rows: [], error: String(e.message ?? e) });
          return [] as DatasetHits["hits"];
        });

      const exactP = postJson<DatasetHits>("/api/dataset", { ...base, vector, exact: true })
        .then((d) =>
          finish("exact", {
            ms: d.serverTimeMs,
            rows: d.hits.map((h) => ({
              id: h.id, payload: h.payload, right: h.score != null ? `${Math.round(h.score * 100)}%` : "",
            })),
          }),
        )
        .catch((e) => finish("exact", { ms: null, rows: [], error: String(e.message ?? e) }));

      const hnswP = postJson<DatasetHits>("/api/dataset", { ...base, vector, ef: 64 })
        .then((d) => {
          finish("hnsw", {
            ms: d.serverTimeMs,
            rows: d.hits.map((h) => ({
              id: h.id, payload: h.payload, right: h.score != null ? `${Math.round(h.score * 100)}%` : "",
            })),
          });
          return d.hits;
        })
        .catch((e) => {
          finish("hnsw", { ms: null, rows: [], error: String(e.message ?? e) });
          return [] as DatasetHits["hits"];
        });

      const [kwHits, semHits] = await Promise.all([keywordP, hnswP]);
      await Promise.allSettled([exactP]);

      // Reciprocal Rank Fusion over the two rank lists, computed in the open.
      const K = 60;
      const table = new Map<number, { payload: DisplayPayload; score: number; kw: boolean; sem: boolean }>();
      semHits.forEach((h, i) => {
        table.set(h.id, { payload: h.payload, score: 1 / (K + i + 1), kw: false, sem: true });
      });
      kwHits.forEach((h, i) => {
        const cur = table.get(h.id);
        if (cur) {
          cur.score += 1 / (K + i + 1);
          cur.kw = true;
        } else {
          table.set(h.id, { payload: h.payload, score: 1 / (K + i + 1), kw: true, sem: false });
        }
      });
      finish("hybrid", {
        ms: null,
        rows: [...table.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(0, LIMIT)
          .map(([id, v]) => ({
            id,
            payload: v.payload,
            right: v.kw && v.sem ? "both" : v.sem ? "meaning" : "words",
          })),
      });

      setRunning(false);
      setLastVector(vector);
      runFaceoff(vector, faceoffValue, ds);
    },
    [runFaceoff],
  );

  // First time the tab opens (and on each dataset switch), show the gap immediately.
  useEffect(() => {
    if (active && !didAutoRun.current[dataset]) {
      didAutoRun.current[dataset] = true;
      run(EXAMPLES[dataset][0].q, dataset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, dataset]);

  // Takes a plain string: with a single dataset registered the key union has
  // one member, and comparing it against itself narrows to never.
  function switchDataset(nextKey: string) {
    if (nextKey === dataset || running) return;
    const nextCfg = DATASET_META.find((d) => d.key === nextKey);
    if (!nextCfg) return;
    const next = nextCfg.key as DatasetKey;
    const nextFilter = nextCfg.filterValues[0];
    setDataset(next);
    setFilterValue(nextFilter);
    setLastVector(null);
    setFaceoff(null);
    setArms({});
    setRecallTest(null);
    setLatTest(null);
    setVarTest(null);
    didAutoRun.current[next] = true;
    run(EXAMPLES[next][0].q, next, nextFilter);
  }

  function pickFilter(v: string) {
    if (faceoffRunning) return;
    setFilterValue(v);
    if (lastVector) runFaceoff(lastVector, v, dataset);
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
      const exact = await postJson<DatasetHits>("/api/dataset", {
        dataset, vector: lastVector, limit: 10, exact: true,
      });
      const truth = new Set(exact.hits.map((h) => h.id));
      const efs = [16, 64, 128, 512];
      const runs = await Promise.all(
        efs.map((ef) =>
          postJson<DatasetHits>("/api/dataset", { dataset, vector: lastVector, limit: 10, ef }),
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

  const [latTest, setLatTest] = useState<{ times: number[]; p50: number; p95: number; max: number } | null>(null);
  const [latProgress, setLatProgress] = useState(0);
  const [latRunning, setLatRunning] = useState(false);

  async function runLatencyTest() {
    if (latRunning) return;
    setLatRunning(true);
    setLatTest(null);
    setLatProgress(0);
    try {
      // Precomputed 384-d vectors ship with the corpus bundle.
      const r = await fetch("/data/queries.json", { cache: "force-cache" });
      const qs: Array<{ text: string; vector: number[] }> = await r.json();
      const vectors = qs.map((q) => q.vector);
      const times: number[] = [];
      for (let i = 0; i < LAT_RUNS; i++) {
        const v = vectors[(i * 7 + 3) % vectors.length];
        const d = await postJson<DatasetHits>("/api/dataset", { dataset, vector: v, limit: 5, ef: 64 });
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
    key: string; label: string; ms: number | null; top: string; overlap: number | null;
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
    const baseIds = new Set(results[0].hits.map((h) => h.id));
    setVarTest(
      results.map((r, i) => ({
        key: r.key,
        label: r.label,
        ms: r.ms,
        top: r.hits[0]?.payload?.title ?? "no result",
        overlap: i === 0 ? null : r.hits.filter((h) => baseIds.has(h.id)).length,
      })),
    );
    setVarRunning(false);
  }

  const done = Object.keys(arms).length === 4 && !running;
  const kwEmpty = done && (arms.keyword?.rows.length ?? 0) === 0;
  // How many of the keyword hits the vector side also picked. Zero overlap is
  // the interesting case: keyword found plenty, just not the right things.
  const kwIds = new Set((arms.keyword?.rows ?? []).map((r) => r.id));
  const overlap = (arms.hnsw?.rows ?? []).filter((r) => kwIds.has(r.id)).length;
  const kwTotal = arms.keyword?.total ?? 0;
  const maxMs = Math.max(...Object.values(arms).map((a) => a?.ms ?? 0), 1);
  const activeStats = stats[dataset];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* Step navigator — sticky, so the presenter can jump the story in order */}
      <nav className="sticky top-0 z-30 -mb-2 flex items-center justify-center gap-1.5 rounded-lg card-glass-strong px-3 py-2">
        {STEPS.map(({ id, n, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium text-fg-secondary transition-colors hover:text-fg-primary"
          >
            <span className="tabular-nums text-qdrant-red">{n}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* Dataset switcher */}
      <section id="step-race" className="card scroll-mt-16 p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight-brand text-fg-primary">
              <StepChip n="01" />
              One Query, Four Ways to Search It
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary max-w-[62ch]">
              Every column below runs live against the same collection. The
              latency badge on each column is measured by Qdrant on this exact
              request.
            </p>
          </div>
          {/* Only worth showing once there is something to switch between. */}
          <div
            className={`items-center gap-1 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06] p-1 ${
              DATASET_META.length > 1 ? "flex" : "hidden"
            }`}
          >
            {DATASET_META.map((d) => {
              const s = stats[d.key as DatasetKey];
              return (
                <button
                  key={d.key}
                  type="button"
                  disabled={running}
                  onClick={() => switchDataset(d.key as DatasetKey)}
                  className={`rounded px-4 py-1.5 text-left transition-all disabled:opacity-50 ${
                    dataset === d.key ? "bg-fg-primary text-bg-base" : "text-fg-secondary hover:text-fg-primary"
                  }`}
                >
                  <span className="block text-[13px] font-medium">{d.label}</span>
                  <span className={`block text-[10px] ${dataset === d.key ? "opacity-70" : "opacity-80"}`}>
                    {s ? `${s.points.toLocaleString()} points` : "..."}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {activeStats && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-fg-secondary">
            <span>
              collection <span className="text-fg-primary/85">{activeStats.collection}</span>
            </span>
            <span>
              {activeStats.dim}-d {activeStats.distance}
            </span>
            <span>{cfg.model.replace("Xenova/", "")}</span>
            <span>{activeStats.indexed.toLocaleString()} indexed</span>
            {activeStats.onDisk && <span>vectors on disk</span>}
          </div>
        )}

        <form
          className="mt-5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(query, dataset, filterValue);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={dataset === "movies" ? "Describe a movie in your own words..." : "Describe a product, in any language..."}
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
          {EXAMPLES[dataset].map(({ q, why }) => (
            <button
              key={q}
              type="button"
              title={why}
              disabled={running}
              onClick={() => run(q, dataset, filterValue)}
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
        {modelLoading && (
          <div className="mt-4 text-[12px] text-fg-secondary">
            Loading {cfg.model.replace("Xenova/", "")} in your browser. First use downloads it once.
          </div>
        )}
        {embedMs != null && ranQuery && !modelLoading && (
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
                    {ms(arm.ms)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-secondary">{meta.caption}</p>

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
                  <ResultRow key={`${key}-${row.id}`} row={row} dim={key === "hybrid" && row.right === "words"} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {done && (
        <p className="text-[11.5px] leading-relaxed text-fg-secondary">
          Read the timings honestly. The vector and exact-scan badges are
          Qdrant doing the whole search. The keyword badge is our BM25: several
          round trips for corpus statistics plus scoring outside the engine,
          because ranking lexically inside Qdrant needs BM25 sparse vectors
          stored alongside the dense ones. Compare the result quality here, not
          keyword latency against vector latency.
        </p>
      )}

      {done && (
        <section className="card p-6 ring-1 ring-qdrant-red/25">
          <p className="text-sm leading-relaxed text-fg-primary/90 max-w-[90ch]">
            {kwEmpty ? (
              <>
                <span className="font-semibold text-qdrant-red">What happened: </span>
                not one document contains any of your words, so BM25 had nothing
                to rank. The vector columns still found the right results because
                they search by meaning. Exact scan proves the answer; HNSW gets
                the same answer while touching a fraction of the vectors.
              </>
            ) : overlap === 0 ? (
              <>
                <span className="font-semibold text-qdrant-red">What happened: </span>
                BM25 ranked {kwTotal.toLocaleString()} documents containing your
                words and returned its five best. The vector side picked five
                completely different ones, and none of the keyword results
                survived. Keyword search was not broken here: it did its job
                perfectly and still missed the intent, because term statistics
                cannot tell you what a sentence means.
              </>
            ) : (
              <>
                <span className="font-semibold text-qdrant-red">What happened: </span>
                {overlap} of the top five agree between BM25 and vector search,
                so your wording lines up with the data. This is where keywords
                shine: exact titles and rare terms are cheap and precise. That is
                why Qdrant treats dense vectors, sparse keywords, and filters as
                primitives you combine per query, not an either-or choice.
              </>
            )}
          </p>
        </section>
      )}

      {/* Filtering face-off */}
      {lastVector && (
        <section id="step-faceoff" className="card scroll-mt-16 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
                <StepChip n="02" />
                Filtering Face-Off, Live
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary max-w-[62ch]">
                Same query, same {cfg.filterField} filter, two architectures.
                Pinecone limits filtering to post-filtering or approximate
                filtering, and Weaviate applies filters after the search. Qdrant
                evaluates the filter inside the graph walk itself. Both columns
                run on this cluster so you can watch the difference.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {cfg.filterValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={faceoffRunning}
                  onClick={() => pickFilter(v)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-all ${
                    filterValue === v
                      ? "bg-qdrant-red text-white"
                      : "bg-white/[0.04] ring-1 ring-white/[0.08] text-fg-primary/80 hover:ring-qdrant-red/60"
                  }`}
                >
                  {v}
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
                    {ms(faceoff.native.ms)}
                  </span>
                )}
              </div>
              <div className="mt-2.5 space-y-1">
                {faceoffRunning && (
                  <div className="rounded bg-white/[0.03] px-2 py-3 text-center text-[11px] text-fg-secondary">running...</div>
                )}
                {faceoff?.native.rows.map((row) => <ResultRow key={`fn-${row.id}`} row={row} />)}
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
                    {ms(faceoff.post.ms)}
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
                {faceoff?.post.rows.map((row) => <ResultRow key={`fp-${row.id}`} row={row} />)}
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

      {/* Real tests */}
      <section id="step-tests" className="card scroll-mt-16 p-6">
        <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
          <StepChip n="03" />
          Run Real Tests
        </h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary max-w-[70ch]">
          Benchmarks you run yourself beat benchmarks someone hands you. Each
          test below fires real requests at{" "}
          {activeStats ? `${activeStats.points.toLocaleString()} points` : "this collection"} when
          you press the button, and shows whatever comes back.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
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
                  <span className="w-16 shrink-0 tabular-nums text-fg-primary/85">{ms(recallTest.exactMs)}</span>
                  <span className="h-2 flex-1 rounded-sm bg-white/[0.05] overflow-hidden">
                    <span className="block h-full w-full rounded-sm bg-white/40" />
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-fg-secondary">100%</span>
                </div>
                {recallTest.rows.map(({ ef, ms: t, recall }) => (
                  <div key={ef} className="flex items-center gap-2 text-[11.5px]">
                    <span className="w-16 shrink-0 text-fg-secondary">ef {ef}</span>
                    <span className="w-16 shrink-0 tabular-nums text-fg-primary/85">{ms(t)}</span>
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

          <div className="flex flex-col rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
            <h4 className="text-[14px] font-semibold text-fg-primary">Tail Latency, {LAT_RUNS} Searches</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-secondary">
              Averages hide the slow requests your users feel. Fire {LAT_RUNS}{" "}
              different searches and look at the tail, not the mean.
            </p>
            <button
              type="button"
              onClick={runLatencyTest}
              disabled={latRunning}
              className="mt-3 self-start rounded-lg bg-qdrant-red px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {latRunning ? `Running ${latProgress}/${LAT_RUNS}...` : `Fire ${LAT_RUNS} Searches`}
            </button>
            {latTest && (
              <div className="mt-3">
                <div className="grid grid-cols-3 gap-2">
                  {([["p50", latTest.p50], ["p95", latTest.p95], ["max", latTest.max]] as const).map(([k, v]) => (
                    <div key={k} className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-1.5 text-center">
                      <div className="text-[10px] tracking-wide text-fg-secondary/70">{k}</div>
                      <div className="text-[15px] font-semibold tabular-nums text-fg-primary">
                        {v < 1 ? "<1" : Math.round(v)}
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

          <div className="flex flex-col rounded-lg bg-white/[0.02] ring-1 ring-white/[0.08] p-4">
            <h4 className="text-[14px] font-semibold text-fg-primary">One Corpus, Five Indexes</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-secondary">
              {cfg.hasVariants
                ? "The same 19,907 movies live on this cluster indexed 5 ways. Swapping distance metric or graph density is a routing choice, not a migration."
                : "This dataset has a single index. The movie corpus has five sibling collections with different distance metrics and graph densities."}
            </p>
            <button
              type="button"
              onClick={runVariantTest}
              disabled={!lastVector || varRunning || !cfg.hasVariants}
              className="mt-3 self-start rounded-lg bg-qdrant-red px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
            >
              {!cfg.hasVariants
                ? "Switch to Movies"
                : varRunning
                  ? "Racing..."
                  : lastVector
                    ? "Race the Indexes"
                    : "Run a query first"}
            </button>
            {cfg.hasVariants && varTest && (
              <div className="mt-3 space-y-1.5">
                {varTest.map(({ key, label, ms: t, top, overlap }) => (
                  <div key={key} className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="font-medium text-fg-primary/90">{label}</span>
                      <span className="shrink-0 tabular-nums text-fg-secondary">
                        {t == null ? "error" : ms(t)}
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
      <section id="step-competitors" className="card scroll-mt-16 p-6">
        <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
          <StepChip n="04" />
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

      <div id="step-switch" className="grid scroll-mt-16 grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card p-6">
          <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">
            <StepChip n="05" />
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
              ["Two clusters, one UI", "this tab queries a 20K collection and a 1M collection side by side"],
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
          <h3 className="text-lg font-semibold tracking-tight-brand text-fg-primary">Teams That Made the Switch</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-secondary">
            Published results from teams that migrated production search to Qdrant:
          </p>
          <div className="mt-3 space-y-2">
            {[
              { who: "ConvoSearch", from: "from Pinecone", fact: "Query latency dropped from 50-100 ms to 10 ms after migrating." },
              { who: "Bazaarvoice", from: "from pgvector", fact: "Roughly 100x storage reduction and no more manually managed partitions." },
              { who: "GlassDollar", from: "from Elasticsearch", fact: "Needed to scale search 10x without degrading the experience, then moved." },
              { who: "Lyzr", from: "from Weaviate", fact: "Cut search latency by 90% after seeing 300-500 ms at scale." },
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
