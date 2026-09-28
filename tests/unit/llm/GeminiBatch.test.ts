import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GeminiProvider } from '../../../src/llm/gemini/GeminiProvider.js';
import type { GeminiClient } from '../../../src/llm/gemini/GeminiProvider.js';
import { UnsupportedCapabilityError } from '../../../src/errors/index.js';
import { documentFromBytes, text } from '../../../src/content/index.js';
import type { BatchRequestItem, LLMRequest } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeState {
  uploadedJsonl: string;
  resultLines: string[];
  job: Record<string, unknown>;
}

function makeClient(state: FakeState) {
  const upload = vi.fn().mockImplementation(async (params: { file: Blob }) => {
    state.uploadedJsonl = await params.file.text();
    return { name: 'files/input-1', uri: 'https://x/files/input-1' };
  });

  const client = {
    interactions: { create: vi.fn() },
    files: {
      upload,
      get: vi.fn(),
      delete: vi.fn(),
      // The provider downloads results to a temp path and streams the lines.
      download: vi.fn().mockImplementation(async (params: { downloadPath: string }) => {
        await writeFile(params.downloadPath, state.resultLines.join('\n'));
      }),
    },
    batches: {
      create: vi.fn().mockImplementation(() => Promise.resolve(state.job)),
      get: vi.fn().mockImplementation(() => Promise.resolve(state.job)),
      cancel: vi.fn().mockResolvedValue({}),
    },
    models: { list: vi.fn() },
  } as unknown as GeminiClient;

  return { client, upload };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    uploadedJsonl: '',
    resultLines: [],
    job: {
      name: 'batches/job-1',
      model: 'gemini-flash-latest',
      state: 'JOB_STATE_PENDING',
      createTime: '2026-03-01T10:00:00Z',
    },
    ...overrides,
  };
}

function makeItem(customId: string, overrides: Partial<LLMRequest> = {}): BatchRequestItem {
  return {
    customId,
    request: {
      model: 'gemini-flash-latest',
      systemPrompt: 'Extract data.',
      messages: [{ role: 'user', content: 'Hello' }],
      ...overrides,
    },
  };
}

function jsonlLines(state: FakeState): Array<{ key: string; request: Record<string, unknown> }> {
  return state.uploadedJsonl
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { key: string; request: Record<string, unknown> });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('submitBatch', () => {
  it('writes one JSONL line per request, keyed by customId', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.submitBatch([makeItem('doc-1'), makeItem('doc-2')]);

    const lines = jsonlLines(state);
    expect(lines.map((l) => l.key)).toEqual(['doc-1', 'doc-2']);
  });

  it('uses the file-based path so correlation ids survive a restart', async () => {
    const state = makeState();
    const { client, upload } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.submitBatch([makeItem('doc-1')]);

    expect(upload).toHaveBeenCalledOnce();
    expect((client.batches.create as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      src: 'files/input-1',
    });
  });

  it('maps content and structured output exactly as a synchronous call does', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);
    const schema = { type: 'object', properties: { total: { type: 'number' } } };

    await provider.submitBatch([
      makeItem('doc-1', {
        messages: [
          {
            role: 'user',
            content: [
              text('extract'),
              documentFromBytes(new Uint8Array([1, 2]), 'application/pdf'),
            ],
          },
        ],
        responseFormat: { type: 'json_schema', schema },
      }),
    ]);

    const [line] = jsonlLines(state);
    expect(line!.request).toMatchObject({
      systemInstruction: { parts: [{ text: 'Extract data.' }] },
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    });
    const contents = line!.request['contents'] as Array<{ parts: unknown[] }>;
    expect(contents[0]!.parts).toEqual([
      { text: 'extract' },
      { inlineData: { mimeType: 'application/pdf', data: Buffer.from([1, 2]).toString('base64') } },
    ]);
  });

  it('rejects an empty batch', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await expect(provider.submitBatch([])).rejects.toThrow(UnsupportedCapabilityError);
  });

  it('fails when a request has no model and no default is available', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await expect(
      provider.submitBatch(
        [{ customId: 'doc-1', request: makeItem('x').request }].map((i) => ({
          ...i,
          request: { ...i.request, model: '' },
        })),
      ),
    ).rejects.toThrow(/no model/);
  });

  it('refuses an option the batch surface cannot honour instead of dropping it', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await expect(
      provider.submitBatch([
        makeItem('doc-1', { providerOptions: { gemini: { serviceTier: 'flex' } } }),
      ]),
    ).rejects.toThrow(/only available on synchronous calls/);
  });

  it('accepts options both surfaces understand', async () => {
    const state = makeState();
    const { client } = makeClient(state);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.submitBatch([
      makeItem('doc-1', { providerOptions: { gemini: { thinkingLevel: 'low' } } }),
    ]);

    const [line] = jsonlLines(state);
    expect(line!.request['generationConfig']).toMatchObject({
      thinkingConfig: { thinkingLevel: 'low' },
    });
  });
});

