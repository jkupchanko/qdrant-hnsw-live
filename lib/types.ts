/** Slim shape shipped in public/data/movies.json — only what the map needs. */
export interface Movie {
  id: number;
  genres: string[];
  x: number;
  y: number;
}

/** A sparse vector as Qdrant wants it: parallel index and weight arrays. */
export interface SparseVec {
  indices: number[];
  values: number[];
}

export interface Query {
  text: string;
  vector: number[];
  /**
   * Sparse counterparts, precomputed by scripts/add_query_sparse.py.
   * Absent on visitor-typed queries: a browser can only build the dense
   * vector, and this cluster has no Cloud Inference to build the rest.
   */
  bm25?: SparseVec;
  minicoil?: SparseVec;
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
