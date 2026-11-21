import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OcrWorkerOptions, OcrWorkerPage, OcrWorkerResult } from './ocrWorker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Recognises the text of a page image with a vision model (see `createVisionRecognizer`). */
export type VisionRecognizer = (png: Uint8Array, languages: string[]) => Promise<{ text: string }>;

/** Options of {@link OcrService}. */
export interface OcrServiceOptions {
  /**
   * Tesseract languages (`spa`, `eng`, `por`, `chi_sim`…; several are joined
   * as `spa+eng`). A task can override them. Default: `['eng']`.
   */
  languages?: string[];
  /**
   * Folder with the `<lang>.traineddata` files (uncompressed). Required unless
   * `allowDownload` is true; with downloads it is also where they are cached.
   */
  langPath?: string;
  /** Download missing language data from the tesseract.js CDN. Default: `false`. */
  allowDownload?: boolean;
  /** A PDF page with fewer characters of text than this is OCR'd. Default: 80. */
  minChars?: number;
  /** Width in pixels the page is rendered at for OCR (~200 dpi on A4). Default: 1700. */
  renderWidth?: number;
  /** Most pages OCR'd per file; the rest keep their text layer. Default: 200. */
  maxPages?: number;
  /** A page that takes longer is abandoned: the worker is terminated. Default: 120 000. */
  pageTimeoutMs?: number;
  /** A worker idle for this long is terminated, freeing its memory (0 keeps it). Default: 60 000. */
  idleTimeoutMs?: number;
  /** Files processed at once, one worker thread each. Default: 1. */
  concurrency?: number;
  /** Re-read low-confidence pages with a vision model. Off when absent. */
  escalate?: {
    /** Tesseract confidence (0–100) below which a page is escalated. Default: 70. */
    belowConfidence?: number;
    /** Most pages escalated per file. Default: 20. */
    maxPagesPerFile?: number;
    /** The vision model call. */
    recognize: VisionRecognizer;
  };
  /** Path of the worker script. Default: `ocrWorker.js` next to the SDK bundle. */
  workerPath?: string;
  /** Test seam: creates the worker. */
  workerFactory?: () => OcrWorkerLike;
}

/** Minimal worker contract (a `worker_threads.Worker`). */
export interface OcrWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'message' | 'error' | 'exit', listener: (arg: any) => void): unknown;
  terminate(): Promise<number> | void;
}

/** One page of an extraction. */
export interface OcrPage {
  page: number;
  /** Where the text came from: the PDF text layer, Tesseract or the vision model. */
  source: 'text' | 'ocr' | 'vision';
  /** Characters of text (whitespace collapsed). */
  chars: number;
  /** Tesseract confidence (0–100), for OCR'd pages. */
  confidence?: number;
}

/** Result of {@link OcrService.extractPdf} / {@link OcrService.extractImage}. */
export interface OcrResult {
  /** The text of every page, in order, separated by blank lines. */
  text: string;
  pages: OcrPage[];
  /** Pages recognised with Tesseract. */
  ocrPages: number;
  /** Pages re-read with the vision model. */
  escalatedPages: number;
  /** Pages left without OCR because of `maxPages`. */
  skippedPages: number;
  /** Average Tesseract confidence of the OCR'd pages. */
  avgConfidence?: number;
  /** Wall time in ms. */
  ms: number;
  /** Per-page problems (the page keeps its text layer). */
  errors: string[];
}

/** Error of the OCR service (timeout, worker crash, missing language data…). */
export class OcrError extends Error {
  constructor(
    readonly code: 'timeout' | 'worker' | 'failed' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}

/** ISO 639-1 → Tesseract language code, for the languages the SDK covers. */
const TESSERACT_LANGUAGE: Readonly<Record<string, string>> = {
  es: 'spa',
  en: 'eng',
  pt: 'por',
  fr: 'fra',
  it: 'ita',
  de: 'deu',
  zh: 'chi_sim',
  ja: 'jpn',
  ko: 'kor',
  ru: 'rus',
  nl: 'nld',
};

// ─────────────────────────────────────────────────────────────────────────────
// OcrService
// ─────────────────────────────────────────────────────────────────────────────

interface Pending {
  type: 'pdf' | 'image';
  data: Uint8Array;
  languages: string[];
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  start: number;
}

interface Slot {
  worker?: OcrWorkerLike | undefined;
  busy?: { id: number; task: Pending; timer: NodeJS.Timeout } | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
}

/**
 * Text extraction with OCR for scanned documents, off the host's event loop.
 *
 * A PDF keeps the text layer of its pages; only pages with (almost) no text
 * are rendered and recognised with Tesseract. Images are recognised directly.
 * All the work runs in worker threads created on demand (`concurrency`, one
 * file each, pages one at a time), each terminated after `idleTimeoutMs`
 * without work and replaced when a page exceeds `pageTimeoutMs`. Optionally,
 * low-confidence pages are re-read with a vision model (`escalate`).
 *
 * Needs the optional dependency `tesseract.js` and the language data
 * (`<lang>.traineddata`) in `langPath` — no network access unless
 * `allowDownload` is true.
 */
export class OcrService {
  readonly #opts: Required<
    Pick<
      OcrServiceOptions,
      | 'languages'
      | 'minChars'
      | 'renderWidth'
      | 'maxPages'
      | 'pageTimeoutMs'
      | 'idleTimeoutMs'
      | 'concurrency'
      | 'allowDownload'
    >
  > &
    Pick<OcrServiceOptions, 'langPath' | 'escalate' | 'workerPath' | 'workerFactory'>;
  readonly #queue: Pending[] = [];
  readonly #slots: Slot[];
  #nextId = 1;
  #closed = false;

