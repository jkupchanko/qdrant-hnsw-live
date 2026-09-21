"""
Give the 30 looping queries their sparse counterparts.

    python scripts/add_query_sparse.py

The booth loop plays canned queries, so their BM25 and miniCOIL query vectors
can be built once here and shipped in the bundle. That makes the dense / sparse
/ hybrid act on the screen a real three-way comparison against the cluster
rather than an illustration.

Visitor-typed queries are a different case: this cluster has no Cloud
Inference, and a browser can only produce the dense vector, so typed queries
stay dense-only and the UI says so.

Rewrites public/data/queries.json in place, adding `bm25` and `minicoil`
alongside the existing `text` and `vector`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "public" / "data" / "queries.json"


def main() -> int:
    from fastembed import SparseTextEmbedding

    queries = json.loads(BUNDLE.read_text(encoding="utf-8"))
    texts = [q["text"] for q in queries]
    print(f"{len(texts)} queries")

    bm25 = SparseTextEmbedding(model_name="Qdrant/bm25")
    minicoil = SparseTextEmbedding(model_name="Qdrant/minicoil-v1")

    # query_embed, not embed: the query side of BM25 skips term frequency
    # weighting, which is the whole point of the modifier living server-side.
    b = list(bm25.query_embed(texts))
    m = list(minicoil.query_embed(texts))

    for q, bv, mv in zip(queries, b, m):
        q["bm25"] = {"indices": bv.indices.tolist(), "values": [round(float(x), 6) for x in bv.values]}
        q["minicoil"] = {"indices": mv.indices.tolist(), "values": [round(float(x), 6) for x in mv.values]}

    BUNDLE.write_text(json.dumps(queries), encoding="utf-8")
    size_kb = BUNDLE.stat().st_size / 1024
    print(f"wrote {BUNDLE.relative_to(ROOT)} ({size_kb:.0f} KB)")
    print("sample:", queries[0]["text"], "-> bm25", len(queries[0]["bm25"]["indices"]),
          "terms, minicoil", len(queries[0]["minicoil"]["indices"]), "terms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
