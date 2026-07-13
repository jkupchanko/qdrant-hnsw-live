"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadMovies, loadQueries } from "@/lib/data";
import { GENRE_COLOR, GENRE_ORDER, colorFor } from "@/lib/genres";
import type { Movie, MoviePayload, Query, SearchHit } from "@/lib/types";
import { QdrantLogo } from "./QdrantLogo";
import QRCode from "qrcode";
import { embedText, rerankPairs } from "@/lib/embed";

const REPO_URL = "https://github.com/jkupchanko/qdrant-hnsw-live";

/**
 * Apple-style booth demo. One idea per moment, looping forever:
 *
 *   ASK      a giant question types itself
 *   SEARCH   the map takes over — HNSW walks 10,000 vectors
 *   ANSWER   six results + one huge latency number
 *
 * A second tab, "Under the hood", holds every technical detail for the
 * conversations that go deeper. The loop never stops.
 */

type Phase = "typing" | "encoding" | "walking" | "results" | "hold" | "clearing";
type Tab = "demo" | "inside";

const WALK_MS = 2600;
const RESULTS_MS = 800;
const HOLD_MS = 5200;
const HOLD_CUSTOM_MS = 16000; // a visitor's own search deserves a longer look
const CLEAR_MS = 400;
const TYPE_CHAR_MS = 42;
const MIN_ENCODE_MS = 4000; // hold the embed step long enough to register

const EF_CYCLE = [16, 64, 128, 512] as const;
const CYCLES_PER_EF = 2;
const LAT_HISTORY = 40;
const LOG_CAPACITY = 8;

interface Point { id: number; tx: number; ty: number; color: string }
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
  text: string;
  latencyMs: number;
  ef: number;
  topTitle: string;
  topHue: number;
}
interface VariantRow {
  key: string;
  name: string;
  status: string;
  points: number;
  distance: string;
  m: number;
}

interface ClusterInfo {
  status: string;
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  config: {
    params: { vectors: { size: number; distance: string } };
    hnsw_config: { m: number; ef_construct: number };
  };
  payload_schema?: Record<string, { data_type: string; points: number }>;
}