  constructor(options: OcrServiceOptions = {}) {
    this.#opts = {
      languages:
        options.languages !== undefined && options.languages.length > 0
          ? options.languages
          : ['eng'],
      minChars: options.minChars ?? 80,
      renderWidth: options.renderWidth ?? 1700,
      maxPages: options.maxPages ?? 200,
      pageTimeoutMs: options.pageTimeoutMs ?? 120_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      concurrency: Math.max(1, Math.floor(options.concurrency ?? 1)),
      allowDownload: options.allowDownload ?? false,
      ...(options.langPath !== undefined && { langPath: options.langPath }),
      ...(options.escalate !== undefined && { escalate: options.escalate }),
      ...(options.workerPath !== undefined && { workerPath: options.workerPath }),
      ...(options.workerFactory !== undefined && { workerFactory: options.workerFactory }),
    };
    this.#slots = Array.from({ length: this.#opts.concurrency }, () => ({}));
  }

  /** Tesseract code for an ISO 639-1 language (`'es-UY'` → `'spa'`), if known. */
  static tesseractLanguage(iso: string): string | undefined {
    return TESSERACT_LANGUAGE[iso.trim().toLowerCase().split(/[-_]/)[0] ?? ''];
  }

  /** Worker threads currently alive (they exist only while there is work, plus the idle time). */
  get activeWorkers(): number {
    return this.#slots.filter((s) => s.worker !== undefined).length;
  }

  /** Files waiting for a worker. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Extracts the text of a PDF, OCR'ing the pages without a text layer.
   *
   * @param data    - The PDF bytes (copied; the caller's buffer is not detached).
   * @param options - Tesseract languages for this file.
   */
  extractPdf(data: Uint8Array, options: { languages?: string[] } = {}): Promise<OcrResult> {
    return this.#enqueue('pdf', data, options.languages);
  }

  /** Recognises the text of an image (PNG, JPEG, BMP, TIFF…). */
  extractImage(data: Uint8Array, options: { languages?: string[] } = {}): Promise<OcrResult> {
    return this.#enqueue('image', data, options.languages);
  }

