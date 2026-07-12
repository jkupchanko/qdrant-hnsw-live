/**
 * Browser-side embedding with the same model the corpus was built with
 * (all-MiniLM-L6-v2, via transformers.js). Lazy singleton — the ~25 MB model
 * downloads on first use, then lives in browser cache.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipePromise: Promise<any> | null = null;

export async function embedText(text: string): Promise<number[]> {
  if (!pipePromise) {
    pipePromise = import("@xenova/transformers")
      .then(async (m) => {
        m.env.allowLocalModels = false;
        // Single-threaded WASM: multithreading needs SharedArrayBuffer, which
        // requires COOP/COEP headers we don't serve. Without this the worker
        // fails with a raw ErrorEvent ("[object Event]").
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onnx = (m.env as any).backends?.onnx;
        if (onnx?.wasm) {
          onnx.wasm.numThreads = 1;
          onnx.wasm.proxy = false;
        }
        return m.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      })
      .catch((e) => {
        pipePromise = null; // allow retry — don't poison the singleton
        throw normalizeError(e);
      });
  }
  try {
    const pipe = await pipePromise;
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(out.data as Float32Array);
  } catch (e) {
    throw normalizeError(e);
  }
}

function normalizeError(e: unknown): Error {
  if (e instanceof Error) return e;
  // Worker/wasm failures often reject with a browser Event, not an Error.
  return new Error("Embedding model failed to load. Check the network and try again.");
}
