"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { posterSrc } from "@/lib/poster";
import type { Query, MoviePayload } from "@/lib/types";

/**
 * ACT TWO — one question, four ways to find it.
 *
 * The part of the pipeline the old demo could not honestly show. Every column
 * here is a real request against the hybrid collection: dense against the
 * HNSW graph, BM25 and miniCOIL against real sparse indexes, and hybrid as a
 * single Query API call that lets Qdrant fuse all three server-side.
 *
 * Built for a screen across a room, so: four columns, four times, four short
 * lists, one sentence saying what happened. The interesting part is which
 * searches voted for each fused result, so the fused column carries that.
 */

type ModeKey = "dense" | "bm25" | "minicoil" | "hybrid";

interface ApiHit {
  id: number;
  score: number;
  payload: MoviePayload;
}

interface ApiResult {
  mode: ModeKey;
  label: string;
  available: boolean;
  reason: string | null;
  hits: ApiHit[];
  serverTimeMs: number | null;
  arms: string[];
}

const COLUMNS: Array<{ key: ModeKey; title: string; lead: string; accent: string }> = [
  {
    key: "bm25",
    title: "Keywords",
    lead: "The exact words you typed",
    accent: "#03A9F4",
  },
  {
    key: "minicoil",
    title: "Smart keywords",
    lead: "Words, with the right sense",
    accent: "#009688",
  },
  {
    key: "dense",
    title: "Meaning",
    lead: "What the sentence means",
    accent: "#6047FF",
  },
  {
    key: "hybrid",
    title: "All three, fused",
    lead: "All three, merged by Qdrant",
    accent: "#DC244C",
  },
];

const DWELL_MS = 13000;

