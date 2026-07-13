"use client";

import { useEffect, useRef, useState } from "react";
import { QdrantLogo } from "@/components/QdrantLogo";

interface Summary {
  query: string;
  titles: Array<{ title: string; year: number; score: number }>;
  count: number;
  serverMs: number;
  clientMs: number;
  ef: number;
  touchedPct: number;
  totalVectors: number;
  rerank: boolean;
  hybrid: boolean;
}

const STAGES = [
  "Sent to the big screen",
  "Embedding your words, 384 dimensions",
  "Walking the HNSW index",
  "Ranking results",
];

/**
 * The phone side of the QR hand-off: type a query, optionally tune the
 * search, watch staged progress, and get a summary of what happened.
 */
export default function RemotePage() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "waiting" | "done" | "timeout" | "error">("idle");
  const [stage, setStage] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [position, setPosition] = useState(1);

  // Options — defaults mirror the booth's defaults
  const [ef, setEf] = useState<number | null>(null);
  const [topK, setTopK] = useState(6);
  const [genre, setGenre] = useState<string | null>(null);
  const [rerank, setRerank] = useState(false);
  const [hybrid, setHybrid] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimers = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (stageRef.current) clearInterval(stageRef.current);
  };
  useEffect(() => stopTimers, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || phase === "waiting") return;
    setPhase("waiting");
    setStage(0);
    setSummary(null);
    try {
      const r = await fetch("/api/remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, options: { ef, topK, genre, rerank, hybrid } }),
      });
      const d = (await r.json()) as { ok?: boolean; id?: number; position?: number };
      if (!r.ok || !d.id) throw new Error();
      const pos = d.position ?? 1;
      setPosition(pos);

      // Each search ahead of us owns the screen for a full cycle
      // (type + embed + walk + answer + the long hold at the end).
      const PER_RUN_MS = 32000;
      const queueDelay = (pos - 1) * PER_RUN_MS;

      // Staged progress starts only when it's (roughly) our turn.
      const startStages = () => {
        stageRef.current = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 3200);
      };
      if (queueDelay > 0) {
        stageRef.current = setTimeout(startStages, queueDelay) as unknown as ReturnType<typeof setInterval>;
      } else {
        startStages();
      }

      // Poll for the booth's summary — budget for the whole line ahead.
      const started = Date.now();
      const deadline = 45000 + queueDelay;
      pollRef.current = setInterval(async () => {
        if (Date.now() - started > deadline) {
          stopTimers();
          setPhase("timeout");
          return;
        }
        try {
          const rr = await fetch(`/api/remote/result?id=${d.id}`, { cache: "no-store" });
          const dd = (await rr.json()) as { summary?: Summary | null };
          if (dd.summary) {
            stopTimers();
            setSummary(dd.summary);
            setPhase("done");
          }
        } catch { /* keep polling */ }
      }, 1500);
    } catch {
      stopTimers();
      setPhase("error");
      setTimeout(() => setPhase("idle"), 2500);
    }
  };

  const reset = () => {
    stopTimers();
    setPhase("idle");
    setSummary(null);
    setText("");
  };

  const Pill = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[12px] font-medium transition-all ${
        active ? "bg-qdrant-red text-white" : "bg-white/[0.06] text-fg-secondary"
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col items-center px-5 py-8">
      <QdrantLogo className="h-7 mb-6" />

      {/* ── ASK ── */}
      {(phase === "idle" || phase === "error") && (
        <div className="w-full max-w-[440px] text-center">
          <h1 className="text-2xl font-semibold tracking-tight-brand text-fg-primary">
            Search the big screen.
          </h1>
          <p className="mt-1.5 mb-6 text-sm text-fg-secondary">
            Describe a movie any way you like. 19,907 films, searched by meaning.
          </p>
          <form onSubmit={send}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="a heist that goes sideways…"
              className="w-full rounded-lg bg-white/[0.05] ring-1 ring-white/[0.1] px-4 py-3.5 text-base text-fg-primary placeholder:text-fg-secondary/60 outline-none focus:ring-qdrant-red/60"
            />

            {/* Options accordion */}
            <button
              type="button"
              onClick={() => setShowOptions((o) => !o)}
              className="mt-3 w-full text-left text-[12px] text-fg-secondary flex items-center justify-between rounded-lg bg-white/[0.03] ring-1 ring-white/[0.06] px-3 py-2"
            >
              <span>Tune the search, optional</span>
              <span className={`transition-transform ${showOptions ? "rotate-180" : ""}`}>▾</span>
            </button>
            {showOptions && (
              <div className="mt-2 space-y-3 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.06] p-3 text-left">
                <div>
                  <div className="mb-1 text-[11px] text-fg-secondary">Accuracy (ef)</div>
                  <div className="flex gap-1 flex-wrap">
                    <Pill active={ef == null} onClick={() => setEf(null)}>Auto</Pill>
                    {[16, 64, 128, 512].map((v) => (
                      <Pill key={v} active={ef === v} onClick={() => setEf(v)}>{v}</Pill>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-fg-secondary">Results</div>
                  <div className="flex gap-1">
                    {[3, 6, 12].map((k) => (
                      <Pill key={k} active={topK === k} onClick={() => setTopK(k)}>{k}</Pill>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-fg-secondary">Genre</div>
                  <div className="flex gap-1 flex-wrap">
                    <Pill active={genre == null} onClick={() => setGenre(null)}>All</Pill>
                    {["drama", "sci-fi", "thriller", "comedy", "horror"].map((g) => (
                      <Pill key={g} active={genre === g} onClick={() => setGenre(g)}>{g}</Pill>
                    ))}
                  </div>
                </div>
                <div className="flex gap-4">
                  <div>
                    <div className="mb-1 text-[11px] text-fg-secondary">Re-rank</div>
                    <div className="flex gap-1">
                      <Pill active={!rerank} onClick={() => setRerank(false)}>Off</Pill>
                      <Pill active={rerank} onClick={() => setRerank(true)}>On</Pill>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] text-fg-secondary">Hybrid RRF</div>
                    <div className="flex gap-1">
                      <Pill active={!hybrid} onClick={() => setHybrid(false)}>Off</Pill>
                      <Pill active={hybrid} onClick={() => setHybrid(true)}>On</Pill>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={!text.trim()}
              className="mt-4 w-full rounded-lg bg-qdrant-red py-3.5 text-base font-semibold text-white transition-opacity disabled:opacity-40"
            >
              {phase === "error" ? "Try again" : "Send to the big screen"}
            </button>
          </form>
        </div>
      )}

      {/* ── WAITING: staged progress ── */}
      {phase === "waiting" && (
        <div className="w-full max-w-[440px]">
          <h1 className="text-xl font-semibold tracking-tight-brand text-fg-primary text-center">
            Watch the big screen.
          </h1>
          <p className="mt-1 mb-4 text-center text-sm text-fg-secondary">&ldquo;{text.trim()}&rdquo;</p>
          {position > 1 && stage === 0 && (
            <div className="mb-4 rounded-lg bg-qdrant-red/10 ring-1 ring-qdrant-red/30 px-3 py-2 text-center text-[13px] text-qdrant-red">
              You&rsquo;re #{position} in line. Your turn in about {Math.max(1, Math.round(((position - 1) * 32) / 60 * 10) / 10)} min — keep watching the screen.
            </div>
          )}
          <div className="space-y-2.5">
            {STAGES.map((s, i) => (
              <div key={s} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 transition-all ${
                i < stage ? "bg-white/[0.03] ring-white/[0.06] opacity-60"
                : i === stage ? "bg-qdrant-red/10 ring-qdrant-red/30"
                : "bg-white/[0.02] ring-white/[0.04] opacity-40"
              }`}>
                <span className="flex h-5 w-5 items-center justify-center">
                  {i < stage ? (
                    <span className="text-[13px]" style={{ color: "#4CAF50" }}>✓</span>
                  ) : i === stage ? (
                    <span className="h-2.5 w-2.5 rounded-full bg-qdrant-red animate-pulse" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                  )}
                </span>
                <span className={`text-[13px] ${i === stage ? "text-fg-primary" : "text-fg-secondary"}`}>{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── DONE: the summary ── */}
      {phase === "done" && summary && (
        <div className="w-full max-w-[440px]">
          <h1 className="text-xl font-semibold tracking-tight-brand text-fg-primary text-center">
            Here&rsquo;s what happened.
          </h1>
          <p className="mt-1 mb-5 text-center text-sm text-fg-secondary">&ldquo;{summary.query}&rdquo;</p>

          <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08] p-4">
            <div className="text-[11px] text-fg-secondary mb-2">Top matches</div>
            <div className="space-y-1.5">
              {summary.titles.map((t, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] text-fg-primary truncate">#{i + 1} {t.title}</span>
                  <span className="shrink-0 text-[12px] text-fg-secondary">{t.year} · {t.score}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08] px-2 py-2.5">
              <div className="text-lg font-semibold text-qdrant-red leading-none">{summary.serverMs < 1 ? "<1" : Math.round(summary.serverMs)}<span className="text-[11px]"> ms</span></div>
              <div className="mt-1 text-[10px] text-fg-secondary">in the engine</div>
            </div>
            <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08] px-2 py-2.5">
              <div className="text-lg font-semibold text-fg-primary leading-none">{summary.touchedPct}<span className="text-[11px]">%</span></div>
              <div className="mt-1 text-[10px] text-fg-secondary">of {summary.totalVectors.toLocaleString()} read</div>
            </div>
            <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08] px-2 py-2.5">
              <div className="text-lg font-semibold text-fg-primary leading-none">{summary.count}</div>
              <div className="mt-1 text-[10px] text-fg-secondary">answers</div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[10px]">
            <span className="rounded bg-white/[0.05] px-2 py-0.5 text-fg-secondary">ef {summary.ef}</span>
            {summary.rerank && <span className="rounded bg-qdrant-red/15 px-2 py-0.5 text-qdrant-red">re-ranked</span>}
            {summary.hybrid && <span className="rounded bg-qdrant-red/15 px-2 py-0.5 text-qdrant-red">hybrid RRF</span>}
          </div>

          <button
            onClick={reset}
            className="mt-5 w-full rounded-lg bg-qdrant-red py-3 text-base font-semibold text-white"
          >
            Search again
          </button>
        </div>
      )}

      {phase === "timeout" && (
        <div className="w-full max-w-[440px] text-center">
          <p className="text-sm text-fg-secondary">The screen looks busy. Your search may still show up there.</p>
          <button onClick={reset} className="mt-4 w-full rounded-lg bg-qdrant-red py-3 text-base font-semibold text-white">
            Try again
          </button>
        </div>
      )}

      <p className="mt-auto pt-8 text-[11px] text-fg-secondary/60">Powered by Qdrant Cloud · qdrant.tech</p>
    </div>
  );
}
