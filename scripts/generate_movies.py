"""
Generate a corpus of ~1,000 movies by combining templates with the 100 curated
seeds already in data/movies.json.

    python scripts/generate_movies.py

Rewrites data/movies.json in place. Original seeds keep ids 1..100; synthetic
entries take ids >= 101.

The templates lean semantic — each generated movie has one or two genres,
2–3 mood tags, and a description built from natural sentence patterns.
That's enough signal for cosine similarity to produce meaningful clusters.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED_PATH = ROOT / "data" / "movies.json"
TARGET_TOTAL = 100000
SEED = 20260710
random.seed(SEED)

# --------------------------------------------------------------------------
# Vocab
# --------------------------------------------------------------------------

GENRES = [
    "drama", "romance", "sci-fi", "thriller", "horror", "comedy",
    "animation", "action", "fantasy", "coming-of-age", "western",
    "documentary", "noir", "musical", "mystery", "biography",
]

# Common two-genre combos so films read plausibly
GENRE_COMBOS = [
    ("drama",), ("drama", "romance"), ("drama", "coming-of-age"),
    ("drama", "mystery"), ("drama", "thriller"), ("sci-fi",),
    ("sci-fi", "thriller"), ("sci-fi", "drama"), ("sci-fi", "horror"),
    ("thriller", "noir"), ("thriller", "mystery"), ("horror",),
    ("horror", "drama"), ("comedy",), ("comedy", "romance"),
    ("comedy", "drama"), ("action",), ("action", "thriller"),
    ("action", "sci-fi"), ("fantasy",), ("fantasy", "romance"),
    ("fantasy", "drama"), ("animation", "family"), ("animation", "sci-fi"),
    ("western", "drama"), ("noir", "mystery"), ("musical", "romance"),
    ("biography", "drama"),
]

MOODS_BY_GENRE = {
    "drama": ["quiet", "tender", "melancholic", "unresolved", "patient", "grief", "personal", "moral", "warm"],
    "romance": ["yearning", "restrained", "bittersweet", "warm", "longing", "sun-soaked", "quiet", "tender"],
    "sci-fi": ["cold", "cavernous", "contemplative", "dreamlike", "cerebral", "cosmic", "near-future"],
    "thriller": ["cold", "urgent", "paranoid", "moral", "electric", "grim", "procedural"],
    "horror": ["dread", "unsettling", "claustrophobic", "escalating", "cold", "cultic", "grief"],
    "comedy": ["witty", "warm", "shaggy", "deadpan", "bright", "chaotic"],
    "animation": ["wondrous", "tender", "warm", "kinetic", "brave"],
    "action": ["kinetic", "furious", "stylish", "brutal", "cool"],
    "fantasy": ["mythic", "epic", "whimsical", "dark", "wondrous"],
    "coming-of-age": ["tender", "witty", "nostalgic", "warm", "anxious", "bright"],
    "western": ["dry", "elegiac", "american", "laconic", "weathered"],
    "documentary": ["patient", "personal", "urgent", "observed"],
    "noir": ["cold", "grim", "shadowed", "cynical"],
    "musical": ["bright", "bittersweet", "scrappy", "warm"],
    "mystery": ["patient", "obsessive", "cold", "cerebral"],
    "biography": ["personal", "sprawling", "reverent", "moral"],
    "family": ["warm", "bright", "tender"],
}

HUE_BY_MOOD = {
    "quiet": 215, "tender": 340, "melancholic": 220, "unresolved": 210,
    "patient": 210, "grief": 220, "personal": 25, "moral": 25, "warm": 30,
    "yearning": 345, "restrained": 340, "bittersweet": 210, "longing": 340,
    "sun-soaked": 40, "cold": 215, "cavernous": 220, "contemplative": 195,
    "dreamlike": 320, "cerebral": 195, "cosmic": 260, "near-future": 195,
    "urgent": 15, "paranoid": 220, "electric": 45, "grim": 220, "procedural": 210,
    "dread": 330, "unsettling": 300, "claustrophobic": 210, "escalating": 20,
    "cultic": 45, "witty": 15, "shaggy": 40, "deadpan": 270, "bright": 45,
    "chaotic": 315, "wondrous": 195, "kinetic": 15, "brave": 200, "furious": 10,
    "stylish": 220, "brutal": 10, "cool": 215, "mythic": 30, "epic": 25,
    "whimsical": 10, "dark": 220, "nostalgic": 30, "anxious": 220, "dry": 25,
    "elegiac": 30, "american": 25, "laconic": 25, "weathered": 25, "observed": 210,
    "shadowed": 220, "cynical": 210, "scrappy": 30, "obsessive": 25, "sprawling": 25,
    "reverent": 30,
}

CHARACTERS = [
    "widow", "priest", "detective", "teacher", "mechanic", "ballet dancer",
    "thief", "young king", "refugee", "chef", "astronaut", "gardener",
    "boxer", "journalist", "farmer", "engineer", "hitman", "nurse", "poet",
    "magician", "actress", "scientist", "sailor", "monk", "veteran",
    "hotel concierge", "cartographer", "translator", "smuggler", "bartender",
    "cellist", "coroner", "photographer", "librarian", "surgeon", "pilot",
    "beekeeper", "linguist", "clockmaker", "auctioneer", "seamstress",
    "diplomat", "midwife", "tour guide", "poker player", "cave diver",
    "shepherd", "playwright", "war reporter", "night watchman", "conductor",
    "florist", "cryptographer", "puppeteer", "watch repairman", "sommelier",
]

TEEN_CHARS = [
    "boy", "girl", "teenager", "quiet freshman", "aspiring musician",
    "brother and sister", "three best friends", "shy new kid",
]

SETTINGS = [
    "a shuttered Vermont town", "1980s Warsaw", "a Tokyo highrise",
    "the Portuguese coast", "an abandoned amusement park", "colonial Bombay",
    "a Chilean copper mine", "a Reykjavík winter", "a Louisiana bayou",
    "the outer edge of a research colony on Mars", "a Kyoto teahouse",
    "a Roma refugee shelter", "a Bosnian mountain village",
    "the last train out of Vienna", "a Prague opera house",
    "a Seoul convenience store at 3am", "a Cornish fishing hamlet",
    "an off-season resort in Maine", "a Basque monastery", "an oil rig in the North Sea",
    "a moss-covered temple in the Cambodian jungle", "a Manchester tower block",
    "a Kigali radio station", "a Buenos Aires tango bar",
    "an underground jazz club in postwar Berlin", "a Havana rooftop",
    "a Palestinian olive grove", "an Icelandic geothermal plant",
    "a New Orleans funeral home", "a Rio favela", "a Silicon Valley garage",
    "a Serbian border checkpoint", "a fishing town at the end of Alaska",
    "a Georgian mountain pass in winter", "a Nairobi market",
    "a Krakow tenement", "a Sardinian shepherd's cabin",
    "a Naples convent", "an Uzbek desert observatory", "a Newfoundland lighthouse",
    "a small town in Kansas that lost its factory", "a Beijing hutong",
    "a Marseille shipping yard", "a Lima cathedral",
    "a Wellington community theater", "a Corsican inn out of season",
    "a Yorkshire moor in the fog", "a Kolkata printing house",
    "a Utah motel off the interstate", "a Berlin research hospital",
]

INCIDENTS = [
    "receives a letter from someone long dead",
    "discovers their spouse has been keeping a second life",
    "is asked to identify a body that could not possibly be who they think it is",
    "finds a diary that names them",
    "answers a phone call meant for someone else",
    "inherits a run-down building with an unusual tenant",
    "is offered a job by a stranger who knows too much",
    "loses their voice and has to communicate through a child",
    "returns after twenty years to a place that shouldn't remember them",
    "witnesses a small crime that turns out to be the visible edge of a large one",
    "finds an unmarked grave in their backyard",
    "wins a raffle they don't remember entering",
    "is mistaken for someone with the same name",
    "buys a house at auction and discovers what the previous owner left behind",
    "picks up a hitchhiker who won't say where they're going",
    "meets a stranger on a night train who claims to be their older self",
    "finds a locked room in the house they grew up in",
    "is asked to translate a document that keeps changing",
    "receives a package with no return address and no note",
    "sits down at a piano and remembers a piece they have never learned",
    "wakes to find the town has quietly emptied around them",
    "is hired to guard something they are not allowed to look at",
    "recognizes their own handwriting on a wall they have never touched",
    "gets a phone number pressed into their palm at a funeral",
    "finds an old photograph of themselves in a place they have never been",
    "is told the same story by three strangers in one week",
    "discovers a hidden staircase behind a bookshelf",
    "signs a lease on an apartment where someone is still living",
]

CONSEQUENCES = [
    "and slowly gives up the life they had built to find out why",
    "and cannot make anyone believe them",
    "and it starts a chain of decisions they will spend the rest of their life carrying",
    "and every door they open closes another one they did not know they needed",
    "and by the end of the week nothing they have said will still be true",
    "and finds a version of themselves they thought they had left behind",
    "and it costs them everything they had come there to keep",
    "and the story that follows takes twenty years to finish",
    "and everyone around them starts to become part of something they cannot name",
    "and the answer, when it arrives, is not the one they wanted",
    "and their careful life quietly dismantles itself in a single season",
    "and what they discover splits their family in two",
    "and they have to decide, in the end, whether to say a single word",
    "and by the last chapter neither of them can look the other in the eye",
    "and the town they thought they knew reveals a hundred-year silence",
    "and every kindness they receive from that day forward is under a shadow",
    "and it becomes the reason they stop trusting maps, or promises, or people",
    "and years later they will not agree on what actually happened",
]

TITLE_PATTERNS = [
    "The {adj} {noun}", "{noun} of {noun2}", "{name}'s {noun}",
    "The Last {noun}", "A {noun} for {name}", "Before the {noun}",
    "After the {noun}", "Chronicles of the {noun}", "The {noun} at {place}",
    "{name} and the {noun}", "Notes from a {noun}",
    "One {noun}, One {noun2}", "The Weight of {noun}",
    "{adj} {noun}", "{noun} in Winter", "{noun} in Summer",
    "The Quiet {noun}", "The Long {noun}", "{noun} & {noun2}",
    "{number} {plural_noun}", "The {noun} We Left",
    "A Season of {noun}", "The {name} Letters",
]

TITLE_ADJ = [
    "Silent", "Broken", "Distant", "Small", "Second", "Endless",
    "Unwritten", "Missing", "Slow", "Bright", "Northern", "Forgotten",
    "Bitter", "Wounded", "Quiet", "Late", "Blue", "Salt", "Iron", "Paper",
    "Grey", "Amber", "Hollow", "Kind", "Restless", "Patient", "Southern",
]

TITLE_NOUN = [
    "Harvest", "Kingdom", "Chapel", "River", "Machine", "Orphan",
    "Cartographer", "Weight", "Season", "Silence", "Hunger", "Border",
    "Passage", "Sonata", "Compass", "Verdict", "Mercy", "Portrait",
    "Bridge", "Signal", "Confession", "Rumor", "Sleep", "Shore",
    "Argument", "Errand", "Winter", "Errant", "Cathedral", "Widow",
    "Anthem", "Debt", "Watch", "Handwriting", "Distance", "Choir",
    "Testament", "Runaway", "Errand Boy", "Locket",
]

TITLE_PLACE = [
    "Belfast", "Kraków", "Kyoto", "Reykjavík", "Naples",
    "Nairobi", "Havana", "Marseille", "Lima", "Beijing",
    "Prague", "Wellington", "Newfoundland",
]

TITLE_NAME = [
    "Marlow", "Anya", "Ines", "Yusuf", "Halina", "Mateus", "Ada",
    "Ivo", "Beatriz", "Kenji", "Rafi", "Odalys", "Nia", "Elias",
    "Sasha", "Petra", "Amara", "Diego", "Bao", "Ilse",
]

TITLE_NUMBERS = ["Seven", "Nine", "Twelve", "Forty", "One Hundred"]

DIRECTOR_FIRST = [
    "Ana", "Aleksey", "Bahareh", "Bo", "Chloé", "Dae-hyun", "Elena", "Ethan",
    "Fatima", "Gabriel", "Hiro", "Ingrid", "Ismael", "Julia", "Kiran",
    "Laila", "Lars", "Mira", "Nadia", "Odell", "Petra", "Quan", "Ravi",
    "Sofia", "Théo", "Ulrika", "Vera", "Wren", "Yuki", "Zara",
]
DIRECTOR_LAST = [
    "Adamu", "Bergmann", "Costa", "Dvořák", "Ekpo", "Fikret", "González",
    "Halász", "Ito", "Jarosz", "Karim", "Lindqvist", "Molnár", "Nakamura",
    "O'Kelly", "Pereira", "Qureshi", "Radović", "Salinas", "Takahashi",
    "Ustinova", "Vega", "Wickström", "Xhepa", "Yusupov", "Zabala",
]

PLURAL_NOUNS = ["Letters", "Sisters", "Widows", "Trains", "Doors", "Rivers", "Silences"]


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------

def make_title() -> str:
    pattern = random.choice(TITLE_PATTERNS)
    return pattern.format(
        adj=random.choice(TITLE_ADJ),
        noun=random.choice(TITLE_NOUN),
        noun2=random.choice(TITLE_NOUN),
        name=random.choice(TITLE_NAME),
        place=random.choice(TITLE_PLACE),
        number=random.choice(TITLE_NUMBERS),
        plural_noun=random.choice(PLURAL_NOUNS),
    )


def make_director() -> str:
    return f"{random.choice(DIRECTOR_FIRST)} {random.choice(DIRECTOR_LAST)}"


def make_description() -> str:
    template = random.choice([
        "A {char} in {setting} {incident}, {consequence}.",
        "In {setting}, a {char} {incident}, {consequence}.",
        "When a {char} {incident}, {consequence}.",
        "{char_cap} in {setting} {incident} — {consequence}.",
    ])
    char = random.choice(CHARACTERS + TEEN_CHARS)
    return template.format(
        char=char,
        char_cap=char[0].upper() + char[1:],
        setting=random.choice(SETTINGS),
        incident=random.choice(INCIDENTS),
        consequence=random.choice(CONSEQUENCES),
    )


def pick_moods(genres: tuple[str, ...]) -> list[str]:
    pool: list[str] = []
    for g in genres:
        pool.extend(MOODS_BY_GENRE.get(g, []))
    if not pool:
        pool = ["quiet", "warm"]
    k = random.choice([2, 3, 3])
    return random.sample(list(dict.fromkeys(pool)), min(k, len(set(pool))))


def hue_from_moods(moods: list[str]) -> int:
    hues = [HUE_BY_MOOD.get(m, 220) for m in moods]
    return int(sum(hues) / len(hues))


def generate_one(next_id: int) -> dict:
    genres = list(random.choice(GENRE_COMBOS))
    moods = pick_moods(tuple(genres))
    return {
        "id": next_id,
        "title": make_title(),
        "year": random.randint(1962, 2024),
        "director": make_director(),
        "genres": genres,
        "mood": moods,
        "hue": hue_from_moods(moods),
        "description": make_description(),
    }


def main() -> None:
    seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    # Preserve seeds and their ids as canonical anchors.
    seed_ids = {item["id"] for item in seeds}
    next_id = max(seed_ids) + 1
    needed = TARGET_TOTAL - len(seeds)
    if needed <= 0:
        print(f"Already have {len(seeds)} — nothing to generate.")
        return
    print(f"Generating {needed} synthetic movies (seeds: {len(seeds)}, target: {TARGET_TOTAL})...")

    synthetic: list[dict] = []
    seen_titles = {item["title"] for item in seeds}
    SEQUELS = [" II", " III", " IV", " V", " VI", " VII"]
    for _ in range(needed):
        item = generate_one(next_id)
        base = item["title"]
        if base in seen_titles:
            # Sequel-ify on collision — at 100K scale the title space repeats.
            for suffix in SEQUELS:
                if base + suffix not in seen_titles:
                    item["title"] = base + suffix
                    break
            else:
                item["title"] = f"{base} ({item['year']}-{next_id})"
        seen_titles.add(item["title"])
        synthetic.append(item)
        next_id += 1

    all_movies = seeds + synthetic
    SEED_PATH.write_text(json.dumps(all_movies, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(all_movies)} movies to {SEED_PATH}")


if __name__ == "__main__":
    main()
