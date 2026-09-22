"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { posterSrc } from "@/lib/poster";
import { rerankPairs } from "@/lib/embed";
import type { Query, MoviePayload } from "@/lib/types";

/**
 * THE RANKED BAND — one row that visibly changes its mind.
 *
 * The row first appears in vector-search order with cosine scores. Then the
 * cross-encoder finishes and the same row re-sorts in place: cards slide past
 * each other, weak ones drop out, and titles buried deep in the candidate
 * list arrive from nowhere carrying "was #13".
 *
 * One row rather than a before/after pair, because the movement is the
 * argument and a single row shows movement better than two static ones — and
 * because on the one-screen layout this band is a quarter of the height.
 *
 * Both numbers get shown because they measure different things. Cosine is the
 * angle between two vectors and never sees the words. The cross-encoder reads
 * the question and the plot together, which is why it is better and why it
 * costs a second instead of a millisecond.
 *
 * Only runs on queries the re-ranker can actually rank — see
 * scripts/build_rank_queries.py. On mood queries every score sits at the
 * floor and the reordering is noise.
 */

const CANDIDATES = 18;
const SHOWN = 6;
const SETTLE_MS = 1800;

interface Hit {
  id: number;
  score: number;
  payload: MoviePayload;
}

interface Row extends Hit {
  /** 1-based position in the vector-search candidate list. */
  vectorRank: number;
  /** Cross-encoder relevance, 0-1, once it has run. */
  ce?: number;
}

/** ms-marco emits an unbounded logit; squash it so a score reads as relevance. */
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function RankAct({ query }: { query: Query | null }) {
  const [vectorRows, setVectorRows] = useState<Row[]>([]);
  const [rankedRows, setRankedRows] = useState<Row[]>([]);
  const [showRanked, setShowRanked] = useState(false);
  const [rerankMs, setRerankMs] = useState<number | null>(null);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const ticketRef = useRef(0);

  useEffect(() => {
    if (!query) return;
    const ticket = ++ticketRef.current;
    let cancelled = false;
    const live = () => !cancelled && ticket === ticketRef.current;

    setShowRanked(false);
    setRankedRows([]);
    setRerankMs(null);

    (async () => {
      try {
        const r = await fetch("/api/retrieve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vector: query.vector, modes: ["dense"], limit: CANDIDATES }),
        });
        const d = (await r.json()) as {
          results?: Array<{ hits: Hit[]; serverTimeMs: number | null }>;
        };
        const hits = d.results?.[0]?.hits ?? [];
        if (!live() || hits.length === 0) return;

        const candidates: Row[] = hits.map((h, i) => ({ ...h, vectorRank: i + 1 }));
        setSearchMs(d.results?.[0]?.serverTimeMs ?? null);
        setVectorRows(candidates.slice(0, SHOWN));

        const t0 = performance.now();
        const scores = await rerankPairs(
          query.text,
          candidates.map((c) => (c.payload.description ?? c.payload.title).slice(0, 500)),
        );
        if (!live()) return;
        const scored = candidates
          .map((c, i) => ({ ...c, ce: sigmoid(scores[i] ?? -20) }))
          .sort((a, b) => (b.ce ?? 0) - (a.ce ?? 0))
          .slice(0, SHOWN);
        setRerankMs(Math.round(performance.now() - t0));
        setRankedRows(scored);
        // Let the first order be read before anything moves.
        setTimeout(() => { if (live()) setShowRanked(true); }, SETTLE_MS);
      } catch {
        /* the band keeps showing vector order; the loop moves on regardless */
      }
    })();

    return () => { cancelled = true; };
  }, [query]);

  const rows = showRanked && rankedRows.length > 0 ? rankedRows : vectorRows;
  const movers = showRanked ? rankedRows.filter((r) => r.vectorRank > SHOWN).length : 0;

  return (
    <div className="flex h-full flex-col rounded-xl bg-white/[0.02] px-5 py-3 ring-1 ring-white/[0.06]">
      <div className="mb-2 flex shrink-0 items-baseline gap-3">
        <span
          className="font-semibold tracking-tight-brand"
          style={{
            fontSize: "clamp(0.95rem, 1.25vw, 1.25rem)",
            color: showRanked ? "#DC244C" : "#6047FF",
          }}
        >
          {showRanked ? "Re-ranked" : "The answers"}
        </span>
        <span className="truncate text-[0.8125rem] text-fg-secondary">
          {showRanked
            ? `${rerankMs == null ? "" : `${(rerankMs / 1000).toFixed(1)} s · `}a model read all ${CANDIDATES} properly${
                movers > 0 ? ` and pulled ${movers} up from outside the top ${SHOWN}` : ""
              }`
            : `${searchMs == null ? "" : `${searchMs < 1 ? "<1" : searchMs.toFixed(1)} ms · `}closest by angle`}
        </span>
      </div>

      <div
        key={query?.text ?? "none"}
        className="grid min-h-0 flex-1 gap-3"
        style={{ gridTemplateColumns: `repeat(${SHOWN}, 1fr)` }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {rows.map((r, i) => {
            const moved = showRanked ? r.vectorRank - (i + 1) : 0;
            const fromDeep = showRanked && r.vectorRank > SHOWN;
            const hue = r.payload.hue ?? 320;
            return (
              <motion.div
                key={r.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.94 }}
                transition={{ type: "spring", stiffness: 260, damping: 26, mass: 0.7 }}
                className="flex min-w-0 items-center gap-2.5 rounded-lg bg-black/30 p-2"
              >
                <div
                  className="h-full w-[3.5vw] max-w-[3rem] shrink-0 overflow-hidden rounded"
                  style={{
                    background: r.payload.poster
                      ? `url(${posterSrc(r.payload.poster)}) center/cover`
                      : `linear-gradient(140deg, hsl(${hue} 55% 28%), hsl(${hue + 40} 45% 16%))`,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[0.7rem] text-fg-secondary">#{i + 1}</span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{
                        fontSize: "clamp(0.85rem, 1vw, 1.05rem)",
                        color: showRanked ? "#DC244C" : "#6047FF",
                      }}
                    >
                      {showRanked && r.ce != null ? r.ce.toFixed(2) : r.score.toFixed(2)}
                    </span>
                  </div>
                  <div className="line-clamp-2 text-[0.8125rem] font-medium leading-tight text-fg-primary">
                    {r.payload.title}
                  </div>
                  {showRanked && (
                    <div className="truncate text-[0.7rem] text-fg-secondary">
                      {fromDeep ? (
                        <span style={{ color: "#DC244C" }}>was #{r.vectorRank}</span>
                      ) : moved > 0 ? (
                        <span style={{ color: "#4CAF50" }}>up {moved}</span>
                      ) : moved < 0 ? (
                        <span>down {-moved}</span>
                      ) : (
                        <span className="text-fg-secondary/60">held</span>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
