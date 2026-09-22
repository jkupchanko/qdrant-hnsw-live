"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { posterSrc } from "@/lib/poster";
import type { Query, MoviePayload } from "@/lib/types";

/**
 * HOW WE MEASURE — the same question, three definitions of "close".
 *
 * Once a sentence is a vector, "nearest" is not one thing. Cosine compares
 * the angle and ignores length. Dot product rewards angle and length
 * together. Euclidean is straight-line distance between the points.
 *
 * This is not an illustration. Distance is a build-time property of a Qdrant
 * collection, so the demo holds the same 19,907 films indexed three ways —
 * movies, movies_dot, movies_euclid — and this screen runs the same query
 * against all three at once.
 *
 * NOT IN THE LOOP, and the reason is worth keeping.
 *
 * Every vector in this collection is unit length (measured: norm 1.0, query
 * included), because MiniLM is encoded with normalize_embeddings=True. For
 * unit vectors dot product IS cosine, and Euclidean distance is a monotonic
 * function of it, so all three metrics rank identically — mathematically,
 * always, not by coincidence. Run live, the three columns returned the same
 * three films in the same order.
 *
 * So there is no disagreement to show, and a booth screen with three
 * identical columns reads as a bug. The true lesson — normalize your vectors
 * and the metric choice stops mattering — belongs as a line on the board,
 * not as 45 seconds of the loop. Kept because it is the proof, and because
 * it becomes a real screen the day the demo indexes un-normalized vectors.
 */

interface Hit {
  id: number;
  score: number;
  payload: MoviePayload;
}

interface Column {
  key: string;
  variant: string;
  title: string;
  lead: string;
  accent: string;
  hits: Hit[];
  ms: number | null;
}

const COLUMNS: Array<Omit<Column, "hits" | "ms">> = [
  {
    key: "cosine",
    variant: "default",
    title: "By angle",
    lead: "Cosine. Which direction it points, never how long it is.",
    accent: "#DC244C",
  },
  {
    key: "dot",
    variant: "dot",
    title: "By angle and size",
    lead: "Dot product. Direction, but a longer vector scores higher too.",
    accent: "#6047FF",
  },
  {
    key: "euclid",
    variant: "euclid",
    title: "By straight-line distance",
    lead: "Euclidean. How far apart the two points actually sit.",
    accent: "#009688",
  },
];

export function MeasureAct({ query }: { query: Query | null }) {
  const [cols, setCols] = useState<Column[]>([]);
  const ticketRef = useRef(0);

  useEffect(() => {
    if (!query) return;
    const ticket = ++ticketRef.current;
    let cancelled = false;

    (async () => {
      const results = await Promise.all(
        COLUMNS.map(async (c) => {
          try {
            const r = await fetch("/api/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ vector: query.vector, limit: 3, variant: c.variant }),
            });
            const d = (await r.json()) as { hits?: Hit[]; serverTimeMs?: number };
            return { ...c, hits: d.hits ?? [], ms: d.serverTimeMs ?? null };
          } catch {
            return { ...c, hits: [], ms: null };
          }
        }),
      );
      if (!cancelled && ticket === ticketRef.current) setCols(results);
    })();

    return () => { cancelled = true; };
  }, [query]);

  // Where the three metrics disagree is the entire point of the screen.
  const topIds = cols.map((c) => c.hits[0]?.id).filter(Boolean);
  const allAgree = topIds.length === COLUMNS.length && new Set(topIds).size === 1;

  return (
    <div className="flex h-full flex-col px-10 pb-8 pt-6">
      <div className="shrink-0 text-center">
        <div className="eyebrow mb-3">Once it is numbers, &ldquo;closest&rdquo; is a choice</div>
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

      <div className="mt-7 grid min-h-0 flex-1 grid-cols-3 gap-5">
        {(cols.length > 0 ? cols : COLUMNS.map((c) => ({ ...c, hits: [], ms: null }))).map((col) => (
          <div
            key={col.key}
            className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-white/[0.02] p-5 ring-1 ring-white/[0.06]"
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
                style={{ fontSize: "clamp(0.95rem, 1.2vw, 1.2rem)" }}
              >
                {col.ms == null ? "…" : col.ms < 1 ? "<1 ms" : `${col.ms.toFixed(1)} ms`}
              </span>
            </div>
            <div className="mt-1.5 text-[0.8125rem] leading-snug text-fg-secondary">{col.lead}</div>

            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2">
              {col.hits.map((h, i) => {
                const hue = h.payload.hue ?? 320;
                return (
                  <div key={h.id} className="flex items-center gap-2.5 rounded-lg bg-black/25 p-2">
                    <div
                      className="h-12 w-9 shrink-0 overflow-hidden rounded"
                      style={{
                        background: h.payload.poster
                          ? `url(${posterSrc(h.payload.poster)}) center/cover`
                          : `linear-gradient(140deg, hsl(${hue} 55% 28%), hsl(${hue + 40} 45% 16%))`,
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-mono text-[0.7rem] text-fg-secondary">#{i + 1}</span>
                        <span
                          className="font-semibold tabular-nums"
                          style={{ fontSize: "clamp(0.85rem, 1vw, 1.05rem)", color: col.accent }}
                        >
                          {h.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="line-clamp-2 text-[0.875rem] font-medium leading-tight text-fg-primary">
                        {h.payload.title}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 shrink-0 text-center text-[0.875rem] text-fg-secondary">
        Same question, same {" "}
        <span className="text-fg-primary/85">19,907</span> films, three separate indexes.
        {allAgree
          ? " Here all three agree — which is itself worth knowing."
          : " They disagree, which is why the metric is a decision and not a default."}
      </div>
    </div>
  );
}
