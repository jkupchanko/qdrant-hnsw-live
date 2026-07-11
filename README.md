# HNSW Live

A booth demo for Qdrant Cloud. Ten thousand movie vectors, live semantic search,
and the HNSW graph traversal visualized in real time. Auto-cycles through mood
queries and the `ef_search` parameter so a passerby can watch the accuracy /
speed tradeoff happen in front of them.

Built to deploy to Vercel with a `git push`.

---

## What it shows

- **10,000 vectors** indexed in a Qdrant Cloud collection
- **One query at a time**, told as a story:
  `1 · query arrives → 2 · encoding → 3 · walking HNSW index → 4 · nearest neighbors`
- **Simulated HNSW traversal** drawn across the semantic map, plus a layered
  graph inset showing L3 → L0 descent
- **`ef_search` auto-cycles** through 16 / 64 / 128 / 512 every ~20s — speed
  and recall bars flip as it changes
- **Top-6 result cards** underneath the map, real titles + genres + scores from
  Qdrant Cloud
- **Collection breakdown** by genre pill row at the bottom
- **Live pipeline strip** showing per-query timings: `encode → HNSW walk → return`
- **Query log + latency sparkline + p50/p95** in the right column

Every animation on screen corresponds to a real Qdrant Cloud search.

---

## Local setup

Requires **Node 18+**, **Python 3.10+**, and a **Qdrant Cloud** cluster (free
tier works).

```bash
# 1. Node deps
npm install

# 2. Python deps — the ingest script uses sentence-transformers + qdrant-client
pip install qdrant-client sentence-transformers scikit-learn python-dotenv
# (or `pip install -e .` if using pyproject.toml)

# 3. Point at your cluster
cp .env.example .env
# then fill in QDRANT_URL and QDRANT_API_KEY from your Qdrant Cloud dashboard

# 4. Generate + embed + upload the corpus (~1 minute)
python scripts/generate_movies.py     # writes data/movies.json (10K films)
python scripts/ingest.py              # embeds, uploads, writes public/data/

# 5. Run
npm run dev                            # http://localhost:3000
```

Full-screen the browser (F11) for kiosk mode.

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. On [vercel.com](https://vercel.com), click **New Project** → import the repo.
3. In **Environment Variables**, set:
   - `QDRANT_URL` — e.g. `https://xxx.eu-west-2-0.aws.cloud.qdrant.io`
   - `QDRANT_API_KEY` — from your Qdrant Cloud dashboard
   - `QDRANT_COLLECTION` — `movies`
4. Deploy. Vercel auto-detects Next.js; no build config needed.

The `public/data/movies.json` and `public/data/queries.json` produced by the
ingest script are checked in, so the deploy has data on first boot without
needing to run ingest on Vercel.

If you edit `data/movies.json` or the query bank, rerun `python
scripts/ingest.py` locally, then commit + push. The frontend bundles will be
regenerated and the Qdrant Cloud collection will be updated.

---

## Files

```
app/
  page.tsx                       Renders <HNSWLive />
  layout.tsx                     Root layout, fonts, dark theme
  globals.css                    Qdrant brand tokens
  api/
    search/route.ts              POST vector search against Qdrant Cloud
    similar/route.ts             POST recommend-by-id (unused in HNSW Live)
components/
  HNSWLive.tsx                   The whole demo (~600 lines)
  StarField.tsx                  Ambient starfield background
  QdrantLogo.tsx                 Inline SVG brandmark
lib/
  data.ts                        Frontend loaders for public/data/*.json
  genres.ts                      Genre → color mapping
  qdrant.ts                      Thin fetch wrapper over Qdrant Cloud REST
  types.ts                       Shared TS types
data/
  movies.json                    Source corpus (10,000 films)
  constellations.json            Historical — earlier version's dataset
public/data/                     Written by scripts/ingest.py
scripts/
  generate_movies.py             Synthesize N movies from templates
  ingest.py                      Embed → project → upload → bundle
```

---

## What's honest and what's a simulation

- **The queries are real.** Every animation corresponds to a real
  `POST /collections/movies/points/search` against your Qdrant Cloud cluster.
- **The latencies are real.** The `serverTimeMs` from Qdrant's response drives
  the pipeline stage, and the round-trip drives the client-side timers.
- **`ef_search` is real.** The parameter is passed through as
  `params.hnsw_ef` — you can verify by watching latency change with the value.
- **The HNSW traversal path is a simulation.** We can't introspect Qdrant's
  internal graph, so the dashed path across the map is a plausible greedy
  descent through 2D projection space, path length scaled to `ef`.
- **"Nodes visited" is estimated** as `~2 × ef_search`, which is the standard
  HNSW characteristic — accurate as a magnitude, not the exact number.
- **The 2D map is a PCA projection** of the 384-d embeddings. Clusters that
  look like they belong together *do* belong together in the real vector space.

---

## Rotating the credentials

If your API key ends up in a public git history, revoke it in the Qdrant Cloud
dashboard under **Data Access Control**, generate a new one, and update `.env`
locally + the Vercel env vars.
