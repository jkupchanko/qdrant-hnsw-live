"""
Build the validated query set for the ranking act.

    python scripts/build_rank_queries.py

Why this exists: the looping demo queries are moods ("movies to watch after a
breakup"), and a cross-encoder cannot rank those. Measured, both
ms-marco-MiniLM and bge-reranker-base score every candidate at the floor and
reorder noise — a plot summary never *answers* a request for a
recommendation, so a query-passage relevance model has nothing to grip.

Descriptive, plot-shaped queries are a different story. "a detective hunting a
serial killer" scores +4.38 and pulls Seven to the top, which vector search
missed entirely. That is the act working as intended.

So: propose candidates, run each one against the live cluster, re-rank, and
keep only the ones that demonstrably work. A query earns its place when

  1. the cross-encoder finds something it genuinely believes in
     (top logit above MIN_TOP_LOGIT), and
  2. re-ranking visibly changes the answer
     (a different #1, or something promoted from outside the shown top six).

Anything else would put "After re-ranking" on a booth screen above an order
that is not better, in front of someone who can read both rows.

These same queries drive the whole single-screen pipeline, not just the
ranking band, so each one also carries its BM25 and miniCOIL sparse vectors
for the four-way race.

Writes public/data/rank-queries.json: text, dense vector, both sparse
vectors, and the measured stats that got it in.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "rank-queries.json"

COLLECTION = "movies_hybrid"
ENCODER = "sentence-transformers/all-MiniLM-L6-v2"
RERANKER = "cross-encoder/ms-marco-MiniLM-L-6-v2"

CANDIDATES = 18
SHOWN = 6
MIN_TOP_LOGIT = 0.0
TARGET = 12

POOL = [
    "a detective hunting a serial killer",
    "an astronaut stranded in space",
    "a boxer training for one last fight",
    "a bank robbery that goes wrong",
    "a spy who defects to the other side",
    "a lawyer defending an innocent man",
    "a shark attacks a small coastal town",
    "a haunted house terrorizes a family",
    "a soldier returning home from war",
    "a hacker breaking into a government system",
    "a submarine crew trapped underwater",
    "a con artist running an elaborate scam",
    "a musician struggling with addiction",
    "a teacher inspiring troubled students",
    "a plane crash in the wilderness",
    "a zombie outbreak in a city",
    "a time traveller changing the past",
    "a prisoner planning an escape",
    "a journalist exposing a conspiracy",
    "a family surviving a natural disaster",
    "a scientist who creates something he cannot control",
    "a gangster rising through the ranks",
]


def main() -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv(".env.local")
    except ImportError:
        pass

    from fastembed import SparseTextEmbedding
    from qdrant_client import QdrantClient
    from sentence_transformers import CrossEncoder, SentenceTransformer

    url, key = os.environ.get("QDRANT_URL"), os.environ.get("QDRANT_API_KEY")
    if not url or not key:
        print("QDRANT_URL / QDRANT_API_KEY missing", file=sys.stderr)
        return 1

    client = QdrantClient(url=url, api_key=key, timeout=60)
    encoder = SentenceTransformer(ENCODER)
    reranker = CrossEncoder(RERANKER)
    bm25 = SparseTextEmbedding(model_name="Qdrant/bm25")
    minicoil = SparseTextEmbedding(model_name="Qdrant/minicoil-v1")

    def sparse(model, text: str) -> dict:
        v = list(model.query_embed([text]))[0]
        return {
            "indices": v.indices.tolist(),
            "values": [round(float(x), 6) for x in v.values],
        }

    kept: list[dict] = []
    for text in POOL:
        vector = encoder.encode(text, normalize_embeddings=True).tolist()
        points = client.query_points(
            COLLECTION, query=vector, limit=CANDIDATES, with_payload=True
        ).points
        if len(points) < CANDIDATES:
            print(f"  skip  {text!r}: only {len(points)} candidates")
            continue

        docs = [(p.payload.get("description") or p.payload["title"])[:500] for p in points]
        scores = [float(s) for s in reranker.predict([(text, d) for d in docs])]
        order = sorted(range(len(points)), key=lambda i: -scores[i])

        top_logit = max(scores)
        new_top = order[0]
        promoted = sum(1 for i in order[:SHOWN] if i >= SHOWN)
        changed = new_top != 0 or promoted > 0

        verdict = "keep" if (top_logit > MIN_TOP_LOGIT and changed) else "drop"
        print(
            f"  {verdict:<5} {text!r}\n"
            f"        top logit {top_logit:+.2f} | vector #1 {points[0].payload['title'][:28]!r}"
            f" -> reranked #1 {points[new_top].payload['title'][:28]!r}"
            f" | {promoted} promoted from outside top {SHOWN}"
        )
        if verdict == "keep":
            kept.append({
                "text": text,
                "vector": [round(x, 6) for x in vector],
                "bm25": sparse(bm25, text),
                "minicoil": sparse(minicoil, text),
                "topLogit": round(top_logit, 3),
                "promoted": promoted,
                "changedTop": bool(new_top != 0),
            })
        if len(kept) >= TARGET:
            break

    if not kept:
        print("nothing passed — do not ship the ranking act on these", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(kept), encoding="utf-8")
    print(f"\nkept {len(kept)}/{len(POOL)} -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
