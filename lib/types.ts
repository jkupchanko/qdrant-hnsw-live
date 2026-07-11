/** Slim shape shipped in public/data/movies.json — only what the client needs to render. */
export interface Movie {
  id: number;
  title: string;
  genres: string[];
  hue: number;
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
}

export interface SearchHit {
  id: number;
  score: number;
  payload: MoviePayload;
}
