# HNSW Live

A booth demo of Qdrant Cloud: **19,907 real movies** with Wikipedia plot
summaries and posters, searched by meaning, with the HNSW index traversal
visualized live. Built for events — it loops forever, survives failures,
and every animation corresponds to a real request against a live cluster.

**Two tabs:**
- **Live demo** — the loop: a question types itself → becomes a 384-d vector
  (shown as the real vector, plus a geometric diagram of the active distance
  metric) → HNSW walks the map of 20K points → poster cards land with scores.
  A search bar lets visitors ask their own questions (embedded in-browser via
  transformers.js — no API keys). Click any result for the full plot and
  live "more like this" recommendations.
- **Under the hood** — plain-language cards: live cluster status, index
  config, latency percentiles with a 20-parallel-search burst test, a
  measured speed-by-mode comparison, a which-should-you-use verdict table,
  serving-cost estimates, recent searches, and a QR code to this repo.

**Every knob is live** (Settings card): ef_search, HNSW vs exact scan,
distance metric (Cosine/Dot/Euclid), graph density m (4/16/64), top-K,
genre + decade filters, score threshold, **tenant isolation** (three fake
streaming services in one collection), cross-encoder **re-ranking** with
before/after comparison, keyword-vs-semantic compare, and loop pace.

---

## Architecture

```
Browser ── transformers.js (MiniLM embed + ms-marco cross-encoder, in-browser)
   │
   ├── /api/search   POST → Qdrant Cloud /collections/{variant}/points/search
   ├── /api/similar  POST → /points/recommend
   ├── /api/keyword  POST → /points/scroll (full-text filter)
   └── /api/stats    GET  → collection + variant info
```

- **Five variant collections** hold the same 20K vectors under different
  index configs (`movies`, `_dot`, `_euclid`, `_m4`, `_m64`) — distance and
  m are build-time, so "changing" them means routing to another collection.
- Vectors are stored `on_disk`; payloads carry title/year/genres/plot/poster/tenant.
- Qdrant is called via a **thin fetch wrapper** (`lib/qdrant.ts`), not the JS
  client (which mangles Cloud URLs).
- Payload indexes: keyword on genres/mood/director/tenant, integer on year,
  full-text on description (for the keyword-search comparison).

## Setup

Requires Node 18+, Python 3.10+, and a Qdrant Cloud cluster (free tier works).

```bash
npm install
pip install qdrant-client sentence-transformers scikit-learn python-dotenv

cp .env.example .env   # fill in QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION=movies

python scripts/fetch_real_movies.py   # CMU corpus + Wikipedia posters (~15 min)
python scripts/ingest.py              # embed (cached), build 5 collections (~20 min)
python scripts/assign_tenants.py      # tenant payload field + index (~5 min)

npm run dev                            # http://localhost:3000
```

## Deploy

Push to GitHub → import on Vercel → set `QDRANT_URL`, `QDRANT_API_KEY`,
`QDRANT_COLLECTION=movies` → deploy. The `public/data/` bundles are
committed, so the deploy works without running the Python pipeline.

## Honesty notes

- Queries, latencies, `hnsw_ef`, `exact`, filters, tenants, re-ranking: all real.
- The HNSW traversal path on the map is a **simulation** (the real graph
  lives inside Qdrant); path length scales with ef. "Nodes visited" is the
  standard ~2×ef estimate.
- The 2D map is a PCA projection of the true 384-d space.
- Corpus: CMU Movie Summary Corpus (real films, 1990–2014). Posters via
  Wikipedia's pageimages API (~80% coverage; gradient art otherwise).
