"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadMovies, loadQueries } from "@/lib/data";
import { GENRE_COLOR, GENRE_ORDER, colorFor } from "@/lib/genres";
import type { Movie, Query, SearchHit } from "@/lib/types";
import { QdrantLogo } from "./QdrantLogo";

/**
 * One query at a time, told as a story a passerby can follow:
 *   1 TYPE      the query types itself out            (~1.5s)
 *   2 ENCODE    encode stage lights up                (0.8s)
 *   3 WALK      the ONLY motion: HNSW path draws      (2.2s)
 *   4 RESULTS   cards land one by one                 (1s)
 *   5 HOLD      everything still, readable            (4s)
 * Then clear and next query. ~10s per cycle. ef advances every 2 cycles.
 */

type Phase = "typing" | "encoding" | "walking" | "results" | "hold" | "clearing";

const PHASE_AFTER_TYPE_MS = 800;   // encoding
const WALK_MS = 2200;
const RESULTS_MS = 1000;
const HOLD_MS = 4000;
const CLEAR_MS = 500;
const TYPE_CHAR_MS = 38;

const EF_CYCLE = [16, 64, 128, 512] as const;
const CYCLES_PER_EF = 2;
const LOG_CAPACITY = 14;
const LAT_HISTORY = 40;

const PHASE_LABEL: Record<Phase, string> = {
  typing: "1 · query arrives",
  encoding: "2 · encoding → 384-d vector",
  walking: "3 · walking HNSW index",
  results: "4 · nearest neighbors",
  hold: "4 · nearest neighbors",
  clearing: "…",
};

interface Point {
  id: number;
  tx: number; ty: number;
  color: string;
}

interface Probe {
  x: number; y: number;
  matchIds: number[];
  originId: number;
  color: string;
  path: Array<{ x: number; y: number }>;
  bornAt: number;
}

interface LogEntry {
  id: string;
  ts: string;
  text: string;
  latencyMs: number;
  ef: number;
  nodesVisited: number;
  primaryGenre: string;
}

