/**
 * Browser-side embedding with the same model the corpus was built with
 * (all-MiniLM-L6-v2, via transformers.js). Lazy singleton — the ~25 MB model
 * downloads on first use, then lives in browser cache.
 */

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

// One cached pipeline per model id. A collection can only be searched with the
// model it was built with, so the caller passes the model and we keep each one
// warm independently.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipes = new Map<string, Promise<any>>();

export async function embedText(text: string, model: string = DEFAULT_MODEL): Promise<number[]> {
  let pipePromise = pipes.get(model);
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
        return m.pipeline("feature-extraction", model);
      })
      .catch((e) => {
        pipes.delete(model); // allow retry — don't poison the cache
        throw normalizeError(e);
      });
    pipes.set(model, pipePromise);
  }
  try {
    const pipe = await pipePromise;
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(out.data as Float32Array);
  } catch (e) {
    throw normalizeError(e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cePromise: Promise<any> | null = null;

/**
 * Cross-encoder re-ranking (ms-marco-MiniLM-L-6-v2): scores each
 * (query, document) pair jointly — slower but sharper than the bi-encoder.
 * Returns one relevance logit per doc; higher = more relevant.
 */
export async function rerankPairs(query: string, docs: string[]): Promise<number[]> {
  if (!cePromise) {
    cePromise = import("@xenova/transformers")
      .then(async (m) => {
        m.env.allowLocalModels = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onnx = (m.env as any).backends?.onnx;
        if (onnx?.wasm) {
          onnx.wasm.numThreads = 1;
          onnx.wasm.proxy = false;
        }
        const id = "Xenova/ms-marco-MiniLM-L-6-v2";
        const [tokenizer, model] = await Promise.all([
          m.AutoTokenizer.from_pretrained(id),
          m.AutoModelForSequenceClassification.from_pretrained(id),
        ]);
        return { tokenizer, model };
      })
      .catch((e) => {
        cePromise = null;
        throw normalizeError(e);
      });
  }
  try {
    const { tokenizer, model } = await cePromise;
    const inputs = tokenizer(Array(docs.length).fill(query), {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    return Array.from(logits.data as Float32Array);
  } catch (e) {
    throw normalizeError(e);
  }
}

function normalizeError(e: unknown): Error {
  if (e instanceof Error) return e;
  // Worker/wasm failures often reject with a browser Event, not an Error.
  return new Error("Embedding model failed to load. Check the network and try again.");
}