export function SearchAct({ queries }: { queries: Query[] }) {
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<ApiResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  // Only queries carrying sparse vectors can run the full race.
  const runnable = queries.filter((q) => q.bm25 && q.minicoil);
  const query = runnable.length > 0 ? runnable[idx % runnable.length] : null;

  useEffect(() => {
    if (!query) return;
    const ticket = ++reqRef.current;
    setLoading(true);
    setError(null);
    fetch("/api/retrieve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vector: query.vector,
        bm25: query.bm25,
        minicoil: query.minicoil,
        limit: 10,
      }),
    })
      .then((r) => r.json())
      .then((d: { results?: ApiResult[]; error?: string }) => {
        if (ticket !== reqRef.current) return;
        if (d.results) setResults(d.results);
        else setError(d.error ?? "Retrieval failed");
      })
      .catch((e) => {
        if (ticket === reqRef.current) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (ticket === reqRef.current) setLoading(false);
      });
  }, [query]);

  // Advance on a timer, and keep advancing through a failed request so a dead
  // cluster cannot park the act on one broken query.
  useEffect(() => {
    if (runnable.length < 2) return;
    const t = setTimeout(() => setIdx((i) => i + 1), DWELL_MS);
    return () => clearTimeout(t);
  }, [idx, runnable.length]);

  const byMode = new Map((results ?? []).map((r) => [r.mode, r]));

  /**
   * Where each fused result came from.
   *
   * Marking "only this one found it" on the three source columns was useless:
   * across 19,907 films the arms almost never overlap, so nearly every row
   * earned the badge and it stopped meaning anything. The informative version
   * is the other direction — for each row the fusion kept, which searches
   * voted for it. That is the argument for hybrid, stated as data.
   */
  const SOURCES: Array<{ key: ModeKey; short: string }> = [
    { key: "bm25", short: "keywords" },
    { key: "minicoil", short: "smart" },
    { key: "dense", short: "meaning" },
  ];
  const sourcesFor = (id: number): string[] =>
    SOURCES.filter((src) => (byMode.get(src.key)?.hits ?? []).some((h) => h.id === id)).map(
      (src) => src.short,
    );

  const times = COLUMNS.map((c) => byMode.get(c.key)?.serverTimeMs).filter(
    (t): t is number => typeof t === "number",
  );
  const slowest = times.length > 0 ? Math.max(...times) : null;

  return (
    <div className="flex h-full flex-col px-10 pb-8 pt-6">
      <div className="shrink-0 text-center">
        <div className="eyebrow mb-3">One question, four ways to find it</div>
        <AnimatePresence mode="wait">
          <motion.div
            key={query?.text ?? "none"}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="font-semibold tracking-tight-brand text-fg-primary"
            style={{ fontSize: "clamp(1.6rem, 2.8vw, 2.7rem)", lineHeight: 1.15 }}
          >
            &ldquo;{query?.text ?? "loading"}&rdquo;
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-7 grid min-h-0 flex-1 grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const res = byMode.get(col.key);
          const isHybrid = col.key === "hybrid";
          return (
            <div
              key={col.key}
              className={`flex min-h-0 flex-col overflow-hidden rounded-xl p-5 ring-1 ${
                isHybrid
                  ? "bg-qdrant-red/[0.07] ring-qdrant-red/30"
                  : "bg-white/[0.02] ring-white/[0.06]"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="font-semibold tracking-tight-brand"
                  style={{ fontSize: "clamp(1rem, 1.35vw, 1.35rem)", color: col.accent }}
                >
                  {col.title}
                </span>
                <span
                  className="font-semibold tabular-nums text-fg-primary"
                  style={{ fontSize: "clamp(0.95rem, 1.3vw, 1.3rem)" }}
                >
                  {res?.serverTimeMs != null
                    ? res.serverTimeMs < 1
                      ? "<1 ms"
                      : `${res.serverTimeMs.toFixed(1)} ms`
                    : loading
                      ? "…"
                      : "—"}
                </span>
              </div>
              <div className="mt-1.5 text-[0.8125rem] leading-snug text-fg-secondary">
                {col.lead}
              </div>

              {res && !res.available ? (
                <div className="mt-4 rounded-md bg-black/25 px-3 py-2 text-[0.75rem] text-fg-secondary">
                  {res.reason}
                </div>
              ) : (
                <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2">
                  {(res?.hits ?? []).slice(0, 3).map((h, i) => {
                    const from = isHybrid ? sourcesFor(h.id) : [];
                    const hue = h.payload.hue ?? 320;
                    return (
                      <div
                        key={`${h.id}-${i}`}
                        className="flex items-center gap-2.5 rounded-lg bg-black/25 p-2"
                      >
                        <div
                          className="h-11 w-8 shrink-0 overflow-hidden rounded"
                          style={{
                            background: h.payload.poster
                              ? `url(${posterSrc(h.payload.poster)}) center/cover`
                              : `linear-gradient(140deg, hsl(${hue} 55% 28%), hsl(${hue + 40} 45% 16%))`,
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-[0.875rem] font-medium leading-tight text-fg-primary">
                            {h.payload.title}
                          </div>
                          <div className="text-[0.75rem] text-fg-secondary">
                            {h.payload.year}
                            {from.length > 0 && (
                              <span style={{ color: col.accent }}>
                                {" · "}
                                {from.length === SOURCES.length ? "all three agreed" : from.join(" + ")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {!res && !error && (
                    <div className="text-[0.8125rem] text-fg-secondary/70">searching…</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 shrink-0 text-center text-[0.875rem] text-fg-secondary">
        {error ? (
          <span className="text-fg-primary/80">The cluster did not answer. Moving on.</span>
        ) : (
          <>
            Same films, one cluster. The fused column is a{" "}
            <span className="text-fg-primary/85">single request</span>
            {slowest != null && (
              <>
                , all of it in{" "}
                <span className="text-fg-primary/85">
                  {slowest < 1 ? "under a millisecond" : `${slowest.toFixed(1)} ms`}
                </span>
              </>
            )}
            .
          </>
        )}
      </div>
    </div>
  );
}
