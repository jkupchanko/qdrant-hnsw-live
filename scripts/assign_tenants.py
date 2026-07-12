"""
Assign a `tenant` payload field to every point in every variant collection —
three fake streaming services, split by point id. Demonstrates payload-based
multitenancy: one collection, isolated catalogs.

    python scripts/assign_tenants.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from qdrant_client import QdrantClient, models

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
COLLECTION = os.environ.get("QDRANT_COLLECTION", "movies")
VARIANTS = [COLLECTION, f"{COLLECTION}_dot", f"{COLLECTION}_euclid", f"{COLLECTION}_m4", f"{COLLECTION}_m64"]
TENANTS = ["streamflix", "cinemax", "nichecast"]


def main() -> None:
    movies = json.loads((ROOT / "data" / "movies.json").read_text(encoding="utf-8"))
    ids_by_tenant: dict[str, list[int]] = {t: [] for t in TENANTS}
    for m in movies:
        ids_by_tenant[TENANTS[m["id"] % 3]].append(m["id"])

    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.environ["QDRANT_API_KEY"], timeout=120)
    for name in VARIANTS:
        if not client.collection_exists(name):
            print(f"  {name}: missing, skipped")
            continue
        client.create_payload_index(name, "tenant", models.PayloadSchemaType.KEYWORD)
        for tenant, ids in ids_by_tenant.items():
            # set_payload in id-chunks; huge point lists can hit body limits
            for start in range(0, len(ids), 2000):
                client.set_payload(
                    collection_name=name,
                    payload={"tenant": tenant},
                    points=ids[start : start + 2000],
                    wait=True,
                )
            print(f"  {name}: {tenant} <- {len(ids)} points")
    print("Done.")


if __name__ == "__main__":
    main()