describe('job lifecycle', () => {
  it.each([
    ['JOB_STATE_PENDING', 'queued'],
    ['JOB_STATE_RUNNING', 'running'],
    ['JOB_STATE_SUCCEEDED', 'completed'],
    ['JOB_STATE_FAILED', 'failed'],
    ['JOB_STATE_CANCELLED', 'cancelled'],
    ['JOB_STATE_EXPIRED', 'expired'],
  ])('normalises %s to %s', async (state, expected) => {
    const fake = makeState({
      job: { name: 'batches/j', state, createTime: '2026-03-01T10:00:00Z' },
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect((await provider.getBatch('batches/j')).status).toBe(expected);
  });

  it('returns a job id the application can persist and poll with', async () => {
    const fake = makeState();
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const job = await provider.submitBatch([makeItem('doc-1')]);

    expect(job.jobId).toBe('batches/job-1');
    expect(job.provider).toBe('gemini');
    expect(job.providerType).toBe('gemini');
    expect(job.createdAt).toEqual(new Date('2026-03-01T10:00:00Z'));
  });

  it('surfaces a job-level error message', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_FAILED', error: { message: 'bad input' } },
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect((await provider.getBatch('batches/j')).error).toBe('bad input');
  });

  it('cancels a running job', async () => {
    const fake = makeState();
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.cancelBatch('batches/job-1');

    expect(client.batches.cancel).toHaveBeenCalledWith({ name: 'batches/job-1' });
  });
});

describe('streamBatchResults', () => {
  function successLine(key: string, text: string, tokens = { prompt: 100, candidates: 10 }) {
    return JSON.stringify({
      key,
      response: {
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        modelVersion: 'gemini-flash-latest',
        usageMetadata: {
          promptTokenCount: tokens.prompt,
          candidatesTokenCount: tokens.candidates,
          thoughtsTokenCount: 5,
        },
      },
    });
  }

  it('yields results correlated by customId, not by position', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } },
      resultLines: [successLine('doc-2', '{"total":2}'), successLine('doc-1', '{"total":1}')],
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const seen: Array<[string, string]> = [];
    for await (const item of provider.streamBatchResults('batches/j')) {
      seen.push([item.customId, item.response?.content ?? '']);
    }

    expect(seen).toEqual([
      ['doc-2', '{"total":2}'],
      ['doc-1', '{"total":1}'],
    ]);
  });

  it('reports individual failures alongside successes in a completed job', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } },
      resultLines: [
        successLine('doc-1', 'ok'),
        JSON.stringify({ key: 'doc-2', error: { message: 'invalid document', code: 400 } }),
      ],
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const items = [];
    for await (const item of provider.streamBatchResults('batches/j')) items.push(item);

    expect(items[0]!.response).toBeDefined();
    expect(items[1]!.error).toEqual({ message: 'invalid document', code: '400' });
    expect(items[1]!.response).toBeUndefined();
  });

  it('prices batch results with the model batch rate, not a blanket discount', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } },
      resultLines: [successLine('doc-1', 'ok', { prompt: 1_000, candidates: 100 })],
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider(
      {
        apiKey: 'k',
        pricing: {
          'gemini-flash-latest': {
            input: 0.01,
            output: 0.02,
            batchInput: 0.001,
            batchOutput: 0.002,
          },
        },
      },
      client,
    );

    const [item] = await collect(provider.streamBatchResults('batches/j'));
    // 1000 input * 0.001/1k + 105 output (100 + 5 thinking) * 0.002/1k
    expect(item!.response?.usage.cost).toBeCloseTo(0.00121, 6);
    expect(item!.response?.executionMode).toBe('batch');
  });

  it('falls back to synchronous rates when a model declares no batch price', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } },
      resultLines: [successLine('doc-1', 'ok', { prompt: 1_000, candidates: 0 })],
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider(
      { apiKey: 'k', pricing: { 'gemini-flash-latest': { input: 0.01, output: 0.02 } } },
      client,
    );

    const [item] = await collect(provider.streamBatchResults('batches/j'));
    // 1000 * 0.01/1k + 5 thinking tokens * 0.02/1k
    expect(item!.response?.usage.cost).toBeCloseTo(0.0101, 6);
  });

  it('yields nothing when the job has produced no result file yet', async () => {
    const fake = makeState({ job: { name: 'batches/j', state: 'JOB_STATE_RUNNING' } });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect(await collect(provider.streamBatchResults('batches/j'))).toEqual([]);
  });

  it('skips malformed lines rather than failing the whole job', async () => {
    const fake = makeState({
      job: { name: 'batches/j', state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/out' } },
      resultLines: ['{not json', successLine('doc-1', 'ok')],
    });
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const items = await collect(provider.streamBatchResults('batches/j'));
    expect(items.map((i) => i.customId)).toEqual(['doc-1']);
  });
});

describe('files API', () => {
  it('uploads bytes and returns an expiring, provider-scoped reference', async () => {
    const fake = makeState();
    const { client } = makeClient(fake);
    (client.files.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'files/abc',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
      mimeType: 'application/pdf',
      sizeBytes: '1013',
      expirationTime: '2026-03-03T10:00:00Z',
    });
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const ref = await provider.uploadFile({
      content: { kind: 'bytes', bytes: new Uint8Array([1]) },
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    });

    expect(ref).toEqual({
      fileId: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
      provider: 'gemini',
      providerType: 'gemini',
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      byteLength: 1013,
      expiresAt: new Date('2026-03-03T10:00:00Z'),
    });
  });

  it('reads a file from disk and infers its media type', async () => {
    const fake = makeState();
    const { client } = makeClient(fake);
    (client.files.upload as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'files/abc' });
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.uploadFile({
      content: { kind: 'path', path: join(process.cwd(), 'tests/fixtures/media/invoice.pdf') },
    });

    const params = (client.files.upload as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      config: { mimeType: string };
    };
    expect(params.config.mimeType).toBe('application/pdf');
  });

  it('accepts either the resource name or the full URI when deleting', async () => {
    const fake = makeState();
    const { client } = makeClient(fake);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await provider.deleteFile('https://generativelanguage.googleapis.com/v1beta/files/abc');

    expect(client.files.delete).toHaveBeenCalledWith({ name: 'files/abc' });
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