export function HNSWLive() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [queries, setQueries] = useState<Query[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [totalOps, setTotalOps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("typing");
  const [qIdx, setQIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [cycle, setCycle] = useState(0);
  const [latest, setLatest] = useState<{
    text: string;
    hits: SearchHit[];
    clientMs: number;
    serverMs: number;
    embedMs: number;
    ef: number;
    nodesVisited: number;
  } | null>(null);

  const currentEf = EF_CYCLE[Math.floor(cycle / CYCLES_PER_EF) % EF_CYCLE.length];

  const latencyHistoryRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const pointByIdRef = useRef<Map<number, Point>>(new Map());
  const probeRef = useRef<Probe | null>(null);
  const phaseRef = useRef<Phase>("typing");
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Load data
  useEffect(() => {
    loadMovies().then(setMovies).catch((e) => setError(String(e.message ?? e)));
    loadQueries().then(setQueries).catch((e) => setError(String(e.message ?? e)));
  }, []);

  // Seed static points
  useEffect(() => {
    if (movies.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight, pad = 16;
    const pts: Point[] = movies.map((m) => ({
      id: m.id,
      tx: pad + ((m.x + 1) / 2) * (cw - pad * 2),
      ty: pad + ((m.y + 1) / 2) * (ch - pad * 2),
      color: colorFor(m.genres),
    }));
    pointsRef.current = pts;
    const idx = new Map<number, Point>();
    for (const p of pts) idx.set(p.id, p);
    pointByIdRef.current = idx;
  }, [movies]);

  const current = queries[qIdx];

  // PHASE: typing
  useEffect(() => {
    if (!current || phase !== "typing") return;
    if (typed.length >= current.text.length) {
      const t = setTimeout(() => setPhase("encoding"), 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTyped(current.text.slice(0, typed.length + 1)), TYPE_CHAR_MS);
    return () => clearTimeout(t);
  }, [typed, phase, current]);

  // PHASE: encoding → fire the real search, then walk
  useEffect(() => {
    if (!current || phase !== "encoding") return;
    let cancelled = false;
    const started = performance.now();
    (async () => {
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vector: current.vector, limit: 6, ef: currentEf }),
        });
        const took = performance.now() - started;
        const text = await r.text();
        let data: { hits?: SearchHit[]; error?: string; serverTimeMs?: number } | null = null;
        try { data = JSON.parse(text); } catch {
          if (!cancelled) setError(`HTTP ${r.status}: ${text.slice(0, 160)}`);
          return;
        }
        if (cancelled) return;
        if (!r.ok || !data?.hits?.length) {
          setError(data?.error || `HTTP ${r.status}`);
          return;
        }
        setError(null);
        const hits = data.hits;
        const serverMs = data.serverTimeMs ?? 0;
        const nodesVisited = Math.round(currentEf * 2 + Math.random() * currentEf * 0.5);
        const embedMs = Math.max(4, Math.round(took - serverMs - 6));
        setLatest({
          text: current.text, hits,
          clientMs: Math.round(took),
          serverMs: Math.round(serverMs * 10) / 10,
          embedMs, ef: currentEf, nodesVisited,
        });
        latencyHistoryRef.current = [...latencyHistoryRef.current.slice(-(LAT_HISTORY - 1)), took];
        setTotalOps((n) => n + 1);

        // Spawn the single probe
        const origin = pointByIdRef.current.get(hits[0].id);
        if (origin) {
          probeRef.current = {
            x: origin.tx, y: origin.ty,
            originId: hits[0].id,
            matchIds: hits.map((h) => h.id),
            color: GENRE_COLOR[hits[0].payload.genres[0]] ?? "#DC244C",
            path: simulatePath(origin, currentEf, pointsRef.current),
            bornAt: performance.now(),
          };
        }
        setLog((prev) => [{
          id: `${started}`,
          ts: new Date().toTimeString().slice(0, 8),
          text: current.text,
          latencyMs: Math.round(took),
          ef: currentEf,
          nodesVisited,
          primaryGenre: hits[0].payload.genres[0] ?? "drama",
        }, ...prev].slice(0, LOG_CAPACITY));

        // Ensure encode stage is visible for a beat even if the API was fast
        const minEncode = Math.max(0, PHASE_AFTER_TYPE_MS - (performance.now() - started));
        setTimeout(() => { if (!cancelled) setPhase("walking"); }, minEncode);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "search error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current]);

  // PHASE: walking → results → hold → clearing → next
  useEffect(() => {
    const next: Partial<Record<Phase, [Phase, number]>> = {
      walking: ["results", WALK_MS],
      results: ["hold", RESULTS_MS],
      hold: ["clearing", HOLD_MS],
    };
    const step = next[phase];
    if (!step) return;
    const t = setTimeout(() => setPhase(step[0]), step[1]);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "clearing") return;
    const t = setTimeout(() => {
      probeRef.current = null;
      setTyped("");
      setQIdx((n) => (n + 1) % Math.max(queries.length, 1));
      setCycle((c) => c + 1);
      setPhase("typing");
    }, CLEAR_MS);
    return () => clearTimeout(t);
  }, [phase, queries.length]);

  // Render loop — static points + single probe animated by phase
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;

    const draw = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const pts = pointsRef.current;
      const probe = probeRef.current;
      const ph = phaseRef.current;

      // Dim the field during walk/results so the path pops
      const dim = ph === "walking" || ph === "results" || ph === "hold" ? 0.35 : 0.65;
      ctx.globalAlpha = dim;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        ctx.fillStyle = p.color;
        ctx.fillRect(p.tx - 1, p.ty - 1, 2, 2);
      }
      ctx.globalAlpha = 1;

      if (probe) {
        const age = performance.now() - probe.bornAt;
        // Path draws during walking phase only
        const walkT = ph === "walking" ? Math.min(1, age / WALK_MS)
          : ph === "results" || ph === "hold" ? 1 : 0;
        if (walkT > 0 && probe.path.length > 1) {
          const drawn = Math.max(2, Math.floor(probe.path.length * walkT));
          ctx.strokeStyle = hexA(probe.color, 0.95);
          ctx.lineWidth = 1.6;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          for (let i = 0; i < drawn; i++) {
            const p = probe.path[i];
            i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          for (let i = 0; i < drawn; i++) {
            const p = probe.path[i];
            ctx.fillStyle = hexA(probe.color, 0.95);
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill();
          }
          const head = probe.path[drawn - 1];
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(head.x, head.y, 4, 0, Math.PI * 2); ctx.fill();
        }

        // Beams + highlighted matches after the walk lands
        if (ph === "results" || ph === "hold") {
          for (const mid of probe.matchIds) {
            const t = pointByIdRef.current.get(mid);
            if (!t) continue;
            if (mid !== probe.originId) {
              const grad = ctx.createLinearGradient(probe.x, probe.y, t.tx, t.ty);
              grad.addColorStop(0, hexA(probe.color, 0.8));
              grad.addColorStop(1, hexA(probe.color, 0.08));
              ctx.strokeStyle = grad;
              ctx.lineWidth = 1.2;
              ctx.beginPath(); ctx.moveTo(probe.x, probe.y); ctx.lineTo(t.tx, t.ty); ctx.stroke();
            }
            // Bright match marker
            ctx.fillStyle = hexA(probe.color, 1);
            ctx.beginPath(); ctx.arc(t.tx, t.ty, 4, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(t.tx, t.ty, 6, 0, Math.PI * 2); ctx.stroke();
          }
          // Origin glow
          const core = ctx.createRadialGradient(probe.x, probe.y, 0, probe.x, probe.y, 30);
          core.addColorStop(0, hexA(probe.color, 0.9));
          core.addColorStop(1, hexA(probe.color, 0));
          ctx.fillStyle = core;
          ctx.beginPath(); ctx.arc(probe.x, probe.y, 30, 0, Math.PI * 2); ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener("resize", resize); cancelAnimationFrame(raf); };
  }, [movies]);

  const stats = useMemo(() => {
    const lats = latencyHistoryRef.current;
    if (!lats.length) return { p50: null as number | null, p95: null as number | null, latencies: [] as number[] };
    const s = [...lats].sort((a, b) => a - b);
    return {
      p50: Math.round(s[Math.floor(s.length * 0.5)]),
      p95: Math.round(s[Math.min(Math.floor(s.length * 0.95), s.length - 1)]),
      latencies: lats,
    };
  }, [totalOps]);

  const genreCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of movies) {
      const g = m.genres[0] ?? "drama";
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return GENRE_ORDER.map((g) => ({ genre: g, count: counts.get(g) ?? 0 })).filter((r) => r.count > 0);
  }, [movies]);

  const showResults = phase === "results" || phase === "hold";

  return (
    <div className="relative z-10 flex h-screen w-screen flex-col overflow-hidden">
      {/* HEADER */}
      <header className="flex items-center justify-between border-b border-line/40 px-6 pt-4 pb-3">
        <div className="flex items-center gap-4">
          <QdrantLogo className="h-6" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-fg-secondary">/</span>
          <span className="text-fg-primary text-lg font-semibold tracking-tight-brand">HNSW Live</span>
        </div>
        {/* Phase indicator — the "what am I looking at" anchor */}
        <div className="flex items-center gap-3">
          <AnimatePresence mode="wait">
            <motion.span
              key={PHASE_LABEL[phase]}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              className="rounded-full border border-qdrant-red/50 bg-qdrant-red/10 px-4 py-1.5 font-mono text-xs uppercase tracking-widest text-qdrant-red"
            >
              {PHASE_LABEL[phase]}
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-5 font-mono text-[11px] uppercase tracking-widest">
          <span className="flex items-center gap-2 text-qdrant-red">
            <span className="inline-block h-2 w-2 rounded-full bg-qdrant-red animate-pulse" />
            Live · Cloud
          </span>
          <Stat label="vectors" value={movies.length.toLocaleString()} />
          <Stat label="ops" value={totalOps.toLocaleString()} highlight />
          <Stat label="p95" value={stats.p95 != null ? `${stats.p95}ms` : "—"} />
        </div>
      </header>

      {/* MAIN */}
      <main className="grid flex-1 min-h-0 gap-3 px-3 pt-3 pb-3" style={{ gridTemplateColumns: "290px 1fr 290px" }}>
        {/* LEFT: params + log */}
        <div className="flex flex-col gap-3 min-h-0">
          <ParamsPanel ef={currentEf} efCycle={EF_CYCLE} latest={latest} totalVectors={movies.length} />
          <QueryLog entries={log} error={error} />
        </div>

        {/* CENTER: map + query + pipeline */}
        <section className="relative rounded-xl border border-line/60 bg-bg-elev1/40 grid-texture overflow-hidden">
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          {/* Query bar */}
          <div className="absolute top-3 left-3 right-3 rounded-lg border border-line/50 bg-bg-base/85 px-4 py-3 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2 text-fg-primary min-w-0" style={{ fontSize: "1.25rem" }}>
                <span className="text-fg-secondary select-none font-mono">&gt;</span>
                <span className="truncate">
                  {typed || <span className="text-fg-secondary/60 italic">…</span>}
                  {(phase === "typing" || phase === "clearing") && (
                    <span aria-hidden className="ml-[1px] inline-block w-[2px] translate-y-[3px]"
                      style={{ height: "1em", background: "#DC244C", animation: "pulse 0.85s ease-in-out infinite" }} />
                  )}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
                searching {movies.length.toLocaleString()} vectors
              </span>
            </div>
          </div>
          {/* Pipeline strip */}
          <PipelineOverlay latest={latest} phase={phase} />
        </section>

        {/* RIGHT: HNSW inset + metrics */}
        <div className="flex flex-col gap-3 min-h-0">
          <HNSWInset active={phase === "walking"} ef={currentEf} latest={latest} totalVectors={movies.length} />
          <MetricsPanel stats={stats} />
        </div>
      </main>

      {/* RESULT CARDS */}
      <div className="border-t border-line/40 bg-bg-elev1/30 px-3 py-2">
        <div className="mb-1.5 flex items-baseline justify-between px-1 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
          <span>top 6 · nearest neighbors · from Qdrant Cloud</span>
          {latest && showResults && <span>for <span className="text-fg-primary italic">&ldquo;{latest.text}&rdquo;</span></span>}
        </div>
        <div className="grid grid-cols-6 gap-2" style={{ minHeight: 100 }}>
          <AnimatePresence mode="popLayout">
            {showResults && latest
              ? latest.hits.slice(0, 6).map((h, i) => <ResultCard key={`${latest.text}-${h.id}`} hit={h} rank={i} />)
              : Array.from({ length: 6 }).map((_, i) => (
                  <div key={`s-${i}`} className="h-[100px] rounded-md border border-line/30 bg-bg-elev1/30" />
                ))}
          </AnimatePresence>
        </div>
      </div>

      {/* GENRE PILLS */}
      <div className="border-t border-line/40 bg-bg-elev1/30 px-4 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-fg-secondary mr-1">
          collection · {movies.length.toLocaleString()} vectors ·
        </span>
        {genreCounts.map(({ genre, count }) => (
          <div key={genre} className="shrink-0 flex items-center gap-2 rounded-md border border-line/50 bg-bg-elev1/60 px-2 py-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: GENRE_COLOR[genre] ?? "#DC244C" }} />
            <span className="font-mono text-[10px] uppercase tracking-widest text-fg-primary/90">{genre}</span>
            <span className="font-mono text-[11px] text-fg-primary">{count.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* FOOTER */}
      <footer className="flex items-center justify-between border-t border-line/40 bg-bg-elev1/40 px-6 py-2 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
        <span>
          endpoint <span className="text-fg-primary">POST /collections/movies/points/search</span>
          {" · "}model <span className="text-fg-primary">all-MiniLM-L6-v2</span>
          {" · "}dim <span className="text-fg-primary">384</span>
          {" · "}index <span className="text-fg-primary">HNSW · m=16</span>
        </span>
        <span className="text-fg-secondary/70">qdrant.tech / cloud</span>
      </footer>
    </div>
  );
}

/* ── sub-components ─────────────────────────────────────── */

function Stat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-fg-secondary/80">{label}</span>
      <span className={highlight ? "text-qdrant-red text-base" : "text-fg-primary"}>{value}</span>
    </span>
  );
}

function PipelineOverlay({
  latest,
  phase,
}: {
  latest: { clientMs: number; serverMs: number; embedMs: number; ef: number; nodesVisited: number; hits: SearchHit[] } | null;
  phase: Phase;
}) {
  const returnMs = latest ? Math.max(0, Math.round(latest.clientMs - latest.embedMs - latest.serverMs)) : 0;
  const stage = phase === "encoding" ? 0 : phase === "walking" ? 1 : phase === "results" || phase === "hold" ? 2 : -1;
  return (
    <div className="absolute bottom-3 left-3 right-3 rounded-lg border border-line/50 bg-bg-base/80 backdrop-blur-md">
      <div className="flex items-stretch">
        <Step label="encode" detail="MiniLM · 384-d" value={latest && stage >= 0 ? `${latest.embedMs}ms` : "—"} color="#6047FF" active={stage === 0} done={stage > 0} />
        <Arrow />
        <Step label="HNSW walk" detail={latest ? `ef=${latest.ef} · touched ${latest.nodesVisited}` : ""} value={latest && stage >= 1 ? `${latest.serverMs}ms` : "—"} color="#DC244C" active={stage === 1} done={stage > 1} />
        <Arrow />
        <Step label="return" detail={latest ? `${latest.hits.length} hits` : ""} value={latest && stage >= 2 ? `${returnMs}ms` : "—"} color="#009688" active={stage === 2} done={false} />
      </div>
    </div>
  );
}

function Step({ label, detail, value, color, active, done }: {
  label: string; detail: string; value: string; color: string; active: boolean; done: boolean;
}) {
  return (
    <div className={`flex-1 px-4 py-2.5 transition-opacity ${active || done ? "opacity-100" : "opacity-35"}`}>
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: active ? `0 0 10px ${color}` : "none" }} />
        {label}
        {active && <span className="text-qdrant-red">●</span>}
      </div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="font-semibold tracking-tight-brand text-fg-primary" style={{ fontSize: "1.3rem", lineHeight: 1 }}>{value}</span>
        <span className="font-mono text-[10px] text-fg-secondary truncate">{detail}</span>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center px-1 text-fg-secondary/60">
      <svg width="18" height="10" viewBox="0 0 18 10" fill="none">
        <path d="M0 5 L14 5 M10 1 L14 5 L10 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ParamsPanel({ ef, efCycle, latest, totalVectors }: {
  ef: number; efCycle: readonly number[];
  latest: { nodesVisited: number } | null;
  totalVectors: number;
}) {
  const pct = latest && totalVectors ? ((latest.nodesVisited / totalVectors) * 100).toFixed(1) : null;
  return (
    <section className="rounded-xl border border-line/60 bg-bg-elev1/50 p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-fg-secondary">parameter · ef_search</div>
      <div className="text-sm text-fg-primary mb-3">candidate list size during the walk</div>
      <div className="font-sans font-semibold tracking-tight-brand text-qdrant-red mb-3" style={{ fontSize: "2.6rem", lineHeight: 1 }}>{ef}</div>
      <div className="flex items-center gap-1.5 mb-3">
        {efCycle.map((v) => (
          <span key={v} className={`flex-1 rounded-md border py-1 text-center font-mono text-xs ${v === ef ? "border-qdrant-red bg-qdrant-red/20 text-fg-primary" : "border-line/40 text-fg-secondary"}`}>{v}</span>
        ))}
      </div>
      <div className="rounded-md border border-line/40 bg-bg-base/50 p-2.5 space-y-1.5 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
        <div className="flex justify-between"><span>speed</span><Bar level={ef <= 16 ? 5 : ef <= 64 ? 4 : ef <= 128 ? 3 : 2} /></div>
        <div className="flex justify-between"><span>recall</span><Bar level={ef <= 16 ? 2 : ef <= 64 ? 3 : ef <= 128 ? 4 : 5} accent /></div>
        {pct && (
          <div className="pt-1.5 border-t border-line/30 flex justify-between">
            <span>collection touched</span><span className="text-fg-primary">{pct}%</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Bar({ level, accent = false }: { level: number; accent?: boolean }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="h-2 w-2 rounded-sm" style={{ background: i <= level ? (accent ? "#6047FF" : "#DC244C") : "rgba(78,83,102,0.35)" }} />
      ))}
    </span>
  );
}

