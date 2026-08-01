/**
 * The demo can point at more than one collection, on more than one cluster.
 *
 *   movies    19,907 film plots, 384-d MiniLM, eu-west-2
 *   products  1,000,000 catalog items, 768-d multilingual mpnet, us-west-2
 *
 * They differ in embedding model, vector size, cluster, and payload shape, so
 * everything that varies lives here and the rest of the app just passes a key
 * around. Payloads are normalized to one display shape (title / subtitle) so
 * result rows render identically whichever dataset is active.
 */

export type DatasetKey = "movies" | "products";

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
  products: {
    key: "products",
    label: "Products",
    blurb: "catalog items, 768-d multilingual mpnet",
    urlEnv: "QDRANT_PRODUCTS_URL",
    keyEnv: "QDRANT_PRODUCTS_API_KEY",
    collectionEnv: "QDRANT_PRODUCTS_COLLECTION",
    collectionDefault: "products_1m",
    dim: 768,
    model: "Xenova/paraphrase-multilingual-mpnet-base-v2",
    textField: "description",
    filterField: "category",
    filterValues: ["Electronics", "Furniture", "Beauty", "Toys & Games", "Garden"],
    hasVariants: false,
  },
};

export function getDataset(key?: string): DatasetConfig {
  return DATASETS[(key as DatasetKey) ?? "movies"] ?? DATASETS.movies;
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

export function toDisplay(payload: Record<string, unknown> | undefined, dataset: DatasetKey): DisplayPayload {
  const p = payload ?? {};
  if (dataset === "products") {
    const name = String(p.name ?? "untitled");
    const category = String(p.category ?? "");
    return {
      title: name,
      subtitle: category,
      hue: hueFrom(category || name),
      description: p.description ? String(p.description) : undefined,
      facets: category ? [category] : [],
    };
  }
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
