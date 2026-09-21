"""
Build the hybrid collection: the same 19,907 films, with BM25 and miniCOIL
sparse vectors alongside the dense ones.

    python scripts/add_sparse.py

Why a new collection rather than an in-place migration: `movies` is serving the
live demo right now, and sparse vectors are a collection-level config change.
This reads the dense vectors and payloads straight back out of `movies`, so
nothing is re-embedded and nothing existing is touched. Point the app at
`movies_hybrid` when you are ready, and delete it if you are not.

The sparse side is what makes the "dense vs sparse vs hybrid" act honest. Both
models carry Modifier.IDF, which is what tells Qdrant to apply inverse document
frequency server-side — fastembed only emits term frequencies.

Env: QDRANT_URL, QDRANT_API_KEY (read from .env.local).
"""

from __future__ import annotations

import os
import sys
import time

SOURCE = "movies"
TARGET = "movies_hybrid"
BATCH = 256
BM25_MODEL = "Qdrant/bm25"
MINICOIL_MODEL = "Qdrant/minicoil-v1"


def main() -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv(".env.local")
    except ImportError:
        pass

    from fastembed import SparseTextEmbedding
    from qdrant_client import QdrantClient, models

    url, key = os.environ.get("QDRANT_URL"), os.environ.get("QDRANT_API_KEY")
    if not url or not key:
        print("QDRANT_URL / QDRANT_API_KEY missing", file=sys.stderr)
        return 1

    client = QdrantClient(url=url, api_key=key, timeout=120)
    src = client.get_collection(SOURCE)
    total = src.points_count
    dim = src.config.params.vectors.size
    print(f"source {SOURCE}: {total:,} points, {dim}-d")

    print("loading sparse models (first run downloads ~100 MB)…")
    bm25 = SparseTextEmbedding(model_name=BM25_MODEL)
    minicoil = SparseTextEmbedding(model_name=MINICOIL_MODEL)

    if client.collection_exists(TARGET):
        print(f"{TARGET} already exists — delete it first if you want a clean rebuild")
        return 1

    client.create_collection(
        collection_name=TARGET,
        vectors_config=models.VectorParams(
            size=dim, distance=models.Distance.COSINE, on_disk=True
        ),
        sparse_vectors_config={
            # IDF lives server-side: fastembed hands Qdrant term frequencies.
            "bm25": models.SparseVectorParams(
                index=models.SparseIndexParams(on_disk=True),
                modifier=models.Modifier.IDF,
            ),
            "minicoil": models.SparseVectorParams(
                index=models.SparseIndexParams(on_disk=True),
                modifier=models.Modifier.IDF,
            ),
        },
        hnsw_config=models.HnswConfigDiff(m=16, ef_construct=100),
    )
    print(f"created {TARGET}")

    for field, schema in [
        ("genres", models.PayloadSchemaType.KEYWORD),
        ("mood", models.PayloadSchemaType.KEYWORD),
        ("director", models.PayloadSchemaType.KEYWORD),
        ("tenant", models.PayloadSchemaType.KEYWORD),
        ("year", models.PayloadSchemaType.INTEGER),
        ("description", models.PayloadSchemaType.TEXT),
        ("title", models.PayloadSchemaType.TEXT),
    ]:
        client.create_payload_index(TARGET, field_name=field, field_schema=schema)
    print("payload indexes created")

    started = time.time()
    done = 0
    offset = None
    while True:
        points, offset = client.scroll(
            SOURCE, limit=BATCH, offset=offset, with_payload=True, with_vectors=True
        )
        if not points:
            break

        # BM25 and miniCOIL both read the plot; title is prepended so an exact
        # title match is reachable by the keyword arm, which is the single most
        # common thing a booth visitor types.
        texts = [
            f"{p.payload.get('title', '')}. {p.payload.get('description', '')}".strip()
            for p in points
        ]
        bm25_vecs = list(bm25.embed(texts))
        minicoil_vecs = list(minicoil.embed(texts))

        client.upsert(
            collection_name=TARGET,
            points=[
                models.PointStruct(
                    id=p.id,
                    vector={
                        "": p.vector,
                        "bm25": models.SparseVector(
                            indices=b.indices.tolist(), values=b.values.tolist()
                        ),
                        "minicoil": models.SparseVector(
                            indices=m.indices.tolist(), values=m.values.tolist()
                        ),
                    },
                    payload=p.payload,
                )
                for p, b, m in zip(points, bm25_vecs, minicoil_vecs)
            ],
            wait=False,
        )
        done += len(points)
        rate = done / max(time.time() - started, 0.001)
        print(f"  {done:,}/{total:,}  ({rate:.0f}/s)", flush=True)
        if offset is None:
            break

    print(f"done in {time.time() - started:.0f}s")
    info = client.get_collection(TARGET)
    print(f"{TARGET}: {info.points_count:,} points, status {info.status}")
    return 0


if __name__ == "__main__":
    # Windows + qdrant-client: anything that forks must sit behind this guard.
    sys.exit(main())
