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
