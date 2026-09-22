"use client";

import { useEffect, useRef, useState } from "react";
import { QdrantLogo } from "@/components/QdrantLogo";

interface Summary {
  error?: string;
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
/**
 * Pill, Section and Field live outside the page component on purpose: they
 * were redefined on every render, which remounts every control and loses
 * focus and transitions mid-interaction.
 *
 * Sizing follows the phone, not the desktop: a pill is ~40px tall so it is
 * a real tap target, and the grid wraps rather than scrolling sideways.
 */
function Pill({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3.5 py-2 text-[13px] font-medium leading-none transition-all ${
        active
          ? "bg-qdrant-red text-white shadow-[0_0_0_1px_rgba(220,36,76,0.5)]"
          : "bg-white/[0.05] text-fg-disabled ring-1 ring-white/[0.08] active:bg-white/[0.1]"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.07] pt-4 first:border-0 first:pt-0">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-secondary">
        {title}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({
  label, value, note, children,
}: { label: string; value?: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-fg-primary">{label}</span>
        {value && <span className="font-mono text-[11px] text-fg-secondary">{value}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {note && <div className="mt-2 text-[11px] leading-snug text-fg-secondary">{note}</div>}
    </div>
  );
}


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
  /**
   * Distance and graph density are build-time properties of a Qdrant
   * collection, not query parameters. Picking one here routes the search to
   * a sibling collection holding the same 19,907 films indexed differently,
   * which is why they are the two knobs that cannot be changed mid-flight.
   */
  const [distance, setDistance] = useState<"cosine" | "dot" | "euclid">("cosine");
  const [m, setM] = useState<4 | 16 | 64>(16);
  const [exact, setExact] = useState(false);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [decade, setDecade] = useState<[number, number] | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);

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
        body: JSON.stringify({ text: t, options: { ef, topK, genre, rerank, hybrid, distance, m, exact, threshold, decade, tenant } }),
      });
      const d = (await r.json()) as { ok?: boolean; id?: number; position?: number };
      if (!r.ok || !d.id) throw new Error();
      setPosition(d.position ?? 1);

      // Cycle the progress stages gently and forever — booth run length is
      // unpredictable (holds on hover, re-rank, a queue ahead), so we do NOT
      // guess timing. We simply wait for the real result to arrive.
      stageRef.current = setInterval(
        () => setStage((s) => (s + 1) % STAGES.length),
        3600,
      );

