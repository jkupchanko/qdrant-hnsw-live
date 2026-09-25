"use client";

import { useEffect, useState } from "react";

/**
 * THREE WAYS TO SAY "CLOSE".
 *
 * Once a sentence is a vector, "nearest" is not one thing, and the old
 * version of this explanation was a 150x110 SVG in the corner of another
 * screen that nobody could read and that could not show the interesting
 * part.
 *
 * The interesting part is WHY they differ. So one candidate vector sweeps —
 * its angle and its length both change — and all three scores are computed
 * live from the same two vectors:
 *
 *   cosine     cos(theta)                        ignores length entirely
 *   dot        r * cos(theta)                    rewards length
 *   euclidean  sqrt(1 + r^2 - 2r*cos(theta))     distance between the tips
 *
 * Watch the length change with the angle held and cosine sits still while
 * the other two move. That is the whole lesson, and it is exact rather than
 * illustrative: the numbers on screen are those formulas, not a mock-up.
 *
 * The footer says the thing this demo has to be honest about — every vector
 * in the collection is normalised, so r = 1 and all three rank identically.
 * Measured, not assumed: movies, movies_dot and movies_euclid return the
 * same films in the same order.
 */

const R_MIN = 0.45;
const R_MAX = 1.35;

interface Frame {
  theta: number;
  r: number;
}

const METRICS = [
  {
    key: "cosine",
    title: "Cosine",
    lead: "The angle, and nothing else.",
    accent: "#DC244C",
    value: ({ theta }: Frame) => Math.cos(theta),
    formula: "cos θ",
  },
  {
    key: "dot",
    title: "Dot product",
    lead: "The angle, rewarded by length.",
    accent: "#6047FF",
    value: ({ theta, r }: Frame) => r * Math.cos(theta),
    formula: "r · cos θ",
  },
  {
    key: "euclid",
    title: "Euclidean",
    lead: "Straight-line gap between the tips.",
    accent: "#009688",
    value: ({ theta, r }: Frame) => Math.sqrt(1 + r * r - 2 * r * Math.cos(theta)),
    formula: "√(1 + r² − 2r·cos θ)",
  },
] as const;

