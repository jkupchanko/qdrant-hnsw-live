"""
Ingest the movies dataset into Qdrant Cloud and precompute the frontend
bundles for the WatchNext demo.

    python scripts/ingest.py

Reads:  data/movies.json
Writes: public/data/movies.json     (metadata + 2D coords for map animations)
        public/data/queries.json    (pre-embedded mood queries)

Env:    QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION (defaults "movies")
        If the URL/key are missing, the frontend bundles still generate — the
        upload step is skipped.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.decomposition import PCA

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from qdrant_client import QdrantClient, models
    HAS_QDRANT = True
except ImportError:
    HAS_QDRANT = False

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
VECTOR_SIZE = 384
COLLECTION = os.environ.get("QDRANT_COLLECTION", "movies")

ROOT = Path(__file__).resolve().parent.parent
DATA_IN = ROOT / "data" / "movies.json"
PUBLIC_OUT = ROOT / "public" / "data"

# The demo cycles through these as "mood queries". Written to feel like the
# way a real person asks a friend for a recommendation.
QUERY_BANK = [
    "movies about second chances",
    "films that feel like a long summer afternoon",
    "movies to watch after a breakup",
    "quiet films that stay with you",
    "twisty thrillers with a moral core",
    "underrated science fiction",
    "warm movies for cold nights",
    "coming of age with a great soundtrack",
    "melancholic love stories",
    "films for a rainy Sunday",
    "movies about complicated fathers",
    "revenge films with style",
    "smart comedies that respect their audience",
    "fantasy that feels real",
    "movies with unreliable narrators",
    "sprawling films about ambition",
    "movies about grief",
    "quiet horror that gets under your skin",
    "movies about growing up in a small town",
    "westerns with heart",
    "animation that is not for kids",
    "films that made you cry",
    "movies about friendship",
    "romances with a bittersweet ending",
    "movies about home",
    "action films with a soul",
    "films where the ending changes everything",
    "movies with beautiful cinematography",
    "films that feel like a memory",
    "movies you can rewatch forever",
]


def searchable_text(item: dict) -> str:
    return " ".join([
        item["title"],
        str(item.get("year", "")),
        item.get("director", ""),
        " ".join(item.get("genres", [])),
        " ".join(item.get("mood", [])),
        item["description"],
    ])


def load_movies() -> list[dict]:
    with DATA_IN.open("r", encoding="utf-8") as f:
        return json.load(f)


def embed_items(model: SentenceTransformer, items: list[dict]) -> np.ndarray:
    import hashlib
    texts = [searchable_text(item) for item in items]
    # Cache embeddings by content hash — payload-only changes (posters etc.)
    # then skip the ~20 minute re-embed entirely.
    digest = hashlib.md5(json.dumps(texts, ensure_ascii=False).encode()).hexdigest()[:16]
    cache_dir = ROOT / "data" / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"vectors_{digest}.npy"
    if cache_file.exists():
        print(f"  Loading cached embeddings ({cache_file.name})...")
        return np.load(cache_file)
    print(f"  Embedding {len(texts)} items...")
    vectors = np.asarray(
        model.encode(texts, show_progress_bar=True, normalize_embeddings=True),
        dtype=np.float32,
    )
    np.save(cache_file, vectors)
    return vectors


def project_2d(vectors: np.ndarray) -> np.ndarray:
    pca = PCA(n_components=2, random_state=42)
    coords = pca.fit_transform(vectors)
    coords = coords - coords.mean(axis=0)
    max_abs = np.max(np.abs(coords))
    if max_abs > 0:
        coords = coords / max_abs
    return coords.astype(np.float32)


# Variant collections so the demo can hot-swap distance metrics and graph
# density live. Same vectors, same payloads, different index configs.
VARIANTS = [
    (COLLECTION,             models.Distance.COSINE, 16),
    (f"{COLLECTION}_dot",    models.Distance.DOT,    16),
    (f"{COLLECTION}_euclid", models.Distance.EUCLID, 16),
    (f"{COLLECTION}_m4",     models.Distance.COSINE, 4),
    (f"{COLLECTION}_m64",    models.Distance.COSINE, 64),
]


def upload_to_qdrant(items: list[dict], vectors: np.ndarray) -> None:
    url = os.environ.get("QDRANT_URL")
    api_key = os.environ.get("QDRANT_API_KEY")

    if not (HAS_QDRANT and url and api_key):
        print("  QDRANT_URL / QDRANT_API_KEY not set - skipping upload.")
        return

    print(f"  Connecting to {url}...")
    client = QdrantClient(url=url, api_key=api_key, timeout=60)

    points = [
        models.PointStruct(
            id=item["id"],
            vector=vector.tolist(),
            payload={
                "title": item["title"],
                "year": item["year"],
                "director": item.get("director", ""),
                "genres": item.get("genres", []),
                "mood": item.get("mood", []),
                "hue": item.get("hue", 220),
                "description": item["description"],
                **({"poster": item["poster"]} if item.get("poster") else {}),
            },
        )
        for item, vector in zip(items, vectors)
    ]

    BATCH = 1000
    for name, distance, m in VARIANTS:
        if client.collection_exists(name):
            print(f"  Recreating '{name}'...")
            client.delete_collection(name)
        client.create_collection(
            collection_name=name,
            # on_disk: at 100K x 5 variants the raw vectors would exhaust the
            # free tier's RAM — memmapping them from disk is the production
            # answer, and the demo's scaling story.
            vectors_config=models.VectorParams(size=VECTOR_SIZE, distance=distance, on_disk=True),
            hnsw_config=models.HnswConfigDiff(m=m),
        )
        for field in ("genres", "mood", "director"):
            client.create_payload_index(name, field, models.PayloadSchemaType.KEYWORD)
        client.create_payload_index(name, "year", models.PayloadSchemaType.INTEGER)
        client.create_payload_index(
            name, "description",
            models.TextIndexParams(
                type=models.TextIndexType.TEXT,
                tokenizer=models.TokenizerType.WORD,
                lowercase=True,
            ),
        )
        for start in range(0, len(points), BATCH):
            client.upsert(collection_name=name, points=points[start : start + BATCH], wait=True)
        print(f"  '{name}' ready: distance={distance.value}, m={m}, {len(points)} points")


def write_frontend_bundle(items: list[dict], coords: np.ndarray, query_vectors: np.ndarray) -> None:
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)

    # Slim payload: only what the map needs to render points. The full payload
    # lives in Qdrant Cloud; the client fetches details on demand via /api/*.
    # At 100K, every byte in this file matters: primary genre only, 3-decimal
    # coords, no title (the map never shows one; payloads come from Qdrant).
    slim = [
        {
            "id": item["id"],
            "genres": [item.get("genres", ["drama"])[0]],
            "x": round(float(c[0]), 3),
            "y": round(float(c[1]), 3),
        }
        for item, c in zip(items, coords)
    ]
    with (PUBLIC_OUT / "movies.json").open("w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, separators=(",", ":"))

    queries = [
        {"text": text, "vector": vector.tolist()}
        for text, vector in zip(QUERY_BANK, query_vectors)
    ]
    with (PUBLIC_OUT / "queries.json").open("w", encoding="utf-8") as f:
        json.dump(queries, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  Wrote {PUBLIC_OUT / 'movies.json'} ({len(slim)} items, slim)")
    print(f"  Wrote {PUBLIC_OUT / 'queries.json'} ({len(queries)} queries)")


def main() -> int:
    print("Loading movies...")
    items = load_movies()

    print(f"Loading model {MODEL_NAME}...")
    model = SentenceTransformer(MODEL_NAME)

    print("Embedding movies...")
    vectors = embed_items(model, items)

    print("Projecting to 2D with PCA...")
    coords = project_2d(vectors)

    print("Embedding query bank...")
    query_vectors = np.asarray(
        model.encode(QUERY_BANK, show_progress_bar=True, normalize_embeddings=True),
        dtype=np.float32,
    )

    print("Uploading to Qdrant Cloud...")
    upload_to_qdrant(items, vectors)

    print("Writing frontend bundle...")
    write_frontend_bundle(items, coords, query_vectors)

    print("\nDone. Run `npm run dev` to see WatchNext.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