  /** Terminates every worker and rejects queued work. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const task of this.#queue.splice(0))
      task.reject(new OcrError('closed', 'OCR service closed'));
    await Promise.all(
      this.#slots.map((slot) => this.#retire(slot, new OcrError('closed', 'OCR service closed'))),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  #enqueue(type: 'pdf' | 'image', data: Uint8Array, languages?: string[]): Promise<OcrResult> {
    if (this.#closed) return Promise.reject(new OcrError('closed', 'OCR service closed'));
    return new Promise<OcrResult>((resolve, reject) => {
      this.#queue.push({
        type,
        // Own copy: the bytes are transferred to the worker.
        data: new Uint8Array(data),
        languages:
          languages !== undefined && languages.length > 0 ? languages : this.#opts.languages,
        resolve,
        reject,
        start: Date.now(),
      });
      this.#pump();
    });
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) return;
      if (slot.busy !== undefined) continue;
      this.#run(slot, this.#queue.shift()!);
    }
  }

  #spawn(slot: Slot): OcrWorkerLike {
    const worker =
      this.#opts.workerFactory !== undefined
        ? this.#opts.workerFactory()
        : new Worker(this.#workerPath());
    worker.on('message', (msg: Record<string, unknown>) => this.#onMessage(slot, worker, msg));
    worker.on('error', (err: Error) => this.#onCrash(slot, worker, err));
    worker.on('exit', (code: number) => {
      if (slot.worker === worker && code !== 0)
        this.#onCrash(slot, worker, new Error(`OCR worker exited with code ${code}`));
    });
    slot.worker = worker;
    return worker;
  }

  #workerPath(): string {
    if (this.#opts.workerPath !== undefined) return this.#opts.workerPath;
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      join(here, 'ocrWorker.js'),
      join(here, '..', '..', '..', 'dist', 'ocrWorker.js'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new OcrError('worker', `OCR worker script not found next to ${here}; set workerPath`);
  }

  #run(slot: Slot, task: Pending): void {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    let worker: OcrWorkerLike;
    try {
      worker = slot.worker ?? this.#spawn(slot);
    } catch (err) {
      task.reject(err instanceof Error ? err : new Error(String(err)));
      this.#pump();
      return;
    }
    const id = this.#nextId++;
    slot.busy = { id, task, timer: this.#armTimeout(slot) };
    const escalate = this.#opts.escalate;
    const options: OcrWorkerOptions = {
      languages: task.languages,
      allowDownload: this.#opts.allowDownload,
      minChars: this.#opts.minChars,
      renderWidth: this.#opts.renderWidth,
      maxPages: this.#opts.maxPages,
      ...(this.#opts.langPath !== undefined && { langPath: this.#opts.langPath }),
      ...(escalate !== undefined && {
        escalateBelow: escalate.belowConfidence ?? 70,
        escalateMax: escalate.maxPagesPerFile ?? 20,
      }),
    };
    worker.postMessage({ type: task.type, id, data: task.data, options }, [
      task.data.buffer as ArrayBuffer,
    ]);
  }

  #armTimeout(slot: Slot): NodeJS.Timeout {
    return setTimeout(() => {
      const busy = slot.busy;
      if (busy === undefined) return;
      void this.#retire(
        slot,
        new OcrError(
          'timeout',
          `OCR page took longer than ${this.#opts.pageTimeoutMs} ms; worker terminated`,
        ),
      ).then(() => this.#pump());
    }, this.#opts.pageTimeoutMs);
  }

  #onMessage(slot: Slot, worker: OcrWorkerLike, msg: Record<string, unknown>): void {
    const busy = slot.busy;
    if (slot.worker !== worker || busy === undefined || msg['id'] !== busy.id) return;
    if (msg['type'] === 'progress') {
      clearTimeout(busy.timer);
      busy.timer = this.#armTimeout(slot);
      return;
    }
    clearTimeout(busy.timer);
    slot.busy = undefined;
    this.#idle(slot);
    if (msg['type'] === 'done') {
      void this.#finish(busy.task, msg['result'] as OcrWorkerResult).then(
        busy.task.resolve,
        busy.task.reject,
      );
    } else {
      busy.task.reject(
        new OcrError('failed', typeof msg['message'] === 'string' ? msg['message'] : 'OCR failed'),
      );
    }
    this.#pump();
  }

  #onCrash(slot: Slot, worker: OcrWorkerLike, err: Error): void {
    if (slot.worker !== worker) return;
    void this.#retire(slot, new OcrError('worker', err.message)).then(() => this.#pump());
  }

  /** Terminates the slot's worker, rejecting its current task with `reason`. */
  async #retire(slot: Slot, reason: OcrError): Promise<void> {
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const busy = slot.busy;
    slot.busy = undefined;
    if (busy !== undefined) {
      clearTimeout(busy.timer);
      busy.task.reject(reason);
    }
    const worker = slot.worker;
    slot.worker = undefined;
    if (worker !== undefined) await Promise.resolve(worker.terminate()).catch(() => undefined);
  }

  #idle(slot: Slot): void {
    if (this.#opts.idleTimeoutMs <= 0 || this.#queue.length > 0) return;
    slot.idleTimer = setTimeout(() => {
      if (slot.busy === undefined) void this.#retire(slot, new OcrError('closed', 'idle'));
    }, this.#opts.idleTimeoutMs);
    slot.idleTimer.unref?.();
  }

  /** Builds the result, re-reading the returned low-confidence pages with the vision model. */
  async #finish(task: Pending, raw: OcrWorkerResult): Promise<OcrResult> {
    const errors = [...raw.errors];
    let escalated = 0;
    const pages: { entry: OcrWorkerPage; source: OcrPage['source'] }[] = raw.pages.map((p) => ({
      entry: p,
      source: p.source,
    }));
    const recognize = this.#opts.escalate?.recognize;
    if (recognize !== undefined) {
      for (const p of pages) {
        if (p.entry.png === undefined) continue;
        try {
          const r = await recognize(p.entry.png, task.languages);
          const text = r.text.trim();
          if (text.length > 0) {
            p.entry = { ...p.entry, text };
            p.source = 'vision';
            escalated++;
          }
        } catch (err) {
          errors.push(
            `page ${p.entry.page} (vision): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    const confidences = raw.pages.flatMap((p) =>
      p.confidence !== undefined ? [p.confidence] : [],
    );
    return {
      text: pages
        .map((p) => p.entry.text)
        .filter((t) => t.length > 0)
        .join('\n\n'),
      pages: pages.map((p) => ({
        page: p.entry.page,
        source: p.source,
        chars: p.entry.text.replace(/\s+/g, ' ').trim().length,
        ...(p.entry.confidence !== undefined && { confidence: Math.round(p.entry.confidence) }),
      })),
      ocrPages: raw.ocrPages,
      escalatedPages: escalated,
      skippedPages: raw.skippedPages,
      ...(confidences.length > 0 && {
        avgConfidence: Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length),
      }),
      ms: Date.now() - task.start,
      errors,
    };
  }
}
