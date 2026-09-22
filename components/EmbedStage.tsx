"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * WHERE THE EMBEDDING HAPPENS.
 *
 * The old version showed the map, and in a corner panel a line reading
 * "…becomes 384 numbers" above a bar chart. Nothing ever turned into
 * anything, so the one step that explains what a vector database is for was
 * invisible. People kept asking where the embedding was, which is the
 * correct response to a screen that never showed it.
 *
 * Four beats, on a darkened stage so the map recedes and comes back:
 *
 *   1  the sentence
 *   2  it breaks into words
 *   3  the words become 384 real numbers, streaming in
 *   4  the numbers collapse into a single point
 *
 * Then the phase advances and the landing animation flies that point onto
 * the map. The numbers are the actual query vector, not decoration.
 *
 * Qdrant does not do this step, and the caption says so. It matters anyway:
 * without understanding that a sentence becomes coordinates, nothing else on
 * the screen means anything.
 */

const BEATS = [0, 1200, 2500, 5300] as const;
const SHOWN_DIMS = 48;

export function EmbedStage({
  text, vector, onCollapsed,
}: { text: string; vector: number[]; onCollapsed?: () => void }) {
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    setBeat(0);
    const timers = BEATS.slice(1).map((at, i) =>
      setTimeout(() => setBeat(i + 1), at),
    );
    return () => timers.forEach(clearTimeout);
  }, [text]);

  // The dot itself belongs to the parent so it can outlive this stage and
  // fly to the map. All this does is say when it should appear.
  useEffect(() => {
    if (beat === 3) onCollapsed?.();
  }, [beat, onCollapsed]);

  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  // Evenly sampled real dimensions, so the numbers on screen are this query's.
  const dims = useMemo(
    () =>
      Array.from({ length: SHOWN_DIMS }, (_, i) => {
        const d = Math.floor((i / SHOWN_DIMS) * vector.length);
        return { d, v: vector[d] ?? 0 };
      }),
    [vector],
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // Slower out than in: the scrim lifting is what reveals the map under
      // the point, and snapping it off was most of the "finicky" feeling.
      exit={{ opacity: 0, transition: { duration: 0.75 } }}
      transition={{ duration: 0.35 }}
      // Inline rgba rather than a Tailwind opacity modifier on a CSS-variable
      // colour: the utility did not actually dim the map, so the numbers were
      // read against 19,907 moving dots.
      style={{ background: "rgba(9,12,20,0.965)", backdropFilter: "blur(6px)" }}
      className="absolute inset-0 z-[8] flex flex-col items-center justify-center px-12 pb-6 pt-24 text-center"
    >
      <div className="eyebrow mb-6">
        {beat < 2
          ? "First, the sentence has to become numbers"
          : beat === 2
            ? "384 numbers. That is what the sentence means, to a model."
            : "One sentence, one point in space"}
      </div>

      {/* 1-2: the sentence, then the same sentence in pieces */}
      <AnimatePresence mode="wait">
        {beat <= 1 && (
          <motion.div
            key="words"
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
            className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3"
          >
            {words.map((w, i) => (
              <motion.span
                key={`${w}-${i}`}
                className="font-semibold tracking-tight-brand text-fg-primary"
                style={{ fontSize: "clamp(1.6rem, 3vw, 3rem)", lineHeight: 1.1 }}
                animate={
                  beat === 1
                    ? { y: [0, -10, 0], color: "#DC244C" }
                    : { y: 0, color: "#F0F3FA" }
                }
                transition={{ duration: 0.5, delay: beat === 1 ? i * 0.07 : 0 }}
              >
                {w}
              </motion.span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3: the actual vector, arriving.
          Fixed-width monospace cells on a faint plate: unstyled floats of
          varying length jitter the grid as they land, which looked like a
          rendering fault rather than data. */}
      <AnimatePresence>
        {beat === 2 && (
          <motion.div
            key="numbers"
            // Deliberately plain. The previous version animated opacity,
            // scale AND filter on this container and the opacity stuck at
            // 0.0043 — measured, never moved, so the grid was invisible while
            // its own cells animated in correctly underneath. The cells carry
            // the entrance; the container only has to collapse on the way out.
            initial={false}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.08 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center"
          >
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: "repeat(8, minmax(0, 1fr))" }}
            >
              {dims.map(({ d, v }, i) => (
                <motion.span
                  key={d}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.011, duration: 0.2 }}
                  className="rounded-md bg-white/[0.04] px-2.5 py-1.5 text-center font-mono tabular-nums ring-1 ring-white/[0.05]"
                  style={{
                    fontSize: "clamp(0.7rem, 0.95vw, 0.95rem)",
                    color: v >= 0 ? "#FF8792" : "#8E9BFF",
                    minWidth: "5.2ch",
                  }}
                >
                  {v >= 0 ? "+" : "\u2212"}
                  {Math.abs(v).toFixed(3)}
                </motion.span>
              ))}
            </div>
            <div className="mt-4 font-mono text-[0.75rem] text-fg-secondary">
              showing {SHOWN_DIMS} of {vector.length}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 4: the caption only. The point is the parent's, so that the same
          element can carry on and land on the map. */}
      <AnimatePresence>
        {beat === 3 && (
          <motion.div
            key="point-caption"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ delay: 0.35, duration: 0.45 }}
            className="mt-24 font-semibold tracking-tight-brand text-fg-primary"
            style={{ fontSize: "clamp(1.1rem, 1.7vw, 1.7rem)" }}
          >
            384 numbers are one position
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-8 max-w-[52ch] text-[0.875rem] leading-relaxed text-fg-secondary">
        {beat <= 1
          ? "A model reads the words and turns them into coordinates."
          : beat === 2
            ? "These are this question's real values, straight from the model in your browser."
            : "Everything after this is geometry: what else sits near this point."}
      </div>
    </motion.div>
  );
}
