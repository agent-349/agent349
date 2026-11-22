/**
 * OcrService orchestration with a fake worker: on-demand workers, idle
 * shutdown, page timeout (terminate + recovery), queueing, escalation to a
 * vision model and errors. The real Tesseract path is exercised against real
 * documents outside the unit suite (it needs language data).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { OcrService, OcrError } from '../../../src/rag/ocr/OcrService.js';
import type { OcrWorkerLike } from '../../../src/rag/ocr/OcrService.js';
import { PDFLoader } from '../../../src/rag/ingestion/loaders/PDFLoader.js';
import { ImageLoader } from '../../../src/rag/ingestion/loaders/ImageLoader.js';
import { createVisionRecognizer } from '../../../src/rag/ocr/visionRecognizer.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';

type Behaviour = (
  msg: { type: string; id: number; options: Record<string, unknown> },
  w: FakeWorker,
) => void;

class FakeWorker extends EventEmitter implements OcrWorkerLike {
  terminated = false;
  readonly received: { type: string; id: number; options: Record<string, unknown> }[] = [];
  constructor(private readonly behaviour: Behaviour) {
    super();
  }
  postMessage(message: unknown): void {
    const msg = message as { type: string; id: number; options: Record<string, unknown> };
    this.received.push(msg);
    queueMicrotask(() => this.behaviour(msg, this));
  }
  reply(msg: unknown): void {
    this.emit('message', msg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const done = (id: number, pages: object[], extra: object = {}) => ({
  type: 'done',
  id,
  result: {
    pages,
    ocrPages: pages.filter((p) => (p as { source: string }).source === 'ocr').length,
    skippedPages: 0,
    errors: [],
    ...extra,
  },
});

function serviceWith(
  behaviour: Behaviour,
  options: ConstructorParameters<typeof OcrService>[0] = {},
) {
  const workers: FakeWorker[] = [];
  const service = new OcrService({
    languages: ['spa'],
    langPath: '/data/tessdata',
    ...options,
    workerFactory: () => {
      const w = new FakeWorker(behaviour);
      workers.push(w);
      return w;
    },
  });
  return { service, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OcrService', () => {
  it('merges text-layer and OCR pages in order and reports confidence', async () => {
    const { service, workers } = serviceWith((msg, w) =>
      w.reply(
        done(msg.id, [
          { page: 1, source: 'text', text: 'Página con texto' },
          { page: 2, source: 'ocr', text: 'Texto escaneado', confidence: 90 },
          { page: 3, source: 'ocr', text: 'Otra página', confidence: 80 },
        ]),
      ),
    );
    const r = await service.extractPdf(new Uint8Array([1, 2, 3]));
    expect(r.text).toBe('Página con texto\n\nTexto escaneado\n\nOtra página');
    expect(r.pages.map((p) => p.source)).toEqual(['text', 'ocr', 'ocr']);
    expect(r.ocrPages).toBe(2);
    expect(r.avgConfidence).toBe(85);
    expect(workers[0]!.received[0]!.options).toMatchObject({
      languages: ['spa'],
      langPath: '/data/tessdata',
      minChars: 80,
      allowDownload: false,
    });
    await service.close();
  });

  it('creates the worker on demand and terminates it after the idle time', async () => {
    vi.useFakeTimers();
    const { service, workers } = serviceWith((msg, w) => w.reply(done(msg.id, [])), {
      idleTimeoutMs: 1000,
    });
    expect(service.activeWorkers).toBe(0);
    await service.extractImage(new Uint8Array([1]));
    expect(service.activeWorkers).toBe(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(service.activeWorkers).toBe(0);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('terminates a worker stuck on a page, rejects the file and recovers with a new worker', async () => {
    vi.useFakeTimers();
    let call = 0;
    const { service, workers } = serviceWith(
      (msg, w) => {
        call++;
        if (call === 1) return; // hangs
        w.reply(done(msg.id, [{ page: 1, source: 'ocr', text: 'ok', confidence: 90 }]));
      },
      { pageTimeoutMs: 500 },
    );
    const first = service.extractPdf(new Uint8Array([1]));
    const firstOutcome = first.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(501);
    const err = await firstOutcome;
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).code).toBe('timeout');
    expect(workers[0]!.terminated).toBe(true);
    const second = await service.extractPdf(new Uint8Array([2]));
    expect(second.text).toBe('ok');
    expect(workers).toHaveLength(2);
    await service.close();
  });

  it('progress messages keep a long file alive', async () => {
    vi.useFakeTimers();
    const { service } = serviceWith(
      (msg, w) => {
        let page = 0;
        const tick = (): void => {
          page++;
          if (page <= 3) {
            w.reply({ type: 'progress', id: msg.id, page });
            setTimeout(tick, 400);
          } else w.reply(done(msg.id, []));
        };
        tick();
      },
      { pageTimeoutMs: 500 },
    );
    const p = service.extractPdf(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ ocrPages: 0 });
    await service.close();
  });

  it('queues files beyond the concurrency and runs them one by one', async () => {
    const order: number[] = [];
    const { service, workers } = serviceWith((msg, w) => {
      order.push(msg.id);
      setTimeout(() => w.reply(done(msg.id, [])), 5);
    });
    const all = Promise.all([1, 2, 3].map((n) => service.extractPdf(new Uint8Array([n]))));
    expect(service.queued).toBe(2);
    await all;
    expect(order).toEqual([1, 2, 3]);
    expect(workers).toHaveLength(1);
    await service.close();
  });

  it('re-reads low-confidence pages with the vision model', async () => {
    const recognize = vi.fn(async () => ({ text: 'Texto corregido por visión' }));
    const { service, workers } = serviceWith(
      (msg, w) =>
        w.reply(
          done(msg.id, [
            {
              page: 1,
              source: 'ocr',
              text: 'T3xt0 r0t0',
              confidence: 40,
              png: new Uint8Array([9]),
            },
            { page: 2, source: 'ocr', text: 'Bien', confidence: 95 },
          ]),
        ),
      { escalate: { belowConfidence: 60, maxPagesPerFile: 5, recognize } },
    );
    const r = await service.extractPdf(new Uint8Array([1]));
    expect(workers[0]!.received[0]!.options).toMatchObject({ escalateBelow: 60, escalateMax: 5 });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(r.escalatedPages).toBe(1);
    expect(r.pages[0]!.source).toBe('vision');
    expect(r.text).toBe('Texto corregido por visión\n\nBien');
    await service.close();
  });

  it('a failing vision call keeps the Tesseract text and reports it', async () => {
    const { service } = serviceWith(
      (msg, w) =>
        w.reply(
          done(msg.id, [
            { page: 1, source: 'ocr', text: 'T3xt0', confidence: 40, png: new Uint8Array([9]) },
          ]),
        ),
      { escalate: { recognize: async () => Promise.reject(new Error('quota')) } },
    );
    const r = await service.extractPdf(new Uint8Array([1]));
    expect(r.text).toBe('T3xt0');
    expect(r.errors[0]).toContain('quota');
    await service.close();
  });

  it('rejects with the worker error and on a crash, and after close', async () => {
    const { service } = serviceWith((msg, w) =>
      w.reply({
        type: 'error',
        id: msg.id,
        message: 'OCR language data not found: fra.traineddata',
      }),
    );
    await expect(service.extractPdf(new Uint8Array([1]))).rejects.toThrow(/fra.traineddata/);
    const crash = serviceWith((_msg, w) => w.emit('error', new Error('boom')));
    await expect(crash.service.extractPdf(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'worker',
    });
    await service.close();
    await expect(service.extractPdf(new Uint8Array([1]))).rejects.toMatchObject({ code: 'closed' });
  });

  it('maps ISO languages to Tesseract codes', () => {
    expect(OcrService.tesseractLanguage('es-UY')).toBe('spa');
    expect(OcrService.tesseractLanguage('zh')).toBe('chi_sim');
    expect(OcrService.tesseractLanguage('xx')).toBeUndefined();
  });
});

describe('loaders with OCR', () => {
  const fakeOcr = (text: string, ocrPages = 1) =>
    ({
      extractPdf: vi.fn(async () => ({
        text,
        pages: [{ page: 1, source: 'ocr', chars: text.length }],
        ocrPages,
        escalatedPages: 0,
        skippedPages: 0,
        avgConfidence: 91,
        ms: 1,
        errors: [],
      })),
      extractImage: vi.fn(async () => ({
        text,
        pages: [{ page: 1, source: 'ocr', chars: text.length }],
        ocrPages: 1,
        escalatedPages: 0,
        skippedPages: 0,
        avgConfidence: 88,
        ms: 1,
        errors: [],
      })),
    }) as unknown as OcrService;

  it('PDFLoader uses OCR with the document language and records it', async () => {
    const ocr = fakeOcr('Texto del escaneo');
    const doc = await new PDFLoader(ocr).load({
      type: 'buffer',
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      metadata: { language: 'es' },
    });
    expect(doc.content).toBe('Texto del escaneo');
    expect(doc.extractionMethod).toBe('pdf+ocr');
    expect(doc.metadata.custom).toMatchObject({ ocr: { pages: 1, avgConfidence: 91 } });
    expect((ocr.extractPdf as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({
      languages: ['spa'],
    });
  });

  it('ImageLoader recognises images', async () => {
    const loader = new ImageLoader(fakeOcr('Factura 123'));
    expect(loader.canLoad({ type: 'buffer', mimeType: 'image/png' } as never)).toBe(true);
    const doc = await loader.load({
      type: 'buffer',
      buffer: Buffer.from([1]),
      mimeType: 'image/png',
    });
    expect(doc.content).toBe('Factura 123');
  });
});

describe('createVisionRecognizer', () => {
  it('sends the page as an image block and reports usage', async () => {
    const call = vi.fn(async () => ({
      content: 'texto',
      usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
    }));
    const onUsage = vi.fn();
    const recognize = createVisionRecognizer(
      { call } as unknown as LLMRouter,
      'openai',
      'gpt-6.1-terra',
      { onUsage },
    );
    expect(await recognize(new Uint8Array([1, 2]), ['spa'])).toEqual({ text: 'texto' });
    const req = call.mock.calls[0]![0] as {
      messages: { content: { type: string; source?: { mimeType: string } }[] }[];
    };
    expect(req.messages[0]!.content[1]).toMatchObject({
      type: 'image',
      source: { mimeType: 'image/png' },
    });
    expect(onUsage).toHaveBeenCalledWith(
      { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
      'gpt-6.1-terra',
    );
  });
});