export function MetricsAct() {
  const [frame, setFrame] = useState<Frame>({ theta: 0.55, r: 1 });

  /**
   * Driven by an interval, not requestAnimationFrame.
   *
   * rAF stops whenever the browser decides it is not painting — a backgrounded
   * window, an occluded one, some remote-display setups — and a booth screen
   * that silently freezes its only animation is worse than one that is a few
   * frames coarser. Measured in this environment: zero rAF callbacks in 600ms
   * while document.visibilityState still read "visible". 25fps is plenty for
   * a sweep this slow.
   */
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const t = (Date.now() - start) / 1000;
      // Two different periods so the pair never simply retraces its path,
      // and slow enough to read the numbers as they move.
      setFrame({
        theta: 0.62 + 0.52 * Math.sin(t * 0.38),
        r: (R_MIN + R_MAX) / 2 + ((R_MAX - R_MIN) / 2) * Math.sin(t * 0.61),
      });
    }, 40);
    return () => clearInterval(id);
  }, []);

  const normalised = Math.abs(frame.r - 1) < 0.04;

  return (
    <div className="flex h-full flex-col px-10 pb-5 pt-4">
      <div className="shrink-0 text-center">
        <div
          className="font-semibold tracking-tight-brand text-fg-primary"
          style={{ fontSize: "clamp(1.3rem, 2.2vw, 2.1rem)", lineHeight: 1.1 }}
        >
          Three ways to say &ldquo;close&rdquo;
        </div>
      </div>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-3 gap-4">
        {METRICS.map((m) => (
          <div
            key={m.key}
            className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-white/[0.02] px-4 py-3 ring-1 ring-white/[0.06]"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="font-semibold tracking-tight-brand"
                style={{ fontSize: "clamp(1rem, 1.35vw, 1.35rem)", color: m.accent }}
              >
                {m.title}
              </span>
              <span
                className="font-semibold tabular-nums text-fg-primary"
                style={{ fontSize: "clamp(1.2rem, 1.7vw, 1.8rem)" }}
              >
                {m.value(frame).toFixed(3)}
              </span>
            </div>
            <div className="mt-0.5 text-[0.75rem] leading-snug text-fg-secondary">{m.lead}</div>

            <div className="relative mt-2 min-h-0 flex-1">
              <MetricDiagram kind={m.key} frame={frame} accent={m.accent} />
            </div>

            <div className="mt-1 text-center font-mono text-[0.75rem] text-fg-secondary">
              {m.formula}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 shrink-0 text-center text-[0.8125rem] text-fg-secondary">
        <span className="text-fg-primary/85">Cosine ignores length</span>; the other two do not.
        {normalised
          ? " Right now the candidate is length 1 — where all three agree."
          : " Every vector here is length 1, so in practice all three rank the same."}
      </div>
    </div>
  );
}

/** Origin bottom-left, query fixed, candidate swinging. Units are viewBox px. */
function MetricDiagram({
  kind, frame, accent,
}: { kind: "cosine" | "dot" | "euclid"; frame: Frame; accent: string }) {
  const O = { x: 40, y: 190 };
  const SCALE = 118;
  const queryAngle = -Math.PI / 4; // up and to the right
  const qx = O.x + Math.cos(queryAngle) * SCALE;
  const qy = O.y + Math.sin(queryAngle) * SCALE;

  const candAngle = queryAngle + frame.theta;
  const cx = O.x + Math.cos(candAngle) * SCALE * frame.r;
  const cy = O.y + Math.sin(candAngle) * SCALE * frame.r;

  // Where the candidate lands when dropped onto the query's direction: the
  // dot product, drawn.
  const proj = frame.r * Math.cos(frame.theta);
  const px = O.x + Math.cos(queryAngle) * SCALE * proj;
  const py = O.y + Math.sin(queryAngle) * SCALE * proj;

  const arcR = 46;
  const arc = `M ${O.x + Math.cos(queryAngle) * arcR} ${O.y + Math.sin(queryAngle) * arcR}
               A ${arcR} ${arcR} 0 0 1 ${O.x + Math.cos(candAngle) * arcR} ${O.y + Math.sin(candAngle) * arcR}`;

  return (
    <svg viewBox="0 0 230 210" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
      <line x1={O.x} y1={O.y} x2={222} y2={O.y} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      <line x1={O.x} y1={O.y} x2={O.x} y2={10} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

      {/* unit circle: where every vector in the real collection sits */}
      <circle cx={O.x} cy={O.y} r={SCALE} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" strokeDasharray="3 4" />

      {(kind === "cosine" || kind === "dot") && (
        <>
          <path d={arc} fill="none" stroke={accent} strokeWidth="2" />
          <text
            x={O.x + Math.cos(queryAngle + frame.theta / 2) * (arcR + 16)}
            y={O.y + Math.sin(queryAngle + frame.theta / 2) * (arcR + 16)}
            fill={accent}
            fontSize="15"
            fontFamily="monospace"
            textAnchor="middle"
          >
            θ
          </text>
        </>
      )}

      {kind === "dot" && (
        <>
          <line x1={cx} y1={cy} x2={px} y2={py} stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" strokeDasharray="3 3" />
          <line x1={O.x} y1={O.y} x2={px} y2={py} stroke={accent} strokeWidth="5" strokeLinecap="round" opacity="0.5" />
        </>
      )}

      {kind === "euclid" && (
        <line x1={qx} y1={qy} x2={cx} y2={cy} stroke={accent} strokeWidth="2.4" strokeDasharray="5 4" />
      )}

      {/* query — fixed, always length 1 */}
      <line x1={O.x} y1={O.y} x2={qx} y2={qy} stroke="#F0F3FA" strokeWidth="2.6" />
      <circle cx={qx} cy={qy} r="4.5" fill="#F0F3FA" />
      <text x={qx + 7} y={qy - 6} fill="#F0F3FA" fontSize="13" fontFamily="monospace">query</text>

      {/* candidate — swinging, and changing length */}
      <line x1={O.x} y1={O.y} x2={cx} y2={cy} stroke="#8B7CFF" strokeWidth="2.6" />
      <circle cx={cx} cy={cy} r="4.5" fill="#8B7CFF" />
      <text x={cx + 7} y={cy + 14} fill="#8B7CFF" fontSize="13" fontFamily="monospace">movie</text>
    </svg>
  );
}
