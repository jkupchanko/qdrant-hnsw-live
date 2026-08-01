/**
 * The demo can point at more than one collection, on more than one cluster.
 * Right now there is exactly one: the movie corpus. A second entry lands here
 * when the 1M movie collection is built, and the UI picks it up automatically
 * (the dataset switcher hides itself while only one entry exists).
 *
 * Datasets may differ in embedding model, vector size, cluster, and payload
 * shape, so everything that varies lives here and the rest of the app just
 * passes a key around. Payloads are normalized to one display shape
 * (title / subtitle) so result rows render identically for any dataset.
 */

export type DatasetKey = "movies";

export interface DatasetConfig {
  key: DatasetKey;
  label: string;
  /** Shown next to the label, e.g. "19,907 movies". Filled from live stats when available. */
  blurb: string;
  urlEnv: string;
  keyEnv: string;
  collectionEnv: string;
  collectionDefault: string;
  /** Vector size, used to sanity-check an incoming query vector. */
  dim: number;
  /** transformers.js model id — MUST match what the collection was built with. */
  model: string;
  /** Payload field the full-text index covers. */
  textField: string;
  /** Keyword-indexed field used by the filtering face-off. */
  filterField: string;
  /** A few real values of filterField, for the face-off buttons. */
  filterValues: string[];
  /** True when sibling collections exist with other distance metrics / m values. */
  hasVariants: boolean;
}

export const DATASETS: Record<DatasetKey, DatasetConfig> = {
  movies: {
    key: "movies",
    label: "Movies",
    blurb: "film plots, 384-d MiniLM",
    urlEnv: "QDRANT_URL",
    keyEnv: "QDRANT_API_KEY",
    collectionEnv: "QDRANT_COLLECTION",
    collectionDefault: "movies",
    dim: 384,
    model: "Xenova/all-MiniLM-L6-v2",
    textField: "description",
    filterField: "genres",
    filterValues: ["drama", "sci-fi", "thriller", "comedy", "horror"],
    hasVariants: true,
  },
};

export function getDataset(key?: string): DatasetConfig {
  if (!key) return DATASETS.movies;
  const found = DATASETS[key as DatasetKey];
  // Falling back silently would answer a request for an unknown dataset with
  // movie data, which reads as success. Fail instead.
  if (!found) throw new Error(`Unknown dataset "${key}".`);
  return found;
}

/** Client-safe view: no env values, just what the UI needs to label things. */
export const DATASET_META = Object.values(DATASETS).map(
  ({ key, label, blurb, dim, model, filterField, filterValues, hasVariants }) => ({
    key,
    label,
    blurb,
    dim,
    model,
    filterField,
    filterValues,
    hasVariants,
  }),
);

/** One display shape for result rows, whatever the underlying payload looks like. */
export interface DisplayPayload {
  title: string;
  subtitle: string;
  hue: number;
  poster?: string;
  description?: string;
  /**
   * Every value of this dataset's filterField, untruncated. The subtitle is
   * shortened for display, so filter checks must use this instead or a hit
   * whose third genre matched would be miscounted as a miss.
   */
  facets: string[];
}

function hueFrom(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

export function toDisplay(payload: Record<string, unknown> | undefined, _dataset: DatasetKey): DisplayPayload {
  const p = payload ?? {};
  const title = String(p.title ?? "untitled");
  const year = p.year ? String(p.year) : "";
  const allGenres = Array.isArray(p.genres) ? (p.genres as string[]) : [];
  return {
    title,
    subtitle: [year, allGenres.slice(0, 2).join(", ")].filter(Boolean).join(" · "),
    hue: typeof p.hue === "number" ? p.hue : hueFrom(title),
    poster: p.poster ? String(p.poster) : undefined,
    description: p.description ? String(p.description) : undefined,
    facets: allGenres,
  };
}
