"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { posterSrc } from "@/lib/poster";
import { rerankPairs } from "@/lib/embed";
import type { Query, MoviePayload } from "@/lib/types";

/**
 * ACT FOUR — ranking, and why the first order is not the final one.
 *
 * Two rows. The top one is what vector search returned, by cosine score. The
 * bottom one starts as a copy of it and then physically re-sorts as the
 * cross-encoder's scores land: cards slide past each other, losers drop out,
 * and titles that were buried deep in the candidate list arrive from nowhere.
 *
 * The movement is the argument. Two scorers looked at the same films and
 * disagreed, and you can watch them disagree.
 *
 * Both numbers are shown because they measure different things. Cosine is the
 * angle between two vectors and never sees the words. The cross-encoder reads
 * the question and the plot together, which is why it is better and why it
 * costs a second and a half instead of a millisecond.
 */

const CANDIDATES = 18;
const SHOWN = 6;
const SETTLE_MS = 2200;
const HOLD_MS = 7000;

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

type Stage = "searching" | "vector" | "reranked";

export function RankAct({ queries }: { queries: Query[] }) {
  const [idx, setIdx] = useState(0);
  const [stage, setStage] = useState<Stage>("searching");
  const [rows, setRows] = useState<Row[]>([]);
  const [final, setFinal] = useState<Row[]>([]);
  const [rerankMs, setRerankMs] = useState<number | null>(null);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const ticketRef = useRef(0);

  const query = queries.length > 0 ? queries[idx % queries.length] : null;

  useEffect(() => {
    if (!query) return;
    const ticket = ++ticketRef.current;
    let cancelled = false;
    setStage("searching");
    setRows([]);
    setFinal([]);
    setRerankMs(null);
    setSearchMs(null);
    setFailed(false);

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
        if (cancelled || ticket !== ticketRef.current) return;
        if (hits.length === 0) {
          setFailed(true);
          return;
        }
        const candidates: Row[] = hits.map((h, i) => ({ ...h, vectorRank: i + 1 }));
        setSearchMs(d.results?.[0]?.serverTimeMs ?? null);
        setRows(candidates.slice(0, SHOWN));
        setStage("vector");

        const t0 = performance.now();
        const scores = await rerankPairs(
          query.text,
          candidates.map((c) => (c.payload.description ?? c.payload.title).slice(0, 500)),
        );
        if (cancelled || ticket !== ticketRef.current) return;
        const scored = candidates
          .map((c, i) => ({ ...c, ce: sigmoid(scores[i] ?? -20) }))
          .sort((a, b) => (b.ce ?? 0) - (a.ce ?? 0))
          .slice(0, SHOWN);
        setRerankMs(Math.round(performance.now() - t0));
        setFinal(scored);
        // Let the vector order be read before anything moves.
        setTimeout(() => {
          if (!cancelled && ticket === ticketRef.current) setStage("reranked");
        }, SETTLE_MS);
      } catch {
        if (!cancelled && ticket === ticketRef.current) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [query]);

  // Advance when the run has finished, not on a fixed clock: the old version
  // could swap in the next query while the previous one was still animating,
  // which put two different queries in the two rows at once.
  useEffect(() => {
    if (queries.length < 2) return;
    if (stage !== "reranked" && !failed) return;
    const t = setTimeout(() => setIdx((i) => i + 1), failed ? 4000 : HOLD_MS);
    return () => clearTimeout(t);
  }, [stage, failed, queries.length]);

  // Watchdog: a cross-encoder that never resolves must not stall the loop.
  useEffect(() => {
    if (queries.length < 2) return;
    const t = setTimeout(() => setIdx((i) => i + 1), 40_000);
    return () => clearTimeout(t);
  }, [idx, queries.length]);

  const lower: Row[] = stage === "reranked" && final.length > 0 ? final : rows;
  const movers = stage === "reranked"
    ? final.filter((f) => f.vectorRank > SHOWN).length
    : 0;

  return (
    <div className="flex h-full flex-col px-10 pb-8 pt-6">
      <div className="shrink-0 text-center">
        <div className="eyebrow mb-3">Two scorers, same films, different answers</div>
        <AnimatePresence mode="wait">
          <motion.div
            key={query?.text ?? "none"}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="font-semibold tracking-tight-brand text-fg-primary"
            style={{ fontSize: "clamp(1.5rem, 2.6vw, 2.5rem)", lineHeight: 1.15 }}
          >
            &ldquo;{query?.text ?? "loading"}&rdquo;
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-6 flex min-h-0 flex-1 flex-col justify-center gap-6">
        <RankRow
          label="Vector search"
          sub={
            stage === "searching"
              ? "searching…"
              : `${searchMs == null ? "" : `${searchMs < 1 ? "<1" : searchMs.toFixed(1)} ms · `}compares angles, never reads the words`
          }
          accent="#6047FF"
          rows={rows}
          showCe={false}
          queryKey={query?.text ?? ""}
          dim={stage === "reranked"}
        />

        <RankRow
          label="After re-ranking"
          sub={
            stage === "reranked"
              ? `${rerankMs == null ? "" : `${(rerankMs / 1000).toFixed(1)} s · `}reads the question and each plot together`
              : "the cross-encoder is reading all 18 candidates…"
          }
          accent="#DC244C"
          rows={lower}
          showCe={stage === "reranked"}
          queryKey={query?.text ?? ""}
          highlight={stage === "reranked"}
        />
      </div>

      <div className="mt-5 shrink-0 text-center text-[0.875rem] text-fg-secondary">
        {failed ? (
          <span className="text-fg-primary/80">Could not finish this one. Moving on.</span>
        ) : stage === "reranked" ? (
          <>
            Vector search shortlisted <span className="text-fg-primary/85">{CANDIDATES}</span> films
            in milliseconds. The cross-encoder then read every one properly and changed the order
            {movers > 0 && (
              <>
                , pulling <span className="text-fg-primary/85">{movers}</span> title
                {movers === 1 ? "" : "s"} up from outside the top {SHOWN}
              </>
            )}
            . Fast and rough first, slow and careful second.
          </>
        ) : (
          <>Cheap search finds candidates. An expensive model decides the order.</>
        )}
      </div>
    </div>
  );
}

function RankRow({
  label, sub, accent, rows, showCe, queryKey, dim = false, highlight = false,
}: {
  label: string;
  sub: string;
  accent: string;
  rows: Row[];
  showCe: boolean;
  /** Remounts the presence tree per query so nothing survives across runs. */
  queryKey: string;
  dim?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-xl p-5 ring-1 transition-all duration-500"
      style={{
        background: highlight ? "rgba(220,36,76,0.07)" : "rgba(255,255,255,0.02)",
        boxShadow: `inset 0 0 0 1px ${highlight ? "rgba(220,36,76,0.3)" : "rgba(255,255,255,0.06)"}`,
        opacity: dim ? 0.55 : 1,
      }}
    >
      <div className="mb-3 flex items-baseline gap-3">
        <span
          className="font-semibold tracking-tight-brand"
          style={{ fontSize: "clamp(1rem, 1.3vw, 1.3rem)", color: accent }}
        >
          {label}
        </span>
        <span className="text-[0.8125rem] text-fg-secondary">{sub}</span>
      </div>

      <div
        key={queryKey}
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${SHOWN}, 1fr)` }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {rows.map((r, i) => {
            const moved = showCe ? r.vectorRank - (i + 1) : 0;
            const fromDeep = showCe && r.vectorRank > SHOWN;
            return (
              <motion.div
                key={r.id}
                layout
                initial={{ opacity: 0, y: 18, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -14, scale: 0.94 }}
                transition={{ type: "spring", stiffness: 260, damping: 26, mass: 0.7 }}
                className="flex min-w-0 items-center gap-2.5 rounded-lg bg-black/30 p-2.5"
              >
                <div
                  className="h-14 w-10 shrink-0 overflow-hidden rounded"
                  style={{
                    background: r.payload.poster
                      ? `url(${posterSrc(r.payload.poster)}) center/cover`
                      : `linear-gradient(140deg, hsl(${r.payload.hue ?? 320} 55% 28%), hsl(${(r.payload.hue ?? 320) + 40} 45% 16%))`,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[0.75rem] text-fg-secondary">#{i + 1}</span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{ fontSize: "clamp(0.875rem, 1.05vw, 1.1rem)", color: accent }}
                    >
                      {showCe && r.ce != null ? r.ce.toFixed(2) : r.score.toFixed(2)}
                    </span>
                  </div>
                  <div className="line-clamp-2 text-[0.8125rem] font-medium leading-tight text-fg-primary">
                    {r.payload.title}
                  </div>
                  {showCe && (
                    <div className="text-[0.75rem] text-fg-secondary">
                      {fromDeep ? (
                        <span style={{ color: accent }}>was #{r.vectorRank}</span>
                      ) : moved > 0 ? (
                        <span style={{ color: "#4CAF50" }}>up {moved} from #{r.vectorRank}</span>
                      ) : moved < 0 ? (
                        <span>down {-moved} from #{r.vectorRank}</span>
                      ) : (
                        <span className="text-fg-secondary/60">held #{r.vectorRank}</span>
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