      // Poll for the booth's summary until it lands. Only after a very long
      // wait (5 min — far beyond any real queue) do we offer a gentle retry,
      // and even then we keep listening in case it shows up.
      const started = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - started > 300000) {
          setPhase((p) => (p === "done" ? p : "timeout"));
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

  /** How many knobs are off their defaults - shown on the collapsed row. */
  const tuned =
    (ef != null ? 1 : 0) + (topK !== 6 ? 1 : 0) + (genre ? 1 : 0) + (rerank ? 1 : 0) +
    (hybrid ? 1 : 0) + (distance !== "cosine" ? 1 : 0) + (m !== 16 ? 1 : 0) +
    (exact ? 1 : 0) + (threshold != null ? 1 : 0) + (decade ? 1 : 0) + (tenant ? 1 : 0);

  const resetOptions = () => {
    setEf(null); setTopK(6); setGenre(null); setRerank(false); setHybrid(false);
    setDistance("cosine"); setM(16); setExact(false); setThreshold(null);
    setDecade(null); setTenant(null);
  };

  const reset = () => {
    stopTimers();
    setPhase("idle");
    setSummary(null);
    setText("");
  };

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

            {/* Options - grouped, because eleven controls in one flat list
                is a wall. Retrieval is what runs, Index is how it is stored
                and walked, Filters are what gets excluded. */}
            <button
              type="button"
              onClick={() => setShowOptions((o) => !o)}
              className="mt-3 flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-4 py-3 text-left ring-1 ring-white/[0.08] active:bg-white/[0.07]"
            >
              <span className="text-[13px] font-medium text-fg-primary">Tune the search</span>
              <span className="flex items-center gap-2 text-[11px] text-fg-secondary">
                {tuned > 0 ? `${tuned} changed` : "defaults"}
                <span className={`transition-transform ${showOptions ? "rotate-180" : ""}`}>&#9662;</span>
              </span>
            </button>

            {showOptions && (
              <div className="mt-2 space-y-5 rounded-xl bg-bg-elev-1 p-4 text-left ring-1 ring-white/[0.08]">
                <Section title="Retrieval">
                  <Field label="Method" note="Hybrid fuses dense and keyword results inside Qdrant, in one request.">
                    <Pill active={!hybrid} onClick={() => setHybrid(false)}>Dense only</Pill>
                    <Pill active={hybrid} onClick={() => setHybrid(true)}>Hybrid RRF</Pill>
                  </Field>
                  <Field label="Re-rank" note="A cross-encoder re-reads the shortlist. Slower, better order.">
                    <Pill active={!rerank} onClick={() => setRerank(false)}>Off</Pill>
                    <Pill active={rerank} onClick={() => setRerank(true)}>On</Pill>
                  </Field>
                  <Field label="Results" value={`top ${topK}`}>
                    {[3, 6, 12].map((k) => (
                      <Pill key={k} active={topK === k} onClick={() => setTopK(k)}>{k}</Pill>
                    ))}
                  </Field>
                </Section>

                <Section title="Index">
                  <Field
                    label="Index"
                    note="Exact checks all 19,907 vectors. Perfect recall, and the thing the index exists to avoid at scale."
                  >
                    <Pill active={!exact} onClick={() => setExact(false)}>HNSW graph</Pill>
                    <Pill active={exact} onClick={() => setExact(true)}>Exact scan</Pill>
                  </Field>
                  <Field
                    label="Accuracy"
                    value={ef == null ? "ef auto" : `ef ${ef}`}
                    note="How many candidates the graph walk keeps. Higher is more accurate and slower."
                  >
                    <Pill active={ef == null} onClick={() => setEf(null)}>Auto</Pill>
                    {[16, 64, 128, 512].map((v) => (
                      <Pill key={v} active={ef === v} onClick={() => setEf(v)}>{v}</Pill>
                    ))}
                  </Field>
                  <Field
                    label="Distance metric"
                    value={distance}
                    note="Cosine compares direction, dot product direction and magnitude, Euclidean straight-line distance. Every vector here is unit length, so all three rank identically - which is the lesson: normalise, and the choice stops mattering."
                  >
                    <Pill active={distance === "cosine"} onClick={() => { setDistance("cosine"); setM(16); }}>Cosine</Pill>
                    <Pill active={distance === "dot"} onClick={() => { setDistance("dot"); setM(16); }}>Dot product</Pill>
                    <Pill active={distance === "euclid"} onClick={() => { setDistance("euclid"); setM(16); }}>Euclidean</Pill>
                  </Field>
                  <Field
                    label="Graph density"
                    value={distance === "cosine" ? `m ${m}` : "cosine index only"}
                    note="Links per node in the HNSW graph. More links, better recall, more memory."
                  >
                    {([4, 16, 64] as const).map((v) => (
                      <Pill
                        key={v}
                        active={m === v && distance === "cosine"}
                        onClick={() => { setDistance("cosine"); setM(v); }}
                      >
                        {v}
                      </Pill>
                    ))}
                  </Field>
                </Section>

                <Section title="Filters">
                  <Field label="Genre" value={genre ?? "all"}>
                    <Pill active={genre == null} onClick={() => setGenre(null)}>All</Pill>
                    {["drama", "sci-fi", "thriller", "comedy", "horror"].map((g) => (
                      <Pill key={g} active={genre === g} onClick={() => setGenre(g)}>{g}</Pill>
                    ))}
                  </Field>
                  <Field label="Decade" value={decade ? `${decade[0]} to ${decade[1]}` : "any"}>
                    <Pill active={decade == null} onClick={() => setDecade(null)}>Any</Pill>
                    {([["80s", [1980, 1989]], ["90s", [1990, 1999]], ["00s", [2000, 2009]], ["10s+", [2010, 2030]]] as const).map(
                      ([label, range]) => (
                        <Pill key={label} active={decade?.[0] === range[0]} onClick={() => setDecade([range[0], range[1]])}>
                          {label}
                        </Pill>
                      ),
                    )}
                  </Field>
                  <Field
                    label="Catalogue"
                    value={tenant ?? "all"}
                    note="Three tenants sharing one collection, kept apart by a payload filter rather than three deployments."
                  >
                    <Pill active={tenant == null} onClick={() => setTenant(null)}>All</Pill>
                    {[["StreamFlix", "streamflix"], ["CineMax", "cinemax"], ["NicheCast", "nichecast"]].map(([label, v]) => (
                      <Pill key={v} active={tenant === v} onClick={() => setTenant(v)}>{label}</Pill>
                    ))}
                  </Field>
                  <Field label="Minimum match" value={threshold == null ? "any" : `${Math.round(threshold * 100)}%`}>
                    <Pill active={threshold == null} onClick={() => setThreshold(null)}>Any</Pill>
                    {[0.3, 0.4, 0.5].map((t) => (
                      <Pill key={t} active={threshold === t} onClick={() => setThreshold(t)}>
                        {Math.round(t * 100)}%
                      </Pill>
                    ))}
                  </Field>
                </Section>

                {tuned > 0 && (
                  <button
                    type="button"
                    onClick={resetOptions}
                    className="w-full rounded-lg py-2 text-[12px] text-fg-secondary ring-1 ring-white/[0.08] active:bg-white/[0.05]"
                  >
                    Reset to defaults
                  </button>
                )}
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
          {position > 1 && (
            <div className="mb-4 rounded-lg bg-qdrant-red/10 ring-1 ring-qdrant-red/30 px-3 py-2 text-center text-[13px] text-qdrant-red">
              You&rsquo;re #{position} in line. Searches run one at a time — keep an eye on the screen.
            </div>
          )}
          <div className="space-y-2.5">
            {STAGES.map((s, i) => (
              <div key={s} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 transition-all ${
                i === stage ? "bg-qdrant-red/10 ring-qdrant-red/30"
                : "bg-white/[0.02] ring-white/[0.05] opacity-45"
              }`}>
                <span className="flex h-5 w-5 items-center justify-center">
                  {i === stage ? (
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

      {/* ── DONE with error ── */}
      {phase === "done" && summary?.error && (
        <div className="w-full max-w-[440px] text-center">
          <p className="text-sm text-fg-secondary">{summary.error}</p>
          <button onClick={reset} className="mt-5 w-full rounded-lg bg-qdrant-red py-3 text-base font-semibold text-white">
            Try again
          </button>
        </div>
      )}

      {/* ── DONE: the summary ── */}
      {phase === "done" && summary && !summary.error && (
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
          <div className="mx-auto mb-3 h-2.5 w-2.5 rounded-full bg-qdrant-red animate-pulse" />
          <p className="text-sm text-fg-secondary">
            The screen is busy — still listening for your result. If your search
            already played up there, the summary should arrive any moment.
          </p>
          <button onClick={reset} className="mt-5 w-full rounded-lg bg-qdrant-red py-3 text-base font-semibold text-white">
            Start over instead
          </button>
        </div>
      )}

      <p className="mt-auto pt-8 text-[11px] text-fg-secondary/60">Powered by Qdrant Cloud · qdrant.tech</p>
    </div>
  );
}
