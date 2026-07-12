"""
Build data/movies.json from the CMU Movie Summary Corpus — real films with
real Wikipedia plot summaries. Filters to modern (1990+) releases.

    python scripts/fetch_real_movies.py

Downloads ~46 MB once into data/cache/, then writes data/movies.json in the
same shape the ingest script expects.
"""

from __future__ import annotations

import csv
import json
import tarfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
OUT = ROOT / "data" / "movies.json"
URL = "http://www.cs.cmu.edu/~ark/personas/data/MovieSummaries.tar.gz"
MIN_YEAR = 1990
MIN_PLOT = 200
MAX_PLOT = 900  # chars kept for payload + embedding (MiniLM truncates anyway)

# CMU genre labels → our palette genres
GENRE_MAP = [
    ("science fiction", "sci-fi"), ("sci-fi", "sci-fi"),
    ("romantic comedy", "romance"), ("romance", "romance"), ("romantic", "romance"),
    ("animation", "animation"), ("animated", "animation"), ("anime", "animation"),
    ("horror", "horror"), ("slasher", "horror"),
    ("thriller", "thriller"), ("suspense", "thriller"), ("crime", "thriller"),
    ("comedy", "comedy"),
    ("western", "western"),
    ("documentary", "documentary"),
    ("musical", "musical"), ("music", "musical"),
    ("film noir", "noir"), ("noir", "noir"),
    ("mystery", "mystery"), ("detective", "mystery"),
    ("fantasy", "fantasy"),
    ("action", "action"), ("adventure", "action"), ("war", "action"), ("martial", "action"),
    ("coming of age", "coming-of-age"), ("coming-of-age", "coming-of-age"), ("teen", "coming-of-age"),
    ("biograph", "biography"), ("biopic", "biography"),
    ("family", "animation"),
    ("drama", "drama"),
]

HUE_BY_GENRE = {
    "drama": 210, "romance": 340, "sci-fi": 260, "thriller": 220, "horror": 300,
    "comedy": 40, "animation": 195, "action": 15, "fantasy": 280,
    "coming-of-age": 120, "western": 25, "documentary": 210, "noir": 230,
    "musical": 330, "mystery": 175, "biography": 200,
}


def download() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    tar_path = CACHE / "MovieSummaries.tar.gz"
    if not tar_path.exists():
        print(f"Downloading {URL} (~46 MB)...")
        urllib.request.urlretrieve(URL, tar_path)
    if not (CACHE / "MovieSummaries").exists():
        print("Extracting...")
        with tarfile.open(tar_path) as tf:
            tf.extractall(CACHE)
    return CACHE / "MovieSummaries"


def map_genres(raw: str) -> list[str]:
    """raw is a JSON dict like {"/m/01jfsb": "Thriller", ...}"""
    try:
        labels = [v.lower() for v in json.loads(raw).values()]
    except Exception:
        return ["drama"]
    found: list[str] = []
    for label in labels:
        for needle, ours in GENRE_MAP:
            if needle in label and ours not in found:
                found.append(ours)
                break
    return found[:3] or ["drama"]


def main() -> None:
    base = download()

    print("Reading plots...")
    plots: dict[str, str] = {}
    with (base / "plot_summaries.txt").open(encoding="utf-8") as f:
        for line in f:
            wid, _, plot = line.partition("\t")
            plot = plot.strip()
            if len(plot) >= MIN_PLOT:
                plots[wid] = plot

    print("Joining metadata...")
    movies: list[dict] = []
    seen_titles: set[str] = set()
    with (base / "movie.metadata.tsv").open(encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            wid, _, title, release, _, _, _, _, genres_raw = row[:9]
            if wid not in plots or not title:
                continue
            year = None
            if release[:4].isdigit():
                year = int(release[:4])
            if year is None or year < MIN_YEAR:
                continue
            key = title.lower()
            if key in seen_titles:
                continue
            seen_titles.add(key)
            genres = map_genres(genres_raw)
            plot = plots[wid][:MAX_PLOT]
            # Cut at the last sentence boundary so descriptions read clean
            cut = plot.rfind(". ")
            if cut > MIN_PLOT:
                plot = plot[: cut + 1]
            movies.append({
                "id": len(movies) + 1,
                "wid": wid,
                "title": title,
                "year": year,
                "genres": genres,
                "mood": [],
                "hue": HUE_BY_GENRE.get(genres[0], 220),
                "description": plot,
            })

    movies.sort(key=lambda m: (-m["year"], m["title"]))
    for i, m in enumerate(movies):
        m["id"] = i + 1

    fetch_posters(movies)

    OUT.write_text(json.dumps(movies, ensure_ascii=False), encoding="utf-8")
    years = [m["year"] for m in movies]
    with_poster = sum(1 for m in movies if m.get("poster"))
    print(f"Wrote {len(movies):,} real movies ({min(years)}-{max(years)}), "
          f"{with_poster:,} with posters, to {OUT}")


def fetch_posters(movies: list[dict]) -> None:
    """Batch-resolve each film's Wikipedia lead image (usually the poster)."""
    print("Fetching poster URLs from Wikipedia (batches of 50)...")
    headers = {"User-Agent": "qdrant-hnsw-live-demo/1.0 (booth demo; contact: devrel)"}
    for start in range(0, len(movies), 50):
        batch = movies[start : start + 50]
        ids = "|".join(m["wid"] for m in batch)
        base_url = (
            "https://en.wikipedia.org/w/api.php?action=query&format=json"
            "&prop=pageimages&piprop=thumbnail&pithumbsize=400&pilimit=50&pilicense=any"
            f"&pageids={urllib.parse.quote(ids)}"
        )
        # Follow `continue` tokens; back off hard on 429 — Wikipedia rate
        # limits aggressively and a blocked run silently loses everything.
        cont = ""
        try:
            for _ in range(10):  # safety cap on continuation rounds
                resp = None
                for attempt in range(4):
                    try:
                        req = urllib.request.Request(base_url + cont, headers=headers)
                        with urllib.request.urlopen(req, timeout=30) as r:
                            resp = json.load(r)
                        break
                    except urllib.error.HTTPError as he:
                        if he.code == 429 and attempt < 3:
                            time.sleep(5 * (2 ** attempt))  # 5s, 10s, 20s
                            continue
                        raise
                if resp is None:
                    break
                pages = resp.get("query", {}).get("pages", {})
                for m in batch:
                    thumb = pages.get(m["wid"], {}).get("thumbnail", {}).get("source")
                    if thumb and not m.get("poster"):
                        m["poster"] = thumb
                c = resp.get("continue")
                if not c:
                    break
                cont = "".join(f"&{k}={urllib.parse.quote(str(v))}" for k, v in c.items())
                time.sleep(1.0)
        except Exception as e:
            print(f"  batch at {start} failed: {e}")
        if start % 2500 == 0:
            done = sum(1 for m in movies[: start + 50] if m.get("poster"))
            print(f"  {start + len(batch)}/{len(movies)} checked, {done} posters so far")
        time.sleep(1.0)


if __name__ == "__main__":
    main()
