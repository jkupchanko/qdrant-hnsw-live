/** Slim shape shipped in public/data/movies.json — only what the map needs. */
export interface Movie {
  id: number;
  genres: string[];
  x: number;
  y: number;
}

export interface Query {
  text: string;
  vector: number[];
}

export interface MoviePayload {
  title: string;
  year: number;
  director?: string;
  genres: string[];
  mood: string[];
  hue: number;
  description: string;
  /** Wikipedia lead-image thumbnail, when the article has one. */
  poster?: string;
}

export interface SearchHit {
  id: number;
  score: number;
  payload: MoviePayload;
}
