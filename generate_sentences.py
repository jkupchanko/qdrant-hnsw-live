"""One-off script to generate fake_sentences.py with 1000 unique sentences."""

CATEGORIES = [
    "AI", "Database", "Programming", "Science", "History",
    "Geography", "Food", "Sports", "Music", "Health",
    "Business", "Nature", "Space", "Literature", "Art",
]

TEMPLATES = {
    "AI": [
        "Neural networks learn patterns from labeled training data using backpropagation.",
        "Transformer models use self-attention to weigh relationships between all tokens in a sequence.",
        "Large language models predict the next token based on billions of parameters.",
        "Computer vision systems classify images by detecting edges, shapes, and textures.",
        "Reinforcement learning agents improve through trial-and-error reward signals.",
        "Embeddings map words and sentences into dense vector spaces for similarity search.",
        "Fine-tuning adapts a pre-trained model to a specific domain with smaller datasets.",
        "Prompt engineering guides model behavior without changing underlying weights.",
        "Retrieval-augmented generation combines search results with LLM responses.",
        "Diffusion models generate images by iteratively denoising random noise.",
    ],
    "Database": [
        "PostgreSQL supports ACID transactions and advanced indexing strategies.",
        "MongoDB stores documents in flexible JSON-like BSON format.",
        "Redis keeps data in memory for sub-millisecond key-value lookups.",
        "SQL joins combine rows from multiple tables using foreign keys.",
        "Database normalization reduces redundancy by splitting data into related tables.",
        "Qdrant is a vector database optimized for similarity search at scale.",
        "Elasticsearch indexes full-text content for fast keyword and fuzzy queries.",
        "Database sharding distributes data across multiple servers for horizontal scaling.",
        "Write-ahead logging ensures durability by recording changes before applying them.",
        "Connection pooling reuses database connections to reduce overhead.",
    ],
    "Programming": [
        "Python uses indentation to define code blocks instead of curly braces.",
        "Recursion solves problems by calling a function with smaller subproblems.",
        "Git tracks file changes and enables branching for collaborative development.",
        "REST APIs expose resources through standard HTTP methods like GET and POST.",
        "Unit tests verify individual functions behave correctly in isolation.",
        "Docker packages applications with dependencies into portable containers.",
        "Async programming handles concurrent I/O without blocking the main thread.",
        "Type hints in Python improve code readability and enable static analysis.",
        "Hash maps provide average O(1) lookup time for key-value pairs.",
        "Continuous integration automatically runs tests on every code push.",
    ],
    "Science": [
        "Photosynthesis converts sunlight, water, and carbon dioxide into glucose and oxygen.",
        "DNA carries genetic instructions encoded in sequences of four nucleotide bases.",
        "Newton's third law states every action has an equal and opposite reaction.",
        "The periodic table organizes elements by atomic number and chemical properties.",
        "Mitochondria generate ATP, the primary energy currency of cells.",
        "Quantum entanglement links particles so measuring one instantly affects the other.",
        "Plate tectonics explains continental drift through moving lithospheric plates.",
        "The speed of light in a vacuum is approximately 299,792 kilometers per second.",
        "CRISPR allows precise editing of DNA sequences in living organisms.",
        "Entropy in closed systems tends to increase over time according to thermodynamics.",
    ],
    "History": [
        "The printing press invented by Gutenberg revolutionized information spread in Europe.",
        "The Roman Empire at its peak controlled territory across three continents.",
        "The Industrial Revolution shifted economies from agriculture to mechanized manufacturing.",
        "The Magna Carta of 1215 limited royal power and established legal rights.",
        "The Silk Road connected East Asia to the Mediterranean for centuries of trade.",
        "World War II ended in 1945 after Allied forces defeated Axis powers.",
        "The French Revolution began in 1789 and reshaped European political structures.",
        "Ancient Egypt built pyramids as tombs for pharaohs along the Nile River.",
        "The Renaissance revived classical learning and sparked artistic innovation in Italy.",
        "The Berlin Wall fell in 1989, symbolizing the end of the Cold War division.",
    ],
    "Geography": [
        "The Amazon rainforest produces roughly twenty percent of Earth's oxygen.",
        "Mount Everest rises 8,849 meters above sea level in the Himalayas.",
        "The Sahara Desert spans over nine million square kilometers in North Africa.",
        "The Pacific Ocean is the largest and deepest ocean on the planet.",
        "The Nile River is traditionally considered the longest river in the world.",
        "Antarctica holds about ninety percent of the world's freshwater ice.",
        "The Great Barrier Reef stretches over two thousand kilometers off Australia.",
        "Iceland sits on the Mid-Atlantic Ridge with active volcanoes and geysers.",
        "The Dead Sea has such high salinity that swimmers float effortlessly.",
        "The Ring of Fire encircles the Pacific Ocean with frequent earthquakes and eruptions.",
    ],
    "Food": [
        "Sourdough bread relies on wild yeast and lactobacilli for fermentation and flavor.",
        "Umami is the fifth basic taste, often found in aged cheese and soy sauce.",
        "Maillard reaction browning creates complex flavors when proteins and sugars heat together.",
        "Fermentation preserves food by converting sugars into acids, gases, or alcohol.",
        "Espresso extraction uses high pressure to pull concentrated coffee from fine grounds.",
        "Sushi rice is seasoned with rice vinegar, sugar, and salt for balance.",
        "Slow cooking breaks down collagen in tough cuts of meat into tender gelatin.",
        "Emulsification blends oil and water using an emulsifier like egg yolk in mayonnaise.",
        "Caramelization occurs when sugars are heated above their melting point.",
        "Knife skills affect cooking speed and evenness of ingredient preparation.",
    ],
    "Sports": [
        "Marathon runners typically hit the wall around mile twenty due to glycogen depletion.",
        "Offside rules in soccer prevent attackers from gaining unfair positional advantage.",
        "A tennis serve must land in the diagonal service box to be considered valid.",
        "Basketball three-pointers are worth more because they are taken from farther distance.",
        "Swimming freestyle uses alternating arm strokes and flutter kicks for speed.",
        "Cricket test matches can last up to five days with two innings per team.",
        "Golf handicaps level competition by adjusting scores based on player skill.",
        "Rock climbing grades rate route difficulty based on holds and angle.",
        "Cycling pelotons reduce wind resistance for riders drafting behind leaders.",
        "Olympic weightlifting tests maximum snatch and clean-and-jerk lifts.",
    ],
    "Music": [
        "Beethoven composed his Ninth Symphony while completely deaf.",
        "Jazz improvisation builds melodies over chord progressions in real time.",
        "A major scale follows the pattern whole-whole-half-whole-whole-whole-half steps.",
        "The violin family includes violin, viola, cello, and double bass.",
        "Polyrhythms layer two or more conflicting rhythmic patterns simultaneously.",
        "Reverb simulates sound reflections in physical spaces for depth and ambience.",
        "Blues music originated in African American communities in the Deep South.",
        "Counterpoint weaves independent melodic lines that harmonize with each other.",
        "Tempo is measured in beats per minute and affects the energy of a piece.",
        "Sampling reuses portions of existing recordings in new musical compositions.",
    ],
    "Health": [
        "Vaccines train the immune system to recognize pathogens without causing illness.",
        "Regular aerobic exercise strengthens the heart and improves lung capacity.",
        "Sleep deprivation impairs memory consolidation and cognitive performance.",
        "Antibiotics target bacterial infections but are ineffective against viruses.",
        "Hydration supports kidney function, temperature regulation, and joint lubrication.",
        "Fiber in whole grains aids digestion and helps maintain stable blood sugar.",
        "Mindfulness meditation reduces stress by focusing attention on the present moment.",
        "Vitamin D supports bone health and is synthesized through sunlight exposure.",
        "Hand washing with soap breaks down lipid membranes of many harmful microbes.",
        "Physical therapy restores movement and strength after injury or surgery.",
    ],
    "Business": [
        "Supply chain management coordinates sourcing, production, and delivery of goods.",
        "Venture capital funds early-stage startups in exchange for equity ownership.",
        "Market segmentation divides customers into groups with similar needs and behaviors.",
        "Cash flow statements track money entering and leaving a business over time.",
        "Brand equity represents the value a brand name adds beyond the product itself.",
        "Economies of scale reduce per-unit costs as production volume increases.",
        "Net present value discounts future cash flows to assess investment profitability.",
        "Agile methodology delivers software in iterative sprints with frequent feedback.",
        "Customer lifetime value estimates total revenue a customer generates over time.",
        "Corporate governance defines roles and accountability for company leadership.",
    ],
    "Nature": [
        "Bees pollinate roughly one-third of the food crops humans consume worldwide.",
        "Octopuses have three hearts and blue blood containing copper-based hemocyanin.",
        "Wolves live in packs with complex social hierarchies led by an alpha pair.",
        "Coral reefs support about twenty-five percent of all marine species.",
        "Migratory birds navigate using Earth's magnetic field and celestial cues.",
        "Redwood trees can live over two thousand years and grow taller than skyscrapers.",
        "Bioluminescent organisms produce light through chemical reactions in their bodies.",
        "Symbiosis describes close relationships where species benefit from each other.",
        "Keystone species disproportionately affect ecosystem structure and biodiversity.",
        "Camouflage helps predators and prey blend into their surroundings for survival.",
    ],
    "Space": [
        "Black holes have gravity so strong that not even light can escape past the event horizon.",
        "Mars has the largest volcano in the solar system, Olympus Mons.",
        "The Hubble Space Telescope has captured images of galaxies billions of light-years away.",
        "Saturn's rings are made mostly of ice particles ranging from dust to house-sized chunks.",
        "A light-year is the distance light travels in one year, about 9.46 trillion kilometers.",
        "Neutron stars are so dense a teaspoon of their material would weigh billions of tons.",
        "The James Webb Space Telescope observes infrared light from the early universe.",
        "Jupiter's Great Red Spot is a giant storm larger than Earth that has raged for centuries.",
        "Astronauts experience microgravity because they are in continuous free fall around Earth.",
        "The Milky Way galaxy contains an estimated one hundred to four hundred billion stars.",
    ],
    "Literature": [
        "Homer's Odyssey follows Odysseus on his ten-year journey home after the Trojan War.",
        "Shakespeare wrote approximately thirty-seven plays and one hundred fifty-four sonnets.",
        "Magical realism blends fantastical elements with realistic settings in Latin American fiction.",
        "Haiku is a Japanese poetic form with three lines following a five-seven-five syllable pattern.",
        "Dystopian novels explore societies suffering from oppressive governments or environmental collapse.",
        "Stream of consciousness narration portrays a character's thoughts as a continuous flow.",
        "The hero's journey is a narrative pattern where a protagonist ventures out and returns transformed.",
        "Satire uses humor and irony to criticize politics, society, or human behavior.",
        "Epistolary novels tell stories through letters, diary entries, or other documents.",
        "Metaphor compares two unlike things without using like or as for deeper meaning.",
    ],
    "Art": [
        "Impressionist painters captured fleeting light and color using visible brushstrokes.",
        "Perspective in drawing creates the illusion of depth on a flat surface.",
        "Sculpture can be created through carving, modeling, casting, or assembling materials.",
        "Color theory explains how hues, saturation, and value interact in visual design.",
        "Cubism fragmented objects into geometric shapes viewed from multiple angles.",
        "Negative space is the empty area around and between subjects in a composition.",
        "Fresco painting applies pigment onto wet plaster so colors bond with the wall.",
        "Abstract art emphasizes form, color, and line rather than recognizable subjects.",
        "Chiaroscuro uses strong contrasts between light and dark to create dramatic effect.",
        "Street art transforms public spaces with murals, stencils, and installations.",
    ],
}


def generate_sentences(count=1000):
    sentences = []
    categories = list(TEMPLATES.keys())
    idx = 0
    round_num = 0

    while len(sentences) < count:
        for cat in categories:
            templates = TEMPLATES[cat]
            for tmpl in templates:
                if round_num == 0:
                    sentence = tmpl
                else:
                    sentence = f"[Set {round_num + 1}] {tmpl}"
                sentences.append({"text": sentence, "category": cat})
                idx += 1
                if len(sentences) >= count:
                    break
            if len(sentences) >= count:
                break
        round_num += 1

    return sentences[:count]


def main():
    sentences = generate_sentences(1000)
    lines = ['"""1000 unique sentences for semantic search testing."""\n', "FAKE_SENTENCES = [\n"]
    for item in sentences:
        text = item["text"].replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'    {{"text": "{text}", "category": "{item["category"]}"}},\n')
    lines.append("]\n")

    with open("fake_sentences.py", "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"Wrote {len(sentences)} sentences to fake_sentences.py")


if __name__ == "__main__":
    main()
