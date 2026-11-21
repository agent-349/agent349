/**
 * OCR worker thread (built as its own file, `dist/ocrWorker.js`).
 *
 * Everything CPU-heavy happens here, off the host's event loop: reading the
 * PDF text layer (pdf.js), rendering the pages without text to an image
 * (pdf.js + @napi-rs/canvas) and recognising them (tesseract.js, which runs
 * its own WASM worker). The host only sends the file and receives text.
 *
 * Protocol (see OcrService):
 *   host → worker  { type: 'pdf' | 'image', id, data: Uint8Array, options }
 *   worker → host  { type: 'progress', id, page }   (heartbeat for the page timeout)
 *                  { type: 'done', id, result }     ({@link OcrWorkerResult})
 *                  { type: 'error', id, message }
 */
import { parentPort } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Options sent with every task. */
export interface OcrWorkerOptions {
  languages: string[];
  langPath?: string;
  allowDownload: boolean;
  minChars: number;
  renderWidth: number;
  maxPages: number;
  /** Pages under this confidence (0–100) are returned as PNG for escalation. */
  escalateBelow?: number;
  /** Most pages returned as PNG per file. */
  escalateMax?: number;
}

/** One page as the worker reports it. */
export interface OcrWorkerPage {
  page: number;
  source: 'text' | 'ocr';
  text: string;
  confidence?: number;
  /** PNG of the page, only for pages to escalate. */
  png?: Uint8Array;
}

/** Result of a task. */
export interface OcrWorkerResult {
  pages: OcrWorkerPage[];
  ocrPages: number;
  skippedPages: number;
  errors: string[];
}

interface Task {
  type: 'pdf' | 'image';
  id: number;
  data: Uint8Array;
  options: OcrWorkerOptions;
}

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

let tesseract: TesseractWorker | undefined;
let tesseractKey = '';

/** A tesseract worker for the languages, reusing the current one when they match. */
async function tesseractFor(options: OcrWorkerOptions): Promise<TesseractWorker> {
  const key = JSON.stringify([options.languages, options.langPath, options.allowDownload]);
  if (tesseract !== undefined && key === tesseractKey) return tesseract;
  if (tesseract !== undefined) await tesseract.terminate().catch(() => undefined);
  if (!options.allowDownload) {
    const dir = options.langPath ?? '';
    const missing = options.languages.filter((l) => !existsSync(join(dir, `${l}.traineddata`)));
    if (dir === '' || missing.length > 0) {
      throw new Error(
        `OCR language data not found: ${missing.map((l) => `${l}.traineddata`).join(', ') || '(no langPath)'} in ${dir || '(langPath not set)'}; set langPath to a folder with the .traineddata files or enable allowDownload`,
      );
    }
  }
  const mod = (await import('tesseract.js')) as unknown as {
    createWorker: (
      langs: string,
      oem: number,
      opts: Record<string, unknown>,
    ) => Promise<TesseractWorker>;
  };
  const opts: Record<string, unknown> = options.allowDownload
    ? { ...(options.langPath !== undefined && { cachePath: options.langPath }) }
    : {
        langPath: options.langPath,
        cachePath: options.langPath,
        gzip: false,
        cacheMethod: 'readOnly',
      };
  tesseract = await mod.createWorker(options.languages.join('+'), 1, opts);
  tesseractKey = key;
  return tesseract;
}

/** Collapsed whitespace length: what counts as "text on the page". */
const chars = (text: string): number => text.replace(/\s+/g, ' ').trim().length;

async function recognize(
  image: Buffer,
  options: OcrWorkerOptions,
): Promise<{ text: string; confidence: number }> {
  const worker = await tesseractFor(options);
  const r = await worker.recognize(image);
  return { text: r.data.text.trim(), confidence: r.data.confidence };
}

async function runPdf(task: Task): Promise<OcrWorkerResult> {
  const { options } = task;
  const mod = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Uint8Array }) => {
      getText(): Promise<{ pages: { text: string; num?: number }[] }>;
      getScreenshot(o: Record<string, unknown>): Promise<{ pages: { data: Uint8Array }[] }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new mod.PDFParse({ data: task.data });
  const out: OcrWorkerResult = { pages: [], ocrPages: 0, skippedPages: 0, errors: [] };
  let escalated = 0;
  try {
    const text = await parser.getText();
    for (let i = 0; i < text.pages.length; i++) {
      const page = i + 1;
      const layer = text.pages[i]?.text ?? '';
      if (chars(layer) >= options.minChars) {
        out.pages.push({ page, source: 'text', text: layer.trim() });
        continue;
      }
      if (out.ocrPages >= options.maxPages) {
        out.skippedPages++;
        out.pages.push({ page, source: 'text', text: layer.trim() });
        continue;
      }
      parentPort!.postMessage({ type: 'progress', id: task.id, page });
      try {
        const shot = await parser.getScreenshot({
          partial: [page],
          desiredWidth: options.renderWidth,
          imageBuffer: true,
          imageDataUrl: false,
        });
        const png = Buffer.from(shot.pages[0]!.data);
        const r = await recognize(png, options);
        out.ocrPages++;
        // Keep whichever has more text: a page with a short real text layer
        // (a heading) and no image should not be replaced by OCR noise.
        const useOcr = chars(r.text) > chars(layer);
        const entry: OcrWorkerPage = {
          page,
          source: useOcr ? 'ocr' : 'text',
          text: useOcr ? r.text : layer.trim(),
          confidence: r.confidence,
        };
        if (
          options.escalateBelow !== undefined &&
          r.confidence < options.escalateBelow &&
          escalated < (options.escalateMax ?? 0)
        ) {
          entry.png = new Uint8Array(png);
          escalated++;
        }
        out.pages.push(entry);
      } catch (err) {
        out.errors.push(`page ${page}: ${err instanceof Error ? err.message : String(err)}`);
        out.pages.push({ page, source: 'text', text: layer.trim() });
      }
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  return out;
}

async function runImage(task: Task): Promise<OcrWorkerResult> {
  parentPort!.postMessage({ type: 'progress', id: task.id, page: 1 });
  const image = Buffer.from(task.data);
  const r = await recognize(image, task.options);
  const page: OcrWorkerPage = { page: 1, source: 'ocr', text: r.text, confidence: r.confidence };
  if (
    task.options.escalateBelow !== undefined &&
    r.confidence < task.options.escalateBelow &&
    (task.options.escalateMax ?? 0) > 0
  ) {
    page.png = new Uint8Array(image);
  }
  return { pages: [page], ocrPages: 1, skippedPages: 0, errors: [] };
}

parentPort?.on('message', (task: Task) => {
  const run = task.type === 'image' ? runImage(task) : runPdf(task);
  run.then(
    (result) => {
      const transfer = result.pages.flatMap((p) =>
        p.png !== undefined ? [p.png.buffer as ArrayBuffer] : [],
      );
      parentPort!.postMessage({ type: 'done', id: task.id, result }, transfer);
    },
    (err: unknown) => {
      parentPort!.postMessage({
        type: 'error',
        id: task.id,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
});