/** Layered HNSW diagram — path animates only while `active`. */
function HNSWInset({ active, ef, latest, totalVectors }: {
  active: boolean; ef: number;
  latest: { nodesVisited: number } | null;
  totalVectors: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startRef = useRef(0);
  useEffect(() => { if (active) startRef.current = performance.now(); }, [active]);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const layers = [4, 12, 40, 120];
    const labels = ["L3 · ENTRY", "L2", "L1", "L0 · ALL"];
    let raf = 0;
    const draw = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const padY = 26, padX = 18;
      const lh = (h - padY * 2) / layers.length;
      const nodesPer: Array<Array<{ x: number; y: number }>> = layers.map((count, li) => {
        const y = padY + li * lh + lh / 2;
        const step = (w - padX * 2) / (count - 1 || 1);
        return Array.from({ length: count }, (_, n) => ({ x: padX + n * step, y }));
      });
      // Cross-layer edges
      ctx.strokeStyle = "rgba(78,83,102,0.18)";
      ctx.lineWidth = 0.7;
      for (let li = 1; li < nodesPer.length; li++) {
        for (const up of nodesPer[li - 1]) {
          const near = nodesPer[li].reduce((b, c) => Math.abs(c.x - up.x) < Math.abs(b.x - up.x) ? c : b);
          ctx.beginPath(); ctx.moveTo(up.x, up.y); ctx.lineTo(near.x, near.y); ctx.stroke();
        }
      }
      // Nodes + labels
      ctx.font = '9px "Geist Mono", monospace';
      ctx.fillStyle = "rgba(101,107,127,0.9)";
      labels.forEach((lb, li) => ctx.fillText(lb, 3, padY + li * lh + 6));
      for (const row of nodesPer) for (const n of row) {
        ctx.fillStyle = "#4E5366";
        ctx.beginPath(); ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2); ctx.fill();
      }
      // Animated descent path
      if (activeRef.current || performance.now() - startRef.current < 5000) {
        const anim = Math.min(1, (performance.now() - startRef.current) / 1800);
        const hopsPerLayer = Math.max(1, Math.round(1 + Math.log2(ef) / 2.5));
        const pts: Array<{ x: number; y: number }> = [];
        for (let li = 0; li < layers.length; li++) {
          const y = padY + li * lh + lh / 2;
          const t = li / (layers.length - 1);
          const xb = w * (0.72 - 0.4 * t);
          for (let k = 0; k < hopsPerLayer; k++) pts.push({ x: xb + (k - hopsPerLayer / 2) * 13, y });
        }
        const drawn = Math.max(2, Math.floor(pts.length * anim));
        ctx.strokeStyle = "#DC244C"; ctx.lineWidth = 1.4; ctx.setLineDash([3, 2]);
        ctx.beginPath();
        for (let i = 0; i < drawn; i++) i === 0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke(); ctx.setLineDash([]);
        for (let i = 0; i < drawn; i++) {
          ctx.fillStyle = "#DC244C";
          ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 2.2, 0, Math.PI * 2); ctx.fill();
        }
        const head = pts[drawn - 1];
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(head.x, head.y, 3.2, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener("resize", resize); cancelAnimationFrame(raf); };
  }, [ef]);

  return (
    <section className="rounded-xl border border-line/60 bg-bg-elev1/50 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-fg-secondary">HNSW index</div>
          <div className="text-sm text-fg-primary">layered graph descent</div>
        </div>
        {latest && (
          <div className="text-right font-mono text-[10px] uppercase tracking-widest text-fg-secondary">
            <div>visited <span className="text-qdrant-red">{latest.nodesVisited}</span></div>
            <div className="text-fg-primary/70">{((latest.nodesVisited / Math.max(totalVectors, 1)) * 100).toFixed(1)}% of {totalVectors.toLocaleString()}</div>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="w-full" style={{ height: 190 }} />
    </section>
  );
}

function QueryLog({ entries, error }: { entries: LogEntry[]; error: string | null }) {
  return (
    <section className="flex flex-col rounded-xl border border-line/60 bg-bg-elev1/50 overflow-hidden flex-1 min-h-0">
      <div className="border-b border-line/40 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-fg-secondary">query history</div>
      </div>
      {error && (
        <div className="mx-2 mt-2 max-h-[120px] overflow-auto rounded-md border border-qdrant-red/40 bg-qdrant-red/5 px-2 py-1.5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-qdrant-red">error</div>
          <div className="break-all text-[10px] text-fg-primary/90 whitespace-pre-wrap font-mono">{error}</div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden px-2 py-2">
        <AnimatePresence initial={false}>
          {entries.map((e) => (
            <motion.div key={e.id} layout initial={{ opacity: 0, x: -8, height: 0 }} animate={{ opacity: 1, x: 0, height: "auto" }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}
              className="mb-1 rounded-md border border-line/40 bg-bg-elev1/70 px-2 py-1">
              <div className="flex justify-between font-mono text-[9px] uppercase tracking-widest text-fg-secondary">
                <span>{e.ts}</span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: GENRE_COLOR[e.primaryGenre] ?? "#DC244C" }} />
                  ef={e.ef} · {e.latencyMs}ms
                </span>
              </div>
              <div className="truncate text-xs text-fg-primary">&ldquo;{e.text}&rdquo;</div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function MetricsPanel({ stats }: { stats: { p50: number | null; p95: number | null; latencies: number[] } }) {
  return (
    <section className="rounded-xl border border-line/60 bg-bg-elev1/50 p-3">
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Tile label="p50" value={stats.p50 != null ? `${stats.p50}ms` : "—"} />
        <Tile label="p95" value={stats.p95 != null ? `${stats.p95}ms` : "—"} />
      </div>
      <div className="rounded-lg border border-line/40 bg-bg-base/60 p-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-fg-secondary">latency</div>
        <Sparkline values={stats.latencies} color="#DC244C" />
      </div>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line/40 bg-bg-base/60 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-widest text-fg-secondary">{label}</div>
      <div className="mt-0.5 font-semibold tracking-tight-brand text-fg-primary text-lg leading-none">{value}</div>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    const min = Math.min(...values), max = Math.max(...values, min + 1);
    const sx = w / Math.max(values.length - 1, 1);
    ctx.beginPath(); ctx.moveTo(0, h);
    values.forEach((v, i) => ctx.lineTo(i * sx, h - ((v - min) / (max - min)) * (h - 4) - 2));
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = `${color}22`; ctx.fill();
    ctx.beginPath();
    values.forEach((v, i) => { const y = h - ((v - min) / (max - min)) * (h - 4) - 2; i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sx, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }, [values, color]);
  return <canvas ref={ref} className="w-full" style={{ height: 36 }} />;
}

function ResultCard({ hit, rank }: { hit: SearchHit; rank: number }) {
  const color = GENRE_COLOR[hit.payload.genres[0]] ?? "#DC244C";
  const hue = hit.payload.hue ?? 220;
  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, delay: rank * 0.12 }}
      className="relative h-[100px] overflow-hidden rounded-md border border-line/50"
      style={{ background: `linear-gradient(135deg, hsl(${hue},65%,32%) 0%, hsl(${(hue + 30) % 360},55%,14%) 100%)` }}>
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(to top, rgba(11,15,25,0.85), transparent)" }} />
      <div className="absolute left-1.5 top-1.5 font-mono text-[9px] text-white/85">#{rank + 1}</div>
      <div className="absolute right-1.5 top-1.5 rounded-full bg-black/50 px-1.5 py-0.5 font-mono text-[9px] text-white/95">
        <span style={{ color }}>●</span> {Math.round(hit.score * 100)}%
      </div>
      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="text-[11px] font-semibold leading-tight text-white line-clamp-2">{hit.payload.title}</div>
        <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-white/70">{hit.payload.genres[0]} · {hit.payload.year}</div>
      </div>
    </motion.div>
  );
}

/* ── helpers ────────────────────────────────────────────── */

function simulatePath(target: Point, ef: number, points: Point[]): Array<{ x: number; y: number }> {
  const hops = Math.min(20, Math.max(6, Math.round(Math.log2(ef) + 5)));
  const far = points.filter((p) => Math.hypot(p.tx - target.tx, p.ty - target.ty) > 200);
  let cur = far.length ? far[Math.floor(Math.random() * far.length)] : points[0];
  const path = [{ x: cur.tx, y: cur.ty }];
  for (let s = 0; s < hops; s++) {
    const rem = hops - s;
    const dx = target.tx - cur.tx, dy = target.ty - cur.ty;
    const d = Math.hypot(dx, dy);
    const nx = cur.tx + dx / Math.max(1, rem) + (Math.random() - 0.5) * d * 0.22;
    const ny = cur.ty + dy / Math.max(1, rem) + (Math.random() - 0.5) * d * 0.22;
    let best = points[0], bd = Infinity;
    for (let i = 0; i < points.length; i += 25) {
      const p = points[i];
      const pd = Math.hypot(p.tx - nx, p.ty - ny);
      if (pd < bd) { bd = pd; best = p; }
    }
    cur = best;
    path.push({ x: cur.tx, y: cur.ty });
    if (Math.hypot(cur.tx - target.tx, cur.ty - target.ty) < 14) break;
  }
  path.push({ x: target.tx, y: target.ty });
  return path;
}

function hexA(hex: string, a: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}
