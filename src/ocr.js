// OCR via Tesseract.js (loaded as global Tesseract). All assets are vendored
// locally under lib/tesseract/ because the extension CSP blocks CDN loads.
//
// Returns word boxes in the OCR image's pixel space; the caller maps them to
// unit space (page points) and builds a synthetic, selectable text layer.

const api = globalThis.browser || globalThis.chrome;

let workerPromise = null;
let progressHandler = null;

export function setOcrProgress(fn) { progressHandler = fn; }

function base() { return api.runtime.getURL("lib/tesseract/"); }

async function getWorker() {
  if (workerPromise) return workerPromise;
  if (!globalThis.Tesseract) throw new Error("OCR engine not loaded");
  // OEM must be LSTM_ONLY(1) or DEFAULT(3) so the worker loads the vendored
  // tesseract-core-simd-lstm core (the only core we bundle).
  const OEM_LSTM = (globalThis.Tesseract.OEM && globalThis.Tesseract.OEM.LSTM_ONLY) ?? 1;
  workerPromise = globalThis.Tesseract.createWorker("eng", OEM_LSTM, {
    workerPath: base() + "worker.min.js",
    corePath: base(),                 // worker appends /tesseract-core-simd-lstm.wasm.js
    langPath: base() + "tessdata",    // holds eng.traineddata.gz
    workerBlobURL: false,             // MV3 CSP: no blob: workers
    gzip: true,
    logger: (m) => { if (progressHandler) progressHandler(m); },
  });
  return workerPromise;
}

// Recognize a canvas → [{ text, x0, y0, x1, y1 }] in canvas pixel coords.
export async function ocrCanvas(canvas) {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas); // default output includes hierarchical blocks
  const words = [];
  for (const b of data.blocks || [])
    for (const p of b.paragraphs || [])
      for (const l of p.lines || [])
        for (const w of l.words || [])
          if (w.text && w.text.trim()) {
            const bb = w.bbox || {};
            words.push({ text: w.text, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 });
          }
  return words;
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch { /* ignore */ }
  workerPromise = null;
}