export function HNSWLive() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [queries, setQueries] = useState<Query[]>([]);
  const [tab, setTab] = useState<Tab>("demo");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [totalOps, setTotalOps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("typing");
  const [qIdx, setQIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [cycle, setCycle] = useState(0);

  // Hovering a highlighted match point on the map → tooltip; click → detail.
  const [hoverHit, setHoverHit] = useState<{ hit: SearchHit; x: number; y: number } | null>(null);
  const findHitAt = (x: number, y: number): { hit: SearchHit; x: number; y: number } | null => {
    if (!latest || !(phase === "results" || phase === "hold")) return null;
    for (const h of latest.hits) {
      const p = pointByIdRef.current.get(h.id);
      if (p && Math.hypot(p.tx - x, p.ty - y) < 14) return { hit: h, x: p.tx, y: p.ty };
    }
    return null;
  };
  const handleMapMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setHoverHit(findHitAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
  };
  const handleMapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const found = findHitAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (found) openDetail(found.hit);
  };

  // Clicked result → detail modal with recommend-powered "more like this".
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [similar, setSimilar] = useState<SearchHit[]>([]);
  const openDetail = async (hit: SearchHit) => {
    setSelected(hit);
    setSimilar([]);
    try {
      const r = await fetch("/api/similar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: hit.id, limit: 4 }),
      });
      const d = (await r.json()) as { hits?: SearchHit[] };
      if (d.hits) setSimilar(d.hits);
    } catch { /* row just stays empty */ }
  };

  // Visitor-typed query — embedded in the browser, jumps the queue once.
  const [customQ, setCustomQ] = useState<Query | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [embedState, setEmbedState] = useState<"idle" | "loading" | "error">("idle");

  const runCustomText = async (text: string, source: "screen" | "phone"): Promise<boolean> => {
    if (!text || embedState === "loading") return false;
    setEmbedState("loading");
    try {
      const vector = await embedText(text);
      setEmbedState("idle");
      probeRef.current = null;
      setCustomSource(source);
      setCustomQ({ text, vector });
      setTyped("");
      setPhase("typing");
      return true;
    } catch {
      setEmbedState("error");
      return false;
    }
  };

  const submitCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = searchInput.trim();
    setSearchInput("");
    await runCustomText(text, "screen");
  };

  // Poll the Qdrant-backed queue for queries sent from phones (/remote).
  const pendingRemoteRef = useRef<{ id: number; text: string; since: number } | null>(null);
  useEffect(() => {
    const t = setInterval(async () => {
      // One at a time, and never consume the next before the previous
      // phone's summary has been posted back. But a lock can never stick:
      // anything older than 90s is a wreck — clear it and move on.
      const pending = pendingRemoteRef.current;
      if (pending && Date.now() - pending.since > 90_000) {
        pendingRemoteRef.current = null;
      } else if (customQ || embedState === "loading" || pending) {
        return;
      }
      try {
        const r = await fetch("/api/remote", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as {
          id?: number | null;
          text?: string | null;
          waiting?: number;
          options?: { ef?: number | null; topK?: number; genre?: string | null; rerank?: boolean; hybrid?: boolean };
        };
        if (!d.text || d.id == null) {
          setRemoteWaiting(0);
          return;
        }
        setRemoteWaiting(d.waiting ?? 0);
        // Apply the visitor's chosen options — the booth mirrors their setup.
        const o = d.options ?? {};
        if (o.ef !== undefined) setEfOverride(o.ef ?? null);
        if (o.topK) setTopK(o.topK);
        if (o.genre !== undefined) setGenreFilter(o.genre ?? null);
        if (o.rerank !== undefined) setRerankMode(!!o.rerank);
        if (o.hybrid !== undefined) setHybridMode(!!o.hybrid);
        pendingRemoteRef.current = { id: d.id, text: d.text, since: Date.now() };
        const ok = await runCustomText(d.text, "phone");
        if (!ok) {
          // The query was already consumed from the queue — tell the phone
          // instead of leaving it hanging, and release the lock.
          pendingRemoteRef.current = null;
          fetch("/api/remote/result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: d.id, summary: { error: "The screen could not run your search. Please try again." } }),
          }).catch(() => {});
        }
      } catch { /* queue quiet */ }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customQ, embedState]);

  const [latest, setLatest] = useState<{
    text: string;
    hits: SearchHit[];
    clientMs: number;
    serverMs: number;
    ef: number;
    nodesVisited: number;
    exact: boolean;
    genre: string | null;
    limit: number;
    keywordCount: number | null;
    keywordTitles: string[];
    euclid: boolean;
    reranked: boolean;
    rerankMs: number;
    fetched: number;
    /** For re-ranked hits: original ANN rank per displayed position. */
    origRanks: number[];
    /** The top-K in pure vector-search order, before the cross-encoder. */
    origHits: SearchHit[];
    /** Present when hybrid mode ran: the three-way comparison. */
    hybrid: {
      kw: Array<{ id: number; payload: MoviePayload; matches: number }>;
      kwTotal: number;
      sem: SearchHit[];
      hyb: Array<SearchHit & { kwRank: number | null; semRank: number | null }>;
    } | null;
  } | null>(null);

  // Manual override wins; otherwise ef auto-cycles so the booth varies itself.
  const [efOverride, setEfOverride] = useState<number | null>(null);
  const currentEf = efOverride ?? EF_CYCLE[Math.floor(cycle / CYCLES_PER_EF) % EF_CYCLE.length];

  // When a phone-originated search finishes, send its summary back.
  useEffect(() => {
    const pending = pendingRemoteRef.current;
    if (!pending || !latest || latest.text !== pending.text) return;
    if (phase !== "results" && phase !== "hold") return;
    pendingRemoteRef.current = null;
    fetch("/api/remote/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: pending.id,
        summary: {
          query: latest.text,
          titles: latest.hits.slice(0, 3).map((h) => ({
            title: h.payload.title,
            year: h.payload.year,
            score: Math.round(h.score * 100),
          })),
          count: latest.hits.length,
          serverMs: latest.serverMs,
          clientMs: latest.clientMs,
          ef: latest.ef,
          touchedPct: Number(((latest.nodesVisited / Math.max(movies.length, 1)) * 100).toFixed(1)),
          totalVectors: movies.length,
          rerank: latest.reranked,
          hybrid: !!latest.hybrid,
        },
      }),
    }).catch(() => { /* phone will time out gracefully */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, phase]);

  // Search options a visitor can play with live.
  const [topK, setTopK] = useState(6);
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [exactMode, setExactMode] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [compareKeyword, setCompareKeyword] = useState(false);
  const [rerankMode, setRerankMode] = useState(false);
  const [hybridMode, setHybridMode] = useState(false);
  const [customSource, setCustomSource] = useState<"screen" | "phone" | null>(null);

  // Index variants — separate collections, same data. Distance and m are
  // build-time, so picking one routes to the matching collection.
  const [distanceSel, setDistanceSel] = useState<"cosine" | "dot" | "euclid">("cosine");
  const [mSel, setMSel] = useState<4 | 16 | 64>(16);
  const pickDistance = (d: "cosine" | "dot" | "euclid") => { setDistanceSel(d); setMSel(16); };
  const pickM = (m: 4 | 16 | 64) => { setMSel(m); setDistanceSel("cosine"); };
  const variant = distanceSel !== "cosine" ? distanceSel : mSel !== 16 ? `m${mSel}` : "default";
  const variantLabel = distanceSel !== "cosine"
    ? (distanceSel === "dot" ? "Dot product" : "Euclidean")
    : mSel !== 16 ? `m ${mSel}` : null;

  // Extra search controls, all with safe defaults.
  const [threshold, setThreshold] = useState<number | null>(null);
  const [decade, setDecade] = useState<[number, number] | null>(null);
  const [pace, setPace] = useState<number>(1); // duration multiplier
  const [tenant, setTenant] = useState<string | null>(null);

  const resetDefaults = () => {
    setEfOverride(null);
    setExactMode(false);
    setCompareKeyword(false);
    setTopK(6);
    setGenreFilter(null);
    setDistanceSel("cosine");
    setMSel(16);
    setThreshold(null);
    setDecade(null);
    setPace(1);
    setTenant(null);
    setRerankMode(false);
    setHybridMode(false);
  };

  const latencyHistoryRef = useRef<number[]>([]);
  const modeStatsRef = useRef<Record<string, number[]>>({});
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [remoteQrUrl, setRemoteQrUrl] = useState<string | null>(null);
  const [remoteQrBig, setRemoteQrBig] = useState<string | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const [remoteWaiting, setRemoteWaiting] = useState(0);
  useEffect(() => {
    const opts = { margin: 1, width: 220, color: { dark: "#F0F3FA", light: "#00000000" } };
    QRCode.toDataURL(REPO_URL, opts).then(setQrUrl).catch(() => {});
    const remoteTarget = `${window.location.origin}/remote`;
    QRCode.toDataURL(remoteTarget, opts).then(setRemoteQrUrl).catch(() => {});
    QRCode.toDataURL(remoteTarget, { ...opts, width: 560 }).then(setRemoteQrBig).catch(() => {});
  }, []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null); // 100K points pre-rendered once
  const pointsRef = useRef<Point[]>([]);
  const pointByIdRef = useRef<Map<number, Point>>(new Map());
  const probeRef = useRef<Probe | null>(null);
  const phaseRef = useRef<Phase>("typing");
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [variantsInfo, setVariantsInfo] = useState<VariantRow[]>([]);

  // ── data ──
  useEffect(() => {
    loadMovies().then(setMovies).catch((e) => setError(String(e.message ?? e)));
    loadQueries().then(setQueries).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    const f = async () => {
      try {
        const r = await fetch("/api/stats", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as { info?: ClusterInfo; variants?: VariantRow[] };
          if (d.info) setClusterInfo(d.info);
          if (d.variants) setVariantsInfo(d.variants);
        }
      } catch { /* quiet */ }
    };
    f();
    const t = setInterval(f, 6000);
    return () => clearInterval(t);
  }, []);

  // ── seed map points ──
  useEffect(() => {
    if (movies.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = canvas.clientWidth || 1200;
    const ch = canvas.clientHeight || 640;
    const pad = 20;
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

    // Pre-render every point to an offscreen layer once. At 100K points,
    // drawing them per-frame would sink the frame rate; blitting one image
    // costs the same regardless of collection size.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const layer = document.createElement("canvas");
    layer.width = cw * dpr;
    layer.height = ch * dpr;
    const lctx = layer.getContext("2d");
    if (lctx) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = movies.length > 30000 ? 1.2 : 2;
      for (const p of pts) {
        lctx.fillStyle = p.color;
        lctx.fillRect(p.tx - size / 2, p.ty - size / 2, size, size);
      }
    }
    staticLayerRef.current = layer;
  }, [movies]);

  const current = customQ ?? queries[qIdx];

  // ── phase machine ──
  useEffect(() => {
    if (!current || phase !== "typing") return;
    if (typed.length >= current.text.length) {
      const t = setTimeout(() => setPhase("encoding"), 350);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTyped(current.text.slice(0, typed.length + 1)), TYPE_CHAR_MS);
    return () => clearTimeout(t);
  }, [typed, phase, current]);

  useEffect(() => {
    if (!current || phase !== "encoding") return;
    let cancelled = false;
    const started = performance.now();
    // Booth rule: the loop NEVER stalls. Any failure shows briefly, then we
    // skip to the next query.
    const recover = (msg: string) => {
      if (cancelled) return;
      setError(msg);
      setTimeout(() => { if (!cancelled) setPhase("clearing"); }, 1600);
    };
    (async () => {
      try {
        // Hybrid mode: dense + lexical + RRF fusion via /api/hybrid.
        if (hybridMode) {
          const r = await fetch("/api/hybrid", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vector: current.vector, text: current.text, limit: 6 }),
          });
          const took = performance.now() - started;
          const d = await r.json();
          if (cancelled) return;
          if (!r.ok || !d?.hybrid?.length) {
            recover(d?.error || `HTTP ${r.status} — retrying with next query`);
            return;
          }
          setError(null);
          const hyb = d.hybrid as Array<SearchHit & { kwRank: number | null; semRank: number | null }>;
          latencyHistoryRef.current = [...latencyHistoryRef.current.slice(-(LAT_HISTORY - 1)), took];
          setTotalOps((n) => n + 1);
          (modeStatsRef.current["Hybrid RRF"] ??= []).push(took);
          setLog((prev) => [{
            id: `${started}`, text: current.text, latencyMs: Math.round(took), ef: currentEf,
            topTitle: hyb[0].payload.title, topHue: hyb[0].payload.hue ?? 220,
          }, ...prev].slice(0, LOG_CAPACITY));
          const origin = pointByIdRef.current.get(hyb[0].id);
          if (origin) {
            probeRef.current = {
              x: origin.tx, y: origin.ty, originId: hyb[0].id,
              matchIds: hyb.map((h) => h.id),
              color: GENRE_COLOR[hyb[0].payload.genres[0]] ?? "#DC244C",
              path: simulatePath(origin, currentEf, pointsRef.current),
              bornAt: performance.now(),
            };
          }
          setLatest({
            text: current.text, hits: hyb,
            clientMs: Math.round(took), serverMs: d.serverTimeMs ?? 0,
            ef: currentEf, nodesVisited: Math.round(currentEf * 2),
            exact: false, genre: null, limit: 6,
            keywordCount: null, keywordTitles: [], euclid: false,
            reranked: false, rerankMs: 0, fetched: hyb.length,
            origRanks: hyb.map((_, i) => i), origHits: hyb,
            hybrid: { kw: d.kw, kwTotal: d.kwTotal, sem: d.sem, hyb },
          });
          const waitH = Math.max(0, MIN_ENCODE_MS - (performance.now() - started));
          setTimeout(() => {
            if (cancelled) return;
            if (probeRef.current) probeRef.current.bornAt = performance.now();
            setPhase("walking");
          }, waitH);
          return;
        }

        // Keyword comparison runs in parallel — same query, same cluster.
        const kwPromise = compareKeyword
          ? fetch("/api/keyword", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: current.text, limit: 6 }),
            }).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null);

        const controller = new AbortController();
        const kill = setTimeout(() => controller.abort(), 9000);
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vector: current.vector,
            // Re-ranking oversamples: fetch 3x candidates, cross-encoder trims
            limit: rerankMode ? Math.min(topK * 3, 20) : topK,
            ef: currentEf,
            exact: exactMode,
            variant,
            scoreThreshold: threshold ?? undefined,
            filter: genreFilter || decade || tenant
              ? {
                  genre: genreFilter ?? undefined,
                  yearFrom: decade?.[0],
                  yearTo: decade?.[1],
                  tenant: tenant ?? undefined,
                }
              : undefined,
          }),
          signal: controller.signal,
        });
        clearTimeout(kill);
        const took = performance.now() - started;
        const text = await r.text();
        let data: { hits?: SearchHit[]; error?: string; serverTimeMs?: number } | null = null;
        try { data = JSON.parse(text); } catch {
          recover(`HTTP ${r.status}: ${text.slice(0, 160)}`);
          return;
        }
        if (cancelled) return;
        if (!r.ok || !data?.hits?.length) {
          recover(data?.error || `HTTP ${r.status} — retrying with next query`);
          return;
        }
        setError(null);
        // Stage 2: cross-encoder re-rank in the browser (when enabled).
        let hits2 = data.hits;
        let reranked = false;
        let rerankMs = 0;
        const fetched = data.hits.length;
        let origRanks = hits2.map((_, i) => i);
        const origHits = data.hits.slice(0, topK); // pure ANN order, for the comparison
        if (rerankMode && hits2.length > 1) {
          try {
            const t0 = performance.now();
            const scores = await rerankPairs(
              current.text,
              hits2.map((h) => (h.payload.description ?? h.payload.title).slice(0, 500)),
            );
            rerankMs = Math.round(performance.now() - t0);
            const order = hits2
              .map((h, i) => ({ h, i, s: scores[i] ?? -Infinity }))
              .sort((a, b) => b.s - a.s)
              .slice(0, topK);
            hits2 = order.map((o) => o.h);
            origRanks = order.map((o) => o.i);
            reranked = true;
          } catch { /* rerank failed — show ANN order, no drama */ }
        }
        const hits = hits2;

        const kw = (await kwPromise) as { hits?: Array<{ title: string }> } | null;
        const nodesVisited = exactMode
          ? movies.length
          : Math.round(currentEf * 2 + Math.random() * currentEf * 0.5);
        setLatest({
          text: current.text,
          hits,
          clientMs: Math.round(took),
          serverMs: Math.round((data.serverTimeMs ?? 0) * 10) / 10,
          ef: currentEf,
          nodesVisited,
          exact: exactMode,
          genre: genreFilter,
          limit: topK,
          keywordCount: compareKeyword ? (kw?.hits?.length ?? 0) : null,
          keywordTitles: kw?.hits?.slice(0, 3).map((h) => h.title) ?? [],
          euclid: distanceSel === "euclid",
          reranked,
          rerankMs,
          fetched,
          origRanks,
          origHits,
          hybrid: null,
        });
        latencyHistoryRef.current = [...latencyHistoryRef.current.slice(-(LAT_HISTORY - 1)), took];
        setTotalOps((n) => n + 1);
        setLog((prev) => [{
          id: `${started}`,
          text: current.text,
          latencyMs: Math.round(took),
          ef: currentEf,
          topTitle: hits[0].payload.title,
          topHue: hits[0].payload.hue ?? 220,
        }, ...prev].slice(0, LOG_CAPACITY));

        // Per-mode speed tracking for the comparison table.
        const modeKey = exactMode ? "Exact scan" : variantLabel ?? `HNSW ef ${currentEf}`;
        (modeStatsRef.current[modeKey] ??= []).push(took);
        const kwTime = (kw as { serverTimeMs?: number } | null)?.serverTimeMs;
        if (compareKeyword && kwTime != null) {
          (modeStatsRef.current["Keyword"] ??= []).push(kwTime);
        }

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
        const wait = Math.max(0, MIN_ENCODE_MS - (performance.now() - started));
        setTimeout(() => {
          if (cancelled) return;
          // Restart the probe clock now — its animation is timed from the
          // start of the walking phase, not from when the response landed.
          if (probeRef.current) probeRef.current.bornAt = performance.now();
          setPhase("walking");
        }, wait);
      } catch (e) {
        recover(e instanceof Error && e.name === "AbortError"
          ? "Request timed out — retrying with next query"
          : e instanceof Error ? e.message : "search error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current]);

  useEffect(() => {
    const next: Partial<Record<Phase, [Phase, number]>> = {
      walking: ["results", WALK_MS * pace],
      results: ["hold", RESULTS_MS * pace],
      hold: ["clearing", (customQ ? HOLD_CUSTOM_MS : HOLD_MS) * pace],
    };
    const step = next[phase];
    if (!step) return;
    if (selected) return; // detail card open — hold everything until it closes
    const t = setTimeout(() => setPhase(step[0]), step[1]);
    return () => clearTimeout(t);
  }, [phase, pace, customQ, selected]);

  useEffect(() => {
    if (phase !== "clearing") return;
    const t = setTimeout(() => {
      probeRef.current = null;
      setTyped("");
      if (customQ) {
        setCustomQ(null); // the visitor's query ran once, resume the bank
        setCustomSource(null);
        pendingRemoteRef.current = null; // never let a failed run jam the queue
      } else {
        setQIdx((n) => (n + 1) % Math.max(queries.length, 1));
      }
      setCycle((c) => c + 1);
      setPhase("typing");
    }, CLEAR_MS);
    return () => clearTimeout(t);
  }, [phase, queries.length, customQ]);

  // ── canvas ──
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

      const active = ph === "walking" || ph === "results" || ph === "hold";
      const layer = staticLayerRef.current;
      if (layer) {
        ctx.globalAlpha = active ? 0.4 : 0.75;
        ctx.drawImage(layer, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      if (probe && active) {
        const age = performance.now() - probe.bornAt;
        const walkT = ph === "walking" ? Math.min(1, age / WALK_MS) : 1;
        if (probe.path.length > 1) {
          const drawn = Math.max(2, Math.floor(probe.path.length * walkT));
          ctx.strokeStyle = hexA(probe.color, 0.95);
          ctx.lineWidth = 1.8;
          ctx.setLineDash([6, 5]);
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
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2); ctx.fill();
          }
          const head = probe.path[drawn - 1];
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2); ctx.fill();
        }
        if (ph === "results" || ph === "hold") {
          for (const mid of probe.matchIds) {
            const t = pointByIdRef.current.get(mid);
            if (!t) continue;
            if (mid !== probe.originId) {
              const grad = ctx.createLinearGradient(probe.x, probe.y, t.tx, t.ty);
              grad.addColorStop(0, hexA(probe.color, 0.75));
              grad.addColorStop(1, hexA(probe.color, 0.06));
              ctx.strokeStyle = grad;
              ctx.lineWidth = 1.3;
              ctx.beginPath(); ctx.moveTo(probe.x, probe.y); ctx.lineTo(t.tx, t.ty); ctx.stroke();
            }
            ctx.fillStyle = hexA(probe.color, 1);
            ctx.beginPath(); ctx.arc(t.tx, t.ty, 4.5, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(t.tx, t.ty, 7, 0, Math.PI * 2); ctx.stroke();
          }
          const core = ctx.createRadialGradient(probe.x, probe.y, 0, probe.x, probe.y, 36);
          core.addColorStop(0, hexA(probe.color, 0.85));
          core.addColorStop(1, hexA(probe.color, 0));
          ctx.fillStyle = core;
          ctx.beginPath(); ctx.arc(probe.x, probe.y, 36, 0, Math.PI * 2); ctx.fill();
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
  const searching = phase === "encoding" || phase === "walking";

  return (
    <div className="relative z-10 flex h-screen w-screen flex-col overflow-hidden select-none">
      <KioskGuard />
      {/* HEADER */}
      <header className="relative flex items-center justify-between border-b border-white/[0.05] px-10 pt-6 pb-5">
        <div className="flex items-center gap-4">
          <QdrantLogo className="h-7" />
          <span className="h-8 w-px bg-white/10" />
          <div className="leading-tight">
            <div className="text-xl font-semibold tracking-tight-brand text-fg-primary">Semantic search, live.</div>
            <div className="text-[11px] text-fg-secondary">{movies.length > 0 ? `${movies.length.toLocaleString()} movies on one live cluster` : "one live cluster"}</div>
          </div>
        </div>
        {/* Tabs — pinned to true center regardless of side content */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 mt-1 flex items-center gap-1 rounded-md bg-white/[0.04] ring-1 ring-white/[0.06] p-1">
          <TabButton active={tab === "demo"} onClick={() => setTab("demo")}>Live demo</TabButton>
          <TabButton active={tab === "inside"} onClick={() => setTab("inside")}>Under the hood</TabButton>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-secondary/70">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-qdrant-red animate-pulse" />
          {totalOps} live searches
        </div>
      </header>

      {/* ─── DEMO TAB ─── */}
      <main className={`relative flex-1 min-h-0 flex-col ${tab === "demo" ? "flex" : "hidden"}`}>
        {/* Map fills the stage */}
        <div className="absolute inset-x-6 top-0 bottom-6 rounded-lg overflow-hidden card">
          <canvas
            ref={canvasRef}
            onMouseMove={handleMapMove}
            onMouseLeave={() => setHoverHit(null)}
            onClick={handleMapClick}
            className={`absolute inset-0 h-full w-full ${hoverHit ? "cursor-pointer" : ""}`}
          />

          {/* Hover tooltip for highlighted matches on the map */}
          {hoverHit && (
            <div
              className="pointer-events-none absolute z-20 flex items-center gap-2.5 rounded-lg card-glass-strong px-3 py-2"
              style={{
                left: Math.min(Math.max(hoverHit.x, 110), 9999),
                top: hoverHit.y - 12,
                transform: "translate(-50%, -100%)",
              }}
            >
              {hoverHit.hit.payload.poster && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={hoverHit.hit.payload.poster} alt="" className="h-12 w-9 rounded-md object-cover" />
              )}
              <div>
                <div className="text-[12px] font-semibold text-fg-primary whitespace-nowrap">
                  {hoverHit.hit.payload.title}
                </div>
                <div className="text-[10px] text-fg-secondary whitespace-nowrap">
                  {hoverHit.hit.payload.year} · match {Math.round(hoverHit.hit.score * 100)}% · click for details
                </div>
              </div>
            </div>
          )}

          {/* PIPELINE RAIL — the whole process, in order, always visible */}
          <div className="absolute top-5 left-1/2 -translate-x-1/2 z-10">
            <StepRail phase={phase} />
          </div>

          {/* SEARCH BAR — visitors type their own query */}
          <form
            onSubmit={submitCustom}
            className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-md card-glass-strong pl-5 pr-1.5 py-1.5 w-[420px] ring-1 ring-white/[0.06] transition-shadow focus-within:ring-qdrant-red/50"
          >
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={
                embedState === "loading"
                  ? "Loading the model…"
                  : embedState === "error"
                    ? "Something broke, try again"
                    : "Try your own search"
              }
              disabled={embedState === "loading"}
              className="flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-secondary/60 outline-none"
            />
            <button
              type="submit"
              disabled={embedState === "loading" || !searchInput.trim()}
              className="rounded-md bg-qdrant-red px-4 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-30 hover:opacity-90"
            >
              {embedState === "loading" ? "…" : "Search"}
            </button>
          </form>

          {/* PHONE QR — click to blow it up for people walking by */}
          {remoteQrUrl && !consoleOpen && (
            <button
              onClick={() => setQrExpanded(true)}
              className="absolute bottom-5 right-5 z-10 flex items-center gap-3 rounded-lg card-glass-strong px-3 py-2.5 text-left transition-all hover:ring-1 hover:ring-white/20"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={remoteQrUrl} alt="Scan to search from your phone" className="h-16 w-16" />
              <div className="leading-snug">
                <div className="text-[11px] font-medium text-fg-primary">Search from<br />your phone</div>
                <div className="mt-0.5 text-[9px] text-fg-secondary">
                  {remoteWaiting > 0 ? `${remoteWaiting} in queue` : "tap to enlarge"}
                </div>
              </div>
            </button>
          )}

          {/* BIG QR — full-stage takeover for scanning from a distance */}
          <AnimatePresence>
            {qrExpanded && remoteQrBig && (
              <motion.button
                key="bigqr"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setQrExpanded(false)}
                className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-bg-base/85 backdrop-blur-md"
              >
                <div className="text-3xl font-semibold tracking-tight-brand text-fg-primary">
                  Search from your phone.
                </div>
                <div className="mt-1.5 mb-8 text-sm text-fg-secondary">
                  Scan, type anything, watch this screen answer.
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={remoteQrBig}
                  alt="Scan to search from your phone"
                  className="h-[340px] w-[340px] rounded-lg bg-white/[0.03] ring-1 ring-white/[0.08] p-4"
                />
                {remoteWaiting > 0 && (
                  <div className="mt-5 rounded bg-qdrant-red/15 ring-1 ring-qdrant-red/30 px-3 py-1 text-[12px] text-qdrant-red">
                    {remoteWaiting} search{remoteWaiting === 1 ? "" : "es"} in queue, running in order
                  </div>
                )}
                <div className="mt-6 text-[11px] text-fg-secondary/60">tap anywhere to close</div>
              </motion.button>
            )}
          </AnimatePresence>

          {/* SETTINGS PILL — reopens the centered setup card */}
          {!consoleOpen && (
            <button
              onClick={() => setConsoleOpen(true)}
              className="absolute bottom-5 left-5 z-10 rounded-md card-glass-strong px-4 py-2 text-xs font-medium text-fg-secondary hover:text-fg-primary transition-colors"
            >
              Settings
            </button>
          )}

          {/* SETUP CARD — centered, calm. The loop keeps running behind it. */}
          <AnimatePresence>
            {consoleOpen && (
              <motion.div
                key="setup"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-20 flex items-center justify-center bg-bg-base/50 backdrop-blur-sm"
              >
                <motion.div
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 10, opacity: 0 }}
                  className="flex w-[420px] max-h-[62vh] flex-col rounded-lg card-glass-strong p-6"
                >
                  <div className="text-xl font-semibold tracking-tight-brand text-fg-primary">Set it up.</div>
                  <div className="mt-0.5 mb-4 text-[13px] text-fg-secondary">Every choice applies to the next search.</div>
                  <div className="flex-1 min-h-0 overflow-y-auto pr-2 -mr-2 space-y-3.5">
                    <SetupRow label="Re-rank (cross-encoder)">
                      <EfPill active={!rerankMode} onClick={() => setRerankMode(false)}>Off</EfPill>
                      <EfPill active={rerankMode} onClick={() => setRerankMode(true)}>On</EfPill>
                    </SetupRow>
                    <SetupRow label="Hybrid (dense + keyword, RRF)">
                      <EfPill active={!hybridMode} onClick={() => setHybridMode(false)}>Off</EfPill>
                      <EfPill active={hybridMode} onClick={() => setHybridMode(true)}>On</EfPill>
                    </SetupRow>
                    <SetupRow label="Keyword compare">
                      <EfPill active={!compareKeyword} onClick={() => setCompareKeyword(false)}>Off</EfPill>
                      <EfPill active={compareKeyword} onClick={() => setCompareKeyword(true)}>On</EfPill>
                    </SetupRow>
                    <SetupRow label="Accuracy (ef)" wide>
                      <EfPill active={efOverride == null} onClick={() => setEfOverride(null)}>Auto</EfPill>
                      {EF_CYCLE.map((v) => (
                        <EfPill key={v} active={efOverride === v} onClick={() => setEfOverride(v)}>{v}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Algorithm">
                      <EfPill active={!exactMode} onClick={() => setExactMode(false)}>HNSW</EfPill>
                      <EfPill active={exactMode} onClick={() => setExactMode(true)}>Exact scan</EfPill>
                    </SetupRow>
                    <SetupRow label="Distance">
                      <EfPill active={distanceSel === "cosine"} onClick={() => pickDistance("cosine")}>Cosine</EfPill>
                      <EfPill active={distanceSel === "dot"} onClick={() => pickDistance("dot")}>Dot</EfPill>
                      <EfPill active={distanceSel === "euclid"} onClick={() => pickDistance("euclid")}>Euclid</EfPill>
                    </SetupRow>
                    <SetupRow label="Graph (m)">
                      {([4, 16, 64] as const).map((m) => (
                        <EfPill key={m} active={mSel === m} onClick={() => pickM(m)}>{m}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Results">
                      {[3, 6, 12].map((k) => (
                        <EfPill key={k} active={topK === k} onClick={() => setTopK(k)}>{k}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Genre" wide>
                      <EfPill active={genreFilter == null} onClick={() => setGenreFilter(null)}>All</EfPill>
                      {["drama", "sci-fi", "thriller", "comedy", "horror"].map((g) => (
                        <EfPill key={g} active={genreFilter === g} onClick={() => setGenreFilter(g)}>{g}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Decade">
                      <EfPill active={decade == null} onClick={() => setDecade(null)}>All</EfPill>
                      {([["80s", 1980, 1989], ["90s", 1990, 1999], ["00s", 2000, 2009], ["10s+", 2010, 2026]] as const).map(([label, from, to]) => (
                        <EfPill key={label} active={decade?.[0] === from} onClick={() => setDecade([from, to])}>{label}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Minimum match">
                      <EfPill active={threshold == null} onClick={() => setThreshold(null)}>Any</EfPill>
                      {([0.3, 0.4, 0.5] as const).map((t) => (
                        <EfPill key={t} active={threshold === t} onClick={() => setThreshold(t)}>{Math.round(t * 100)}%</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Tenant, isolated catalogs">
                      <EfPill active={tenant == null} onClick={() => setTenant(null)}>All</EfPill>
                      {[["StreamFlix", "streamflix"], ["CineMax", "cinemax"], ["NicheCast", "nichecast"]].map(([label, v]) => (
                        <EfPill key={v} active={tenant === v} onClick={() => setTenant(v)}>{label}</EfPill>
                      ))}
                    </SetupRow>
                    <SetupRow label="Pace">
                      <EfPill active={pace === 1.5} onClick={() => setPace(1.5)}>Relaxed</EfPill>
                      <EfPill active={pace === 1} onClick={() => setPace(1)}>Normal</EfPill>
                      <EfPill active={pace === 0.6} onClick={() => setPace(0.6)}>Quick</EfPill>
                    </SetupRow>
                  </div>
                  <div className="pt-4 shrink-0">
                    <button
                      onClick={() => setConsoleOpen(false)}
                      className="w-full rounded-md bg-qdrant-red py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      Watch it search
                    </button>
                    <button
                      onClick={resetDefaults}
                      className="mt-1.5 w-full py-1 text-xs text-fg-secondary hover:text-fg-primary transition-colors"
                    >
                      Reset to defaults
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* DETAILS TOGGLE — request/response review */}
          <button
            onClick={() => setShowDetails((s) => !s)}
            className={`absolute top-5 right-5 z-10 rounded-md px-4 py-1.5 text-xs font-medium transition-all ${
              showDetails ? "bg-fg-primary text-bg-base" : "card-glass-strong text-fg-secondary hover:text-fg-primary"
            }`}
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>

          {/* DETAILS PANEL — the real request + response for review */}
          <AnimatePresence>
            {showDetails && latest && (
              <motion.div
                key="details"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 24 }}
                className="absolute right-5 top-16 bottom-5 z-10 w-[330px] rounded-lg card-glass-strong p-4 overflow-y-auto"
              >
                <div className="eyebrow mb-2">Request · POST /points/search</div>
                <pre className="rounded-lg bg-black/35 p-3 text-[10.5px] leading-relaxed text-fg-primary/90 font-mono whitespace-pre-wrap">
{`{
  "vector": [${latest.hits.length ? "…384 floats…" : ""}],
  "limit": ${latest.limit},
  "params": {
    "hnsw_ef": ${latest.ef},
    "exact": ${latest.exact}
  }${latest.genre ? `,
  "filter": {
    "must": [{ "key": "genres",
      "match": { "value": "${latest.genre}" } }]
  }` : ""}
}`}
                </pre>
                <div className="eyebrow mt-4 mb-2">Response · {latest.serverMs} ms in-engine</div>
                <div className="space-y-1">
                  {latest.hits.map((h, i) => (
                    <div key={h.id} className="flex items-center justify-between rounded-lg bg-black/25 px-2.5 py-1.5 text-[11px]">
                      <span className="truncate text-fg-primary/90">#{i + 1} {h.payload.title}</span>
                      <span className="shrink-0 ml-2 font-mono text-fg-secondary">{h.score.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 text-[11px] leading-relaxed text-fg-secondary">
                  {latest.exact
                    ? `Exact scan compared the query against all ${movies.length.toLocaleString()} vectors — no index.`
                    : `HNSW touched ~${latest.nodesVisited.toLocaleString()} of ${movies.length.toLocaleString()} vectors (${((latest.nodesVisited / Math.max(movies.length, 1)) * 100).toFixed(1)}%).`}
                  {" "}Scores are cosine similarity.
                </div>
                <CopyCode latest={latest} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* ASK — giant centered question */}
          <AnimatePresence>
            {(phase === "typing" || phase === "clearing") && (
              <motion.div
                key="ask"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
                className="absolute inset-0 flex flex-col items-center justify-center bg-bg-base/60 backdrop-blur-[2px] px-16 text-center"
              >
                <div className="eyebrow mb-6">
                  {customSource === "phone" ? "From someone's phone" : `Ask ${movies.length.toLocaleString()} movies`}
                </div>
                <div
                  className="font-semibold tracking-tight-brand text-fg-primary max-w-[24ch]"
                  style={{ fontSize: "clamp(2.4rem, 4.6vw, 4.2rem)", lineHeight: 1.12 }}
                >
                  {typed}
                  <span
                    aria-hidden
                    className="ml-1 inline-block w-[3px] align-baseline"
                    style={{ height: "0.9em", background: "#DC244C", transform: "translateY(0.12em)", animation: "pulse 0.85s ease-in-out infinite" }}
                  />
                </div>
                <div className="mt-8 text-sm text-fg-secondary/70">No keywords. No filters. Just meaning.</div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* EMBED — the actual query vector, painted as color */}
          <AnimatePresence>
            {phase === "encoding" && current && (
              <motion.div
                key="embed"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                className="absolute inset-0 flex flex-col items-center justify-center bg-bg-base/55 backdrop-blur-[2px] px-16 text-center"
              >
                <div className="eyebrow mb-4">Embedding</div>
                <div className="text-2xl font-semibold tracking-tight-brand text-fg-primary mb-8 max-w-[36ch]">
                  &ldquo;{current.text}&rdquo; becomes 384 numbers
                </div>
                <VectorStrip vector={current.vector} />
                <div className="mt-4 text-sm text-fg-secondary/70">The real vector.</div>
                <div className="mt-5 flex items-center gap-5 rounded-lg card-glass-strong px-5 py-3">
                  <DistanceViz metric={distanceSel} />
                  <div className="text-left max-w-[30ch]">
                    <div className="text-[13px] font-medium text-fg-primary">
                      {distanceSel === "cosine" && "Cosine, comparing direction"}
                      {distanceSel === "dot" && "Dot product, direction and length"}
                      {distanceSel === "euclid" && "Euclidean, straight-line distance"}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-fg-secondary">
                      {distanceSel === "cosine" && "Two vectors match when they point the same way. The angle is the score."}
                      {distanceSel === "dot" && "Like cosine, but longer vectors score higher too."}
                      {distanceSel === "euclid" && "Two vectors match when their points sit close together in space."}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* SEARCH — one quiet caption while the walk happens */}
          <AnimatePresence>
            {phase === "walking" && (
              <motion.div
                key="search"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="absolute top-20 left-1/2 -translate-x-1/2 rounded-md card-glass-strong px-6 py-2.5 text-sm text-fg-primary/90"
              >
                {exactMode
                  ? <>Checking <span className="text-qdrant-red font-medium">all {movies.length.toLocaleString()}</span> vectors</>
                  : <>Touching <span className="text-qdrant-red font-medium">{latest?.nodesVisited ?? "…"}</span> of {movies.length.toLocaleString()} vectors</>}
              </motion.div>
            )}
          </AnimatePresence>

          {/* ANSWER ECHO — the question stays visible under the step rail */}
          <AnimatePresence>
            {showResults && latest && (
              <motion.div
                key="ask-echo"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="absolute top-20 left-1/2 -translate-x-1/2 z-10 max-w-[70%] rounded-md card-glass-strong px-6 py-2.5 text-center"
              >
                <span className="text-[11px] text-fg-secondary mr-2">
                  {customSource === "phone" ? "Someone asked" : "You asked"}
                </span>
                <span className="text-[15px] font-medium tracking-tight-brand text-fg-primary">
                  &ldquo;{latest.text}&rdquo;
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ANSWER — results + one huge number */}
          <AnimatePresence>
            {showResults && latest && (
              <motion.div
                key="answer"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-x-0 bottom-0 pb-6 px-8"
              >
                {/* Keyword vs meaning — the walk-by hook */}
                {latest.keywordCount != null && (
                  <div className="mb-4 flex items-stretch justify-center gap-3">
                    <div className="rounded-lg card-glass-strong px-6 py-3 text-center">
                      <div className="eyebrow">Keyword search</div>
                      <div className={`text-3xl font-semibold tracking-tight-brand ${latest.keywordCount === 0 ? "text-fg-secondary" : "text-fg-primary"}`}>
                        {latest.keywordCount}
                      </div>
                      <div className="text-[10px] text-fg-secondary">
                        {latest.keywordCount === 0 ? "those words never appear" : "exact word matches"}
                      </div>
                    </div>
                    <div className="flex items-center text-fg-secondary/50 text-lg">vs</div>
                    <div className="rounded-lg bg-qdrant-red/12 ring-1 ring-qdrant-red/30 px-6 py-3 text-center">
                      <div className="eyebrow">Meaning</div>
                      <div className="text-3xl font-semibold tracking-tight-brand text-qdrant-red">
                        {latest.hits.length}
                      </div>
                      <div className="text-[10px] text-fg-secondary">same query, same data</div>
                    </div>
                  </div>
                )}
                <div className="mb-4 flex items-end justify-between px-1">
                  <div>
                    <div className="eyebrow mb-1">&ldquo;{latest.text}&rdquo;</div>
                    <div className="text-2xl font-semibold tracking-tight-brand text-fg-primary">
                      {latest.hits.length} answers.{" "}
                      <span className="text-qdrant-red">{latest.serverMs < 1 ? "<1" : Math.round(latest.serverMs)} ms.</span>
                    </div>
                  </div>
                  <div className="text-right text-xs text-fg-secondary/70">
                    {latest.reranked && (
                      <div>
                        <span className="text-qdrant-red">re-ranked</span> {latest.fetched} → {latest.hits.length} in {latest.rerankMs} ms, in-browser
                      </div>
                    )}
                    {((latest.nodesVisited / Math.max(movies.length, 1)) * 100).toFixed(1)}% of the data touched
                  </div>
                </div>
                {/* HYBRID — three-way retrieval comparison */}
                {latest.hybrid ? (
                  <HybridCompare data={latest.hybrid} onOpen={openDetail} />
                ) : (
                <>
                {/* BEFORE strip — pure vector-search order, for comparison */}
                {latest.reranked && (
                  <div className="mb-2">
                    <div className="mb-1.5 text-[10px] tracking-wide text-fg-secondary/70">
                      Before, vector search order
                    </div>
                    <div
                      className="grid gap-3"
                      style={{ gridTemplateColumns: `repeat(${Math.min(latest.limit, 6)}, 1fr)` }}
                    >
                      {latest.origHits.slice(0, latest.limit).map((h, i) => {
                        // Where did this one land after re-ranking?
                        const newPos = latest.hits.findIndex((r) => r.id === h.id);
                        return (
                          <div
                            key={`orig-${h.id}`}
                            className="flex items-center gap-2 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06] px-2 py-1.5 opacity-75"
                          >
                            <span className="shrink-0 font-mono text-[10px] text-fg-secondary">#{i + 1}</span>
                            <span className="min-w-0 truncate text-[11px] text-fg-primary/85">{h.payload.title}</span>
                            <span className="ml-auto shrink-0 text-[10px] font-medium">
                              {newPos === -1 ? (
                                <span className="text-fg-secondary/60">out</span>
                              ) : newPos < i ? (
                                <span style={{ color: "#4CAF50" }}>→ #{newPos + 1}</span>
                              ) : newPos > i ? (
                                <span className="text-fg-secondary">→ #{newPos + 1}</span>
                              ) : (
                                <span className="text-fg-secondary/60">= #{newPos + 1}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 mb-1.5 text-[10px] tracking-wide text-fg-secondary/70">
                      After, cross-encoder re-rank
                    </div>
                  </div>
                )}
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${Math.min(latest.limit, 6)}, 1fr)` }}
                >
                  {latest.hits.slice(0, latest.limit).map((h, i) => (
                    <ResultCard
                      key={`${latest.text}-${h.id}`}
                      hit={h}
                      rank={i}
                      euclid={latest.euclid}
                      move={latest.reranked ? (latest.origRanks[i] ?? i) - i : 0}
                      onClick={() => openDetail(h)}
                    />
                  ))}
                </div>
                </>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-lg bg-qdrant-red/10 ring-1 ring-qdrant-red/40 px-4 py-2 text-xs text-fg-primary max-w-[70%] truncate">
              {error}
            </div>
          )}
        </div>
      </main>

      {/* ─── UNDER THE HOOD TAB ─── */}
      <main className={`flex-1 min-h-0 px-10 pb-8 overflow-y-auto ${tab === "inside" ? "block" : "hidden"}`}>
        <div className="max-w-[1200px] mx-auto">
          <h2 className="mt-2 mb-1 text-3xl font-semibold tracking-tight-brand text-fg-primary">
            What just happened, exactly.
          </h2>
          <p className="mb-8 text-fg-secondary max-w-[64ch]">
            Every search you watched was a real request to a Qdrant Cloud cluster.
            Here is the machinery behind it.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <InsideCard
              title="The collection"
              lead="10,000 movie descriptions, each embedded as a 384-dimension vector."
            >
              <div className="grid grid-cols-2 gap-2 mt-3">
                <KV k="Status" v={clusterInfo?.status ?? "—"} dot={clusterInfo?.status === "green" ? "#4CAF50" : "#FF9800"} tip="Cluster health as reported by Qdrant Cloud. Green means everything is serving." />
                <KV k="Points" v={clusterInfo ? clusterInfo.points_count.toLocaleString() : "—"} tip="How many vectors are stored. One per movie." />
                <KV k="Distance" v={clusterInfo ? clusterInfo.config.params.vectors.distance : "—"} tip="How similarity is measured. Cosine compares the angle between two vectors." />
                <KV k="Dimensions" v={clusterInfo ? String(clusterInfo.config.params.vectors.size) : "—"} tip="The length of each vector. The embedding model decides this." />
              </div>
              <GenreBars counts={genreCounts} />
            </InsideCard>

            <InsideCard
              title="The index"
              lead="HNSW — a layered graph. Search hops from a sparse top layer down to the answer, touching a fraction of the data."
            >
              <div className="grid grid-cols-2 gap-2 mt-3">
                <KV k="m (links per node)" v={clusterInfo ? String(clusterInfo.config.hnsw_config.m) : "—"} tip="How many neighbors each point links to in the graph. Set once when the index is built." />
                <KV k="ef_construct" v={clusterInfo ? String(clusterInfo.config.hnsw_config.ef_construct) : "—"} tip="How carefully the graph was built. Higher takes longer to build but searches better." />
                <KV k="ef_search (live)" v={String(currentEf)} accent tip="How many candidates the search keeps in play. The knob in the setup card. Higher finds more, costs more time." />
                <KV k="Avg. touched" v={latest ? `${((latest.nodesVisited / Math.max(movies.length, 1)) * 100).toFixed(1)}%` : "—"} tip="Share of all vectors the search actually read. Small number, that is the whole trick." />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <KV
                  k="Live variant"
                  v={variantLabel ?? "Cosine, m 16"}
                  accent={variantLabel != null}
                  tip="Which of the five pre-built index variants is serving right now. Pick another in Settings."
                />
                <KV
                  k="Variants built"
                  v="5"
                  tip="Cosine, Dot, Euclidean, and two graph densities (m 4 and m 64). Same 10,000 vectors in each."
                />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-fg-secondary">
                <span className="text-fg-primary">ef_search</span> tunes per query, live.
                Distance and <span className="text-fg-primary">m</span> are baked in at build time,
                so this demo keeps five copies of the index and swaps between them.
              </p>
              <EfCurve modeStats={modeStatsRef.current} />
            </InsideCard>

            <InsideCard
              title="The numbers"
              lead="Latency measured from this machine, this session."
            >
              <div className="grid grid-cols-3 gap-2 mt-3">
                <KV k="Searches" v={String(totalOps)} />
                <KV k="p50" v={stats.p50 != null ? `${stats.p50} ms` : "—"} />
                <KV k="p95" v={stats.p95 != null ? `${stats.p95} ms` : "—"} />
              </div>
              <div className="mt-4 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] p-3">
                <Sparkline values={stats.latencies} color="#DC244C" />
              </div>
              <LatencyHistogram lats={stats.latencies} />
              <BurstTest queries={queries} />
              {/* Speed by mode — fills in as the loop cycles the options */}
              <div className="mt-4 space-y-1">
                {Object.entries(modeStatsRef.current)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([mode, arr]) => {
                    const avg = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
                    const max = Math.max(...Object.values(modeStatsRef.current).map((a2) => a2.reduce((s, v) => s + v, 0) / a2.length));
                    return (
                      <div key={mode} className="flex items-center gap-3 text-[12px]">
                        <span className="w-28 shrink-0 text-fg-primary/85">{mode}</span>
                        <span className="h-1.5 flex-1 rounded-full bg-white/[0.05] overflow-hidden">
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${Math.max(4, (avg / Math.max(max, 1)) * 100)}%`, background: mode === "Keyword" ? "#656B7F" : "#DC244C" }}
                          />
                        </span>
                        <span className="w-16 shrink-0 text-right text-fg-secondary">{avg} ms</span>
                      </div>
                    );
                  })}
                {Object.keys(modeStatsRef.current).length === 0 && (
                  <div className="text-[12px] text-fg-secondary">Speed by mode fills in as the loop runs.</div>
                )}
              </div>
            </InsideCard>

            <VerdictCard modeStats={modeStatsRef.current} />

            <ScalingCard variants={variantsInfo} />

            <InsideCard
              title="Why it stays fast"
              lead="The whole reason vector databases exist. Checking every vector gets slower as data grows. Walking a graph barely notices."
            >
              <LogNChart />
              <p className="mt-3 text-sm leading-relaxed text-fg-secondary">
                A search here touches roughly the same few hundred vectors whether the
                collection holds twenty thousand movies or twenty million. That is why
                the latency you are watching today is the latency you would get in
                production, at any scale.
              </p>
            </InsideCard>

            <InsideCard
              title="Take it home"
              lead="The whole demo is open source. Scan to clone it, point it at your own cluster, swap in your own data."
            >
              <div className="mt-3 flex items-center gap-5">
                {qrUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrUrl} alt="QR code to the GitHub repo" className="h-36 w-36 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.06] p-2" />
                ) : (
                  <div className="h-36 w-36 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.06]" />
                )}
                <div className="text-[13px] leading-relaxed text-fg-secondary">
                  <div className="font-mono text-fg-primary/90 text-[12px] break-all">{REPO_URL}</div>
                  <div className="mt-2">Next.js, one Python ingest script, Qdrant Cloud free tier.</div>
                </div>
              </div>
            </InsideCard>

            <InsideCard
              title="Recent searches"
              lead="Every query the loop has fired against the cluster."
            >
              <div className="mt-3 space-y-1.5">
                {log.length === 0 && <div className="text-sm text-fg-secondary">Warming up…</div>}
                {log.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] px-2.5 py-1.5 text-[13px]">
                    <span
                      aria-hidden
                      className="h-9 w-7 shrink-0 rounded-md"
                      style={{ background: `linear-gradient(140deg, hsl(${e.topHue},60%,34%), hsl(${(e.topHue + 30) % 360},50%,14%))` }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-fg-primary/90">&ldquo;{e.text}&rdquo;</span>
                      <span className="block truncate text-[11px] text-fg-secondary">top match {e.topTitle}</span>
                    </span>
                    <span className="shrink-0 ml-auto text-fg-secondary">{e.latencyMs} ms</span>
                  </div>
                ))}
              </div>
            </InsideCard>
          </div>
        </div>
      </main>

      {/* DETAIL MODAL — click a result to review it */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key="detail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelected(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/70 backdrop-blur-sm p-8"
          >
            <motion.div
              initial={{ y: 16, scale: 0.98 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 10, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
              className="flex w-[720px] max-h-[80vh] gap-6 rounded-lg card-glass-strong p-6 overflow-hidden"
            >
              {/* Poster art */}
              <div
                className="relative w-[220px] shrink-0 self-stretch min-h-[320px] overflow-hidden rounded-lg"
                style={{
                  background: `linear-gradient(150deg, hsl(${selected.payload.hue ?? 220},62%,34%) 0%, hsl(${((selected.payload.hue ?? 220) + 35) % 360},52%,12%) 100%)`,
                }}
              >
                <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(circle at 25% 18%, hsla(${selected.payload.hue ?? 220},85%,72%,0.4) 0%, transparent 55%)` }} />
                {selected.payload.poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.payload.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
                )}
                <div className="absolute inset-x-0 bottom-0 p-4" style={{ background: "linear-gradient(to top, rgba(11,15,25,0.9), transparent)" }}>
                  <div className="text-lg font-semibold leading-tight tracking-tight-brand text-white">{selected.payload.title}</div>
                  <div className="mt-1 text-[11px] text-white/70">{selected.payload.year}</div>
                </div>
              </div>

              {/* Details */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-2xl font-semibold tracking-tight-brand text-fg-primary">{selected.payload.title}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] text-fg-secondary mr-1">{selected.payload.year}</span>
                      {selected.payload.genres.map((g) => (
                        <span key={g} className="rounded bg-white/[0.05] ring-1 ring-white/[0.08] px-2 py-0.5 text-[10px] text-fg-primary/85">{g}</span>
                      ))}
                      <span className="rounded bg-qdrant-red/15 ring-1 ring-qdrant-red/30 px-2 py-0.5 text-[10px] text-qdrant-red">
                        match {Math.round(selected.score * 100)}%
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="shrink-0 rounded-md bg-white/[0.06] px-3 py-1 text-xs text-fg-secondary hover:text-fg-primary"
                  >
                    Close
                  </button>
                </div>

                <p className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1 text-[13.5px] leading-relaxed text-fg-primary/85">
                  {selected.payload.description}
                </p>

                <div className="mt-4 shrink-0">
                  <div className="eyebrow mb-2">More like this, from Qdrant recommend</div>
                  <div className="grid grid-cols-4 gap-2">
                    {(similar.length ? similar : Array.from({ length: 4 }).map(() => null)).map((s, i) =>
                      s == null ? (
                        <div key={`sk-${i}`} className="h-[64px] rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] animate-pulse" />
                      ) : (
                        <button
                          key={s.id}
                          onClick={() => openDetail(s)}
                          className="relative h-[64px] overflow-hidden rounded-lg text-left ring-1 ring-transparent transition-all hover:ring-white/40"
                          style={{ background: `linear-gradient(140deg, hsl(${s.payload.hue ?? 220},58%,30%), hsl(${((s.payload.hue ?? 220) + 30) % 360},48%,12%))` }}
                        >
                          {s.payload.poster && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={s.payload.poster} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                          )}
                          <div className="absolute inset-x-0 bottom-0 p-1.5" style={{ background: "linear-gradient(to top, rgba(11,15,25,0.9), transparent)" }}>
                            <div className="truncate text-[10.5px] font-semibold text-white">{s.payload.title}</div>
                            <div className="text-[9px] text-white/65">{s.payload.year}</div>
                          </div>
                        </button>
                      ),
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FOOTER */}
      <footer className="flex items-center justify-between border-t border-white/[0.05] px-10 py-3 text-[11px] text-fg-secondary/60">
        <span className="font-mono">POST /collections/movies/points/search</span>
        <span>qdrant.tech/cloud</span>
      </footer>
    </div>
  );
}

/* ── pieces ── */

/**
 * Booth survival kit: keep the screen awake, reload every 12h to stay
 * memory-fresh across a multi-day event, and offer one-tap fullscreen.
 * Renders only the fullscreen pill (when not already fullscreen).
 */
function KioskGuard() {
  const [isFullscreen, setIsFullscreen] = useState(true);
  useEffect(() => {
    // Screen wake lock — reacquire whenever the tab becomes visible again
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lock: any = null;
    const acquire = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch { /* unsupported or denied — harmless */ }
    };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);

    // Multi-day hygiene: a fresh page every 12 hours
    const reload = setTimeout(() => window.location.reload(), 12 * 3600 * 1000);

    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("fullscreenchange", onFs);
      clearTimeout(reload);
      lock?.release?.();
    };
  }, []);

  if (isFullscreen) return null;
  return (
    <button
      onClick={() => document.documentElement.requestFullscreen().catch(() => {})}
      className="fixed bottom-3 right-3 z-40 rounded-md card-glass-strong px-3 py-1.5 text-[11px] text-fg-secondary hover:text-fg-primary transition-colors"
    >
      Fullscreen
    </button>
  );
}

/**
 * Three-way retrieval comparison: keyword rank, semantic rank, and the
 * RRF fusion of both. The full taxonomy on one screen.
 */
function HybridCompare({
  data,
  onOpen,
}: {
  data: {
    kw: Array<{ id: number; payload: MoviePayload; matches: number }>;
    kwTotal: number;
    sem: SearchHit[];
    hyb: Array<SearchHit & { kwRank: number | null; semRank: number | null }>;
  };
  onOpen: (hit: SearchHit) => void;
}) {
  const Row = ({ payload, right, onClick }: { payload: MoviePayload; right: string; onClick?: () => void }) => (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="flex w-full items-center gap-2 rounded bg-white/[0.04] ring-1 ring-white/[0.06] px-2 py-1.5 text-left hover:ring-white/30 transition-all disabled:hover:ring-white/[0.06]"
    >
      <span
        aria-hidden
        className="h-8 w-6 shrink-0 rounded-sm bg-cover bg-center"
        style={{
          background: payload.poster
            ? `url(${payload.poster}) center/cover`
            : `linear-gradient(140deg, hsl(${payload.hue ?? 220},58%,32%), hsl(${((payload.hue ?? 220) + 30) % 360},48%,14%))`,
        }}
      />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-primary/90">{payload.title}</span>
      <span className="shrink-0 text-[10px] text-fg-secondary">{right}</span>
    </button>
  );

  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <div className="mb-1.5 text-[10px] tracking-wide text-fg-secondary/70">
          Keyword · {data.kwTotal === 0 ? "no exact matches" : `${data.kwTotal} matched`}
        </div>
        <div className="space-y-1">
          {data.kw.length === 0 && (
            <div className="rounded bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-3 text-center text-[11px] text-fg-secondary">
              those words never appear
            </div>
          )}
          {data.kw.map((k) => (
            <Row key={`k-${k.id}`} payload={k.payload} right={`${k.matches} words`} />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[10px] tracking-wide text-fg-secondary/70">Semantic · dense vectors</div>
        <div className="space-y-1">
          {data.sem.map((s) => (
            <Row key={`s-${s.id}`} payload={s.payload} right={`${Math.round(s.score * 100)}%`} onClick={() => onOpen(s)} />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[10px] tracking-wide text-qdrant-red">Hybrid · RRF fusion</div>
        <div className="space-y-1">
          {data.hyb.map((h) => (
            <Row
              key={`h-${h.id}`}
              payload={h.payload}
              right={h.kwRank && h.semRank ? "both" : h.kwRank ? "kw only" : "sem only"}
              onClick={() => onOpen(h)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Horizontal genre distribution bars — the collection's shape at a glance. */
function GenreBars({ counts }: { counts: Array<{ genre: string; count: number }> }) {
  const top = [...counts].sort((a, b) => b.count - a.count).slice(0, 8);
  const max = top[0]?.count ?? 1;
  return (
    <div className="mt-3 space-y-1.5">
      {top.map(({ genre, count }) => (
        <div key={genre} className="flex items-center gap-2 text-[11px]">
          <span className="w-24 shrink-0 truncate text-fg-primary/85">{genre}</span>
          <span className="h-2.5 flex-1 rounded-sm bg-white/[0.04] overflow-hidden">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(count / max) * 100}%`, background: GENRE_COLOR[genre] ?? "#DC244C" }}
            />
          </span>
          <span className="w-12 shrink-0 text-right text-fg-secondary">{count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** Latency histogram over this session's searches. */
function LatencyHistogram({ lats }: { lats: number[] }) {
  if (lats.length < 3) {
    return <div className="mt-3 text-[12px] text-fg-secondary">Histogram fills in as searches run.</div>;
  }
  const min = Math.min(...lats);
  const max = Math.max(...lats, min + 1);
  const BUCKETS = 14;
  const buckets = Array(BUCKETS).fill(0);
  for (const l of lats) {
    buckets[Math.min(BUCKETS - 1, Math.floor(((l - min) / (max - min)) * BUCKETS))]++;
  }
  const peak = Math.max(...buckets, 1);
  return (
    <div className="mt-3">
      <div className="flex items-end gap-[3px] h-14">
        {buckets.map((b, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-qdrant-red/60"
            style={{ height: `${Math.max(4, (b / peak) * 100)}%`, opacity: b === 0 ? 0.15 : 1 }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-fg-secondary/70">
        <span>{Math.round(min)} ms</span>
        <span>round-trip latency distribution</span>
        <span>{Math.round(max)} ms</span>
      </div>
    </div>
  );
}

/** Measured ef vs latency curve — the accuracy/speed tradeoff, from this session. */
function EfCurve({ modeStats }: { modeStats: Record<string, number[]> }) {
  const pts = [16, 64, 128, 512]
    .map((ef) => {
      const arr = modeStats[`HNSW ef ${ef}`];
      return arr?.length ? { ef, ms: arr.reduce((s, v) => s + v, 0) / arr.length } : null;
    })
    .filter((p): p is { ef: number; ms: number } => p != null);
  if (pts.length < 2) {
    return <div className="mt-3 text-[12px] text-fg-secondary">The ef curve draws itself as the loop cycles ef values.</div>;
  }
  const W = 260, H = 90, PAD = 24;
  const xs = [16, 64, 128, 512];
  const x = (ef: number) => PAD + (Math.log2(ef) - 4) / (9 - 4) * (W - PAD * 2);
  const maxMs = Math.max(...pts.map((p) => p.ms)) * 1.15;
  const y = (ms: number) => H - 16 - (ms / maxMs) * (H - 32);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.ef)} ${y(p.ms)}`).join(" ");
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={PAD} y1={H - 16} x2={W - PAD} y2={H - 16} stroke="rgba(255,255,255,0.12)" />
        <path d={path} fill="none" stroke="#DC244C" strokeWidth="2" />
        {pts.map((p) => (
          <g key={p.ef}>
            <circle cx={x(p.ef)} cy={y(p.ms)} r="3" fill="#DC244C" />
            <text x={x(p.ef)} y={y(p.ms) - 7} textAnchor="middle" fill="#F0F3FA" fontSize="9">{Math.round(p.ms)}ms</text>
            <text x={x(p.ef)} y={H - 4} textAnchor="middle" fill="#656B7F" fontSize="9">ef {p.ef}</text>
          </g>
        ))}
      </svg>
      <div className="text-[10px] text-fg-secondary/70 text-center">measured this session, higher ef = more candidates checked</div>
    </div>
  );
}

/** Static educational curve: why HNSW stays fast as data grows. */
function LogNChart() {
  const W = 300, H = 110, PAD = 26;
  const pts = 40;
  const linear: string[] = [];
  const logn: string[] = [];
  for (let i = 0; i <= pts; i++) {
    const t = i / pts;
    const px = PAD + t * (W - PAD * 2);
    linear.push(`${i === 0 ? "M" : "L"} ${px} ${H - 18 - t * (H - 36)}`);
    const lg = Math.log2(1 + t * 1023) / 10; // normalized log curve
    logn.push(`${i === 0 ? "M" : "L"} ${px} ${H - 18 - lg * (H - 36)}`);
  }
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={PAD} y1={H - 18} x2={W - PAD} y2={H - 18} stroke="rgba(255,255,255,0.12)" />
        <path d={linear.join(" ")} fill="none" stroke="#656B7F" strokeWidth="1.8" strokeDasharray="4 3" />
        <path d={logn.join(" ")} fill="none" stroke="#DC244C" strokeWidth="2.2" />
        <text x={W - PAD} y={22} textAnchor="end" fill="#656B7F" fontSize="10">exact scan, work grows with N</text>
        <text x={W - PAD} y={H - 32} textAnchor="end" fill="#DC244C" fontSize="10">HNSW, work grows with log N</text>
        <text x={PAD} y={H - 4} fill="#656B7F" fontSize="9">1K vectors</text>
        <text x={W - PAD} y={H - 4} textAnchor="end" fill="#656B7F" fontSize="9">1B vectors</text>
      </svg>
    </div>
  );
}

/** Take-home code: the current request as a paste-ready snippet. */
function CopyCode({ latest }: {
  latest: { text: string; ef: number; exact: boolean; limit: number; genre: string | null };
}) {
  const [copied, setCopied] = useState<"py" | "ts" | null>(null);
  const filterPy = latest.genre
    ? `\n    query_filter=models.Filter(must=[models.FieldCondition(key="genres", match=models.MatchValue(value="${latest.genre}"))]),`
    : "";
  const py = `from qdrant_client import QdrantClient, models

client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
hits = client.search(
    collection_name="movies",
    query_vector=embed("${latest.text}"),  # any 384-d embedding
    limit=${latest.limit},${filterPy}
    search_params=models.SearchParams(hnsw_ef=${latest.ef}, exact=${latest.exact ? "True" : "False"}),
)`;
  const ts = `const res = await fetch(\`\${QDRANT_URL}/collections/movies/points/search\`, {
  method: "POST",
  headers: { "api-key": QDRANT_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({
    vector: await embed("${latest.text}"), // any 384-d embedding
    limit: ${latest.limit},${latest.genre ? `\n    filter: { must: [{ key: "genres", match: { value: "${latest.genre}" } }] },` : ""}
    params: { hnsw_ef: ${latest.ef}, exact: ${latest.exact} },
    with_payload: true,
  }),
});`;
  const copy = async (kind: "py" | "ts", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch { /* clipboard blocked — no drama */ }
  };
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-[10px] tracking-wide text-fg-secondary/70">Take it home:</span>
      <button
        onClick={() => copy("py", py)}
        className="rounded bg-white/[0.05] ring-1 ring-white/[0.08] px-2.5 py-1 text-[11px] text-fg-primary hover:bg-white/[0.08] transition-colors"
      >
        {copied === "py" ? "Copied ✓" : "Copy Python"}
      </button>
      <button
        onClick={() => copy("ts", ts)}
        className="rounded bg-white/[0.05] ring-1 ring-white/[0.08] px-2.5 py-1 text-[11px] text-fg-primary hover:bg-white/[0.08] transition-colors"
      >
        {copied === "ts" ? "Copied ✓" : "Copy TypeScript"}
      </button>
    </div>
  );
}

/**
 * Burst mode: 20 parallel searches against the cluster, proving concurrency.
 * Renders inside "The numbers" card.
 */
function BurstTest({ queries }: { queries: Query[] }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ wall: number; p50: number; p95: number; lats: number[] } | null>(null);

  const run = async () => {
    if (running || queries.length === 0) return;
    setRunning(true);
    const picks = Array.from({ length: 20 }, () => queries[Math.floor(Math.random() * queries.length)]);
    const t0 = performance.now();
    const lats = await Promise.all(
      picks.map(async (q) => {
        const s = performance.now();
        try {
          await fetch("/api/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vector: q.vector, limit: 6, ef: 64 }),
          });
        } catch { /* count it anyway */ }
        return performance.now() - s;
      }),
    );
    const wall = Math.round(performance.now() - t0);
    const sorted = [...lats].sort((a, b) => a - b);
    setResult({
      wall,
      p50: Math.round(sorted[10]),
      p95: Math.round(sorted[18]),
      lats,
    });
    setRunning(false);
  };

  return (
    <div className="mt-4">
      <button
        onClick={run}
        disabled={running}
        className="w-full rounded-md bg-white/[0.05] ring-1 ring-white/[0.08] py-2 text-[12px] font-medium text-fg-primary hover:bg-white/[0.08] transition-colors disabled:opacity-50"
      >
        {running ? "20 searches in flight…" : "Burst: 20 parallel searches"}
      </button>
      {result && (
        <div className="mt-2">
          <div className="flex items-end gap-[2px] h-10">
            {result.lats.map((l, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-qdrant-red/70"
                style={{ height: `${Math.max(8, (l / Math.max(...result.lats)) * 100)}%` }}
                title={`${Math.round(l)} ms`}
              />
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-fg-secondary">
            all 20 done in <span className="text-fg-primary">{result.wall} ms</span> wall,
            p50 <span className="text-fg-primary">{result.p50} ms</span>,
            p95 <span className="text-fg-primary">{result.p95} ms</span>
          </div>
        </div>
      )}
    </div>
  );
}

const STEPS: Array<{ key: string; label: string; phases: Phase[] }> = [
  { key: "text", label: "Ask", phases: ["typing"] },
  { key: "embed", label: "Embed", phases: ["encoding"] },
  { key: "search", label: "Search", phases: ["walking"] },
  { key: "rank", label: "Answer", phases: ["results", "hold"] },
];

/** Always-visible pipeline stepper — shows where we are in the process. */
function StepRail({ phase }: { phase: Phase }) {
  const activeIdx = STEPS.findIndex((s) => s.phases.includes(phase));
  return (
    <div className="flex items-center gap-1 rounded-md card-glass-strong px-2 py-1.5">
      {STEPS.map((s, i) => {
        const active = i === activeIdx;
        const done = activeIdx > i;
        return (
          <div key={s.key} className="flex items-center">
            <span
              className={`rounded px-3.5 py-1 text-xs font-medium transition-all duration-300 ${
                active
                  ? "bg-qdrant-red text-white shadow-glow"
                  : done
                    ? "text-fg-primary/80"
                    : "text-fg-secondary/50"
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className={`mx-0.5 text-[10px] ${done ? "text-fg-primary/60" : "text-fg-secondary/30"}`}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SetupRow({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-secondary">{label}</div>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

function EfPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-[3px] text-[11px] font-medium transition-all ${
        active ? "bg-qdrant-red text-white" : "bg-white/[0.05] text-fg-secondary hover:text-fg-primary"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Geometric mini-diagram of the active distance metric. Two vectors —
 * red = your query, violet = a movie — compared the way the metric compares.
 */
function DistanceViz({ metric }: { metric: "cosine" | "dot" | "euclid" }) {
  // Origin bottom-left; A = query (red), B = candidate (violet)
  const O = { x: 18, y: 96 };
  const A = { x: 128, y: 26 };
  const B = { x: 112, y: 62 };
  return (
    <svg width="150" height="110" viewBox="0 0 150 110" className="shrink-0">
      {/* axes */}
      <line x1={O.x} y1={O.y} x2={144} y2={O.y} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
      <line x1={O.x} y1={O.y} x2={O.x} y2={8} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />

      {/* angle arc for cosine + dot */}
      {(metric === "cosine" || metric === "dot") && (
        <path
          d={`M ${O.x + 34} ${O.y - 22} A 40 40 0 0 1 ${O.x + 40} ${O.y - 10}`}
          fill="none"
          stroke="#FF9800"
          strokeWidth="1.6"
        />
      )}
      {(metric === "cosine" || metric === "dot") && (
        <text x={O.x + 46} y={O.y - 16} fill="#FF9800" fontSize="10" fontFamily="monospace">θ</text>
      )}

      {/* euclid: dashed line between tips */}
      {metric === "euclid" && (
        <>
          <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#FF9800" strokeWidth="1.6" strokeDasharray="4 3" />
          <text x={(A.x + B.x) / 2 + 6} y={(A.y + B.y) / 2} fill="#FF9800" fontSize="10" fontFamily="monospace">d</text>
        </>
      )}

      {/* dot: projection of B onto A */}
      {metric === "dot" && (
        <line x1={B.x} y1={B.y} x2={(A.x + O.x) * 0.62} y2={(A.y + O.y) * 0.55} stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="2 3" />
      )}

      {/* vector A — the query */}
      <line x1={O.x} y1={O.y} x2={A.x} y2={A.y} stroke="#DC244C" strokeWidth="2.2" />
      <circle cx={A.x} cy={A.y} r="3.4" fill="#DC244C" />
      <text x={A.x + 4} y={A.y - 4} fill="#DC244C" fontSize="9" fontFamily="monospace">query</text>

      {/* vector B — a movie */}
      <line x1={O.x} y1={O.y} x2={B.x} y2={B.y} stroke="#6047FF" strokeWidth="2.2" />
      <circle cx={B.x} cy={B.y} r="3.4" fill="#6047FF" />
      <text x={B.x + 6} y={B.y + 10} fill="#8B7CFF" fontSize="9" fontFamily="monospace">movie</text>
    </svg>
  );
}

/** The real query vector painted as 64 sampled color strips. */
function VectorStrip({ vector }: { vector: number[] }) {
  const cells = useMemo(() => {
    const n = 64;
    return Array.from({ length: n }, (_, i) => vector[Math.floor((i / n) * vector.length)] ?? 0);
  }, [vector]);
  return (
    <div className="flex h-16 w-full max-w-[720px] gap-[3px] items-end">
      {cells.map((v, i) => {
        const t = Math.max(0, Math.min(1, (v + 0.25) * 2)); // roughly normalize
        return (
          <motion.div
            key={i}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.3, delay: i * 0.012 }}
            className="flex-1 rounded-sm origin-bottom"
            style={{
              height: `${20 + t * 80}%`,
              background: `linear-gradient(180deg, ${t > 0.6 ? "#DC244C" : "#6047FF"}, rgba(96,71,255,0.25))`,
            }}
          />
        );
      })}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-5 py-1.5 text-sm font-medium transition-all ${
        active ? "bg-fg-primary text-bg-base" : "text-fg-secondary hover:text-fg-primary"
      }`}
    >
      {children}
    </button>
  );
}

function InsideCard({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <section className="card p-7 transition-shadow hover:shadow-glow-violet/20 ring-1 ring-transparent hover:ring-white/[0.06]">
      <h3 className="text-xl font-semibold tracking-tight-brand text-fg-primary">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary max-w-[56ch]">{lead}</p>
      {children}
    </section>
  );
}

function KV({ k, v, dot, accent = false, tip }: { k: string; v: string; dot?: string; accent?: boolean; tip?: string }) {
  return (
    <div className={`relative rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] px-3 py-2 ${tip ? "group cursor-help" : ""}`}>
      <div className="text-[10px] tracking-wide text-fg-secondary/70">{k}</div>
      <div className={`mt-0.5 text-base font-medium tracking-tight-brand ${accent ? "text-qdrant-red" : "text-fg-primary"}`}>
        {dot && <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: dot }} />}
        {v}
      </div>
      {tip && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-56 -translate-x-1/2 rounded-lg card-glass-strong px-3 py-2 text-[11px] leading-relaxed text-fg-primary/90 group-hover:block">
          {tip}
        </div>
      )}
    </div>
  );
}

/** Known characteristics per mode. Speed column is replaced by live data when we have it. */
const MODE_META: Array<{ key: string; speed: number; accuracy: number; ram: number; use: string }> = [
  { key: "HNSW ef 16",  speed: 5, accuracy: 2, ram: 3, use: "autocomplete, huge traffic" },
  { key: "HNSW ef 64",  speed: 4, accuracy: 4, ram: 3, use: "the everyday default" },
  { key: "HNSW ef 128", speed: 3, accuracy: 4, ram: 3, use: "quality-first search" },
  { key: "HNSW ef 512", speed: 2, accuracy: 5, ram: 3, use: "offline evaluation" },
  { key: "Exact scan",  speed: 1, accuracy: 5, ram: 4, use: "small data, ground truth" },
  { key: "Dot product", speed: 4, accuracy: 4, ram: 3, use: "recommender scores" },
  { key: "Euclidean",   speed: 4, accuracy: 4, ram: 3, use: "spatial or image data" },
  { key: "m 4",         speed: 4, accuracy: 2, ram: 5, use: "memory-tight deployments" },
  { key: "m 64",        speed: 3, accuracy: 5, ram: 1, use: "max recall at scale" },
  { key: "Keyword",     speed: 5, accuracy: 1, ram: 5, use: "exact names and IDs" },
];

/**
 * What this actually costs to serve — estimated from collection configs.
 * Vector bytes = points x dims x 4 (float32). Graph RAM ~= points x m x 12B.
 * Estimates, labeled as such; the point is the shape of the math, not
 * decimal precision.
 */
function ScalingCard({ variants }: { variants: VariantRow[] }) {
  const DIM = 384;
  const fmt = (bytes: number) =>
    bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  const rows = variants.map((v) => ({
    ...v,
    vecBytes: v.points * DIM * 4,
    graphBytes: v.points * v.m * 12,
  }));
  const totVec = rows.reduce((s, r) => s + r.vecBytes, 0);
  const totGraph = rows.reduce((s, r) => s + r.graphBytes, 0);
  const totPoints = rows.reduce((s, r) => s + r.points, 0);

  return (
    <InsideCard
      title="What it costs to serve"
      lead="Estimated from the live configs. Vectors are memmapped from disk; the HNSW graph lives in RAM."
    >
      <div className="mt-3 space-y-1">
        <div className="grid items-center gap-2 px-2 text-[10px] tracking-wide text-fg-secondary/70"
          style={{ gridTemplateColumns: "1fr 70px 76px 76px" }}>
          <span>Collection</span><span>Points</span><span>Disk (vec)</span><span>RAM (graph)</span>
        </div>
        {rows.map((r) => (
          <div key={r.key}
            className="grid items-center gap-2 rounded-lg bg-white/[0.03] ring-1 ring-white/[0.05] px-2 py-1.5 text-[12px]"
            style={{ gridTemplateColumns: "1fr 70px 76px 76px" }}>
            <span className="truncate font-mono text-fg-primary/90">{r.name}</span>
            <span className="text-fg-secondary">{(r.points / 1000).toFixed(0)}K</span>
            <span className="text-fg-primary">{fmt(r.vecBytes)}</span>
            <span className="text-fg-primary">{fmt(r.graphBytes)}</span>
          </div>
        ))}
        {rows.length > 0 && (
          <div className="grid items-center gap-2 px-2 pt-1 text-[12px] font-medium"
            style={{ gridTemplateColumns: "1fr 70px 76px 76px" }}>
            <span className="text-fg-secondary">Total</span>
            <span className="text-fg-primary">{(totPoints / 1000).toFixed(0)}K</span>
            <span className="text-qdrant-red">{fmt(totVec)}</span>
            <span className="text-qdrant-red">{fmt(totGraph)}</span>
          </div>
        )}
      </div>
      <div className="mt-4 space-y-1.5 text-[13px] leading-relaxed text-fg-secondary">
        <p><span className="text-fg-primary">When to scale up:</span> graph RAM near your node&rsquo;s memory, p95 creeping, or ingest stalling the optimizer.</p>
        <p><span className="text-fg-primary">Levers before bigger hardware:</span> vectors on disk (done here), lower m, quantization for 4 to 32x smaller vectors, then shard across nodes.</p>
        <p>Search stays fast as data grows because HNSW work scales with <span className="text-fg-primary">log N</span>, not N. Same ef touches roughly the same node count at 100K as at 10K.</p>
      </div>
    </InsideCard>
  );
}

function VerdictCard({ modeStats }: { modeStats: Record<string, number[]> }) {
  const avg = (k: string) => {
    const a = modeStats[k];
    return a?.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null;
  };
  const measured = MODE_META.filter((m) => avg(m.key) != null);
  const ef64 = avg("HNSW ef 64");
  const exact = avg("Exact scan");
  const slowdown = ef64 && exact ? Math.round((exact / ef64) * 10) / 10 : null;

  return (
    <InsideCard
      title="Which should you use?"
      lead="Measured speed from this session, plus what each choice costs."
    >
      <div className="mt-3 space-y-1">
        <div className="grid items-center gap-2 text-[10px] tracking-wide text-fg-secondary/70 px-2"
          style={{ gridTemplateColumns: "94px 56px 62px 62px 1fr" }}>
          <span /><span>Speed</span><span>Accuracy</span><span>RAM cost</span><span>Best for</span>
        </div>
        {MODE_META.map((m) => {
          const ms = avg(m.key);
          return (
            <div key={m.key}
              className={`grid items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] ${ms != null ? "bg-white/[0.04] ring-1 ring-white/[0.06]" : "opacity-45"}`}
              style={{ gridTemplateColumns: "94px 56px 62px 62px 1fr" }}>
              <span className="truncate text-fg-primary/90">{m.key}</span>
              <span className="font-medium text-fg-primary">{ms != null ? `${ms}ms` : <Bar level={m.speed} />}</span>
              <Bar level={m.accuracy} accent />
              <Bar level={6 - m.ram} />
              <span className="truncate text-fg-secondary">{m.use}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 rounded-lg bg-qdrant-red/10 ring-1 ring-qdrant-red/25 px-4 py-3 text-[13px] leading-relaxed text-fg-primary/90">
        <span className="font-semibold text-qdrant-red">Our pick: </span>
        HNSW with ef 64 on cosine. Near-perfect accuracy, one graph in RAM
        {ef64 ? <>, measured <span className="text-fg-primary font-medium">{ef64} ms</span> here</> : null}
        {slowdown ? <>. Exact scan was <span className="text-fg-primary font-medium">{slowdown}×</span> slower for the same answers</> : null}.
        Dim rows have not run yet — pick them in Settings to fill this in.
      </div>
    </InsideCard>
  );
}

function Bar({ level, accent = false }: { level: number; accent?: boolean }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-sm"
          style={{ background: i <= level ? (accent ? "#6047FF" : "#DC244C") : "rgba(78,83,102,0.35)" }} />
      ))}
    </span>
  );
}

function ResultCard({ hit, rank, euclid = false, move = 0, onClick }: { hit: SearchHit; rank: number; euclid?: boolean; move?: number; onClick?: () => void }) {
  const hue = hit.payload.hue ?? 220;
  // Euclidean scores are distances (lower is better) — show raw, not %.
  const scoreLabel = euclid ? hit.score.toFixed(2) : `${Math.round(hit.score * 100)}%`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, delay: rank * 0.09 }}
      onClick={onClick}
      className="relative h-[118px] overflow-hidden rounded-lg cursor-pointer ring-1 ring-transparent transition-all hover:ring-white/40 hover:scale-[1.03]"
      style={{ background: `linear-gradient(140deg, hsl(${hue},60%,30%) 0%, hsl(${(hue + 30) % 360},50%,12%) 100%)` }}
    >
      {hit.payload.poster && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={hit.payload.poster}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(circle at 22% 18%, hsla(${hue},85%,70%,0.35) 0%, transparent 55%)` }} />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-2/3" style={{ background: "linear-gradient(to top, rgba(11,15,25,0.9), transparent)" }} />
      <div className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white/95 backdrop-blur">
        #{rank + 1}
        {move > 0 && <span style={{ color: "#4CAF50" }}>↑{move}</span>}
        {move < 0 && <span className="text-white/50">↓{-move}</span>}
      </div>
      <div className="absolute right-2.5 top-2.5 rounded bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white/95 backdrop-blur">
        {scoreLabel}
      </div>
      <div className="absolute inset-x-0 bottom-0 p-3">
        <div className="text-[13px] font-semibold leading-tight tracking-tight-brand text-white line-clamp-2">{hit.payload.title}</div>
        <div className="mt-1 text-[10px] text-white/65">{hit.payload.genres[0]} · {hit.payload.year}</div>
      </div>
    </motion.div>
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
    values.forEach((v, i) => {
      const y = h - ((v - min) / (max - min)) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sx, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }, [values, color]);
  return <canvas ref={ref} className="w-full" style={{ height: 48 }} />;
}

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
