/**
 * Browser-side embedding with the same model the corpus was built with
 * (all-MiniLM-L6-v2, via transformers.js). Lazy singleton — the ~25 MB model
 * downloads on first use, then lives in browser cache.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipePromise: Promise<any> | null = null;

export async function embedText(text: string): Promise<number[]> {
  if (!pipePromise) {
    pipePromise = import("@xenova/transformers").then(async (m) => {
      m.env.allowLocalModels = false;
      return m.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    });
  }
  const pipe = await pipePromise;
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}
