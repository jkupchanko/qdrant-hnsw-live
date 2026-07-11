/** Genre → color mapping for the semantic map. Uses Qdrant palette + extensions. */
export const GENRE_COLOR: Record<string, string> = {
  drama: "#DC244C",
  romance: "#FF8792",
  "sci-fi": "#6047FF",
  thriller: "#9E0D38",
  horror: "#4325AE",
  comedy: "#FF9800",
  animation: "#C2C5FF",
  action: "#FF6B00",
  fantasy: "#9C27B0",
  "coming-of-age": "#4CAF50",
  western: "#795548",
  documentary: "#656B7F",
  noir: "#3E4152",
  musical: "#E91E63",
  mystery: "#009688",
  biography: "#03A9F4",
  family: "#FFC107",
  period: "#8D6E63",
  adventure: "#00BCD4",
  music: "#F06292",
};

/** Ordered list, used to render the legend deterministically. */
export const GENRE_ORDER = [
  "drama",
  "sci-fi",
  "thriller",
  "romance",
  "horror",
  "comedy",
  "action",
  "fantasy",
  "coming-of-age",
  "mystery",
  "animation",
  "western",
  "noir",
  "musical",
  "documentary",
  "biography",
];

export function colorFor(genres: string[]): string {
  for (const g of genres) {
    if (GENRE_COLOR[g]) return GENRE_COLOR[g];
  }
  return "#656B7F";
}
