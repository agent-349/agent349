/**
 * Integration tests: GeminiProvider against the real Google API.
 *
 * Skipped automatically when GEMINI_API_KEY is not set, so `npm run test:int`
 * stays green without credentials.
 *
 * To run:
 *   GEMINI_API_KEY=... npm run test:int
 *
 * Optional:
 *   GEMINI_TEST_MODEL=gemini-flash-latest   model under test
 *   AGENT349_TEST_DOCS_DIR=/path/to/docs  extra real documents to extract from
 *   GEMINI_TEST_BATCH=1                     also exercise a (slow) batch job
 */
import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { GeminiProvider } from '../../src/llm/gemini/GeminiProvider.js';
import { Orchestrator } from '../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../src/config/ConfigLoader.js';
import {
  documentFromPath,
  fromProviderFile,
  imageFromPath,
  text,
} from '../../src/content/index.js';
import { validateAgainstSchema } from '../../src/llm/structured.js';
import type { ExecutionContext, LLMRequest } from '../../src/types/index.js';

const API_KEY = process.env['GEMINI_API_KEY'] ?? '';
const MODEL = process.env['GEMINI_TEST_MODEL'] ?? 'gemini-flash-latest';
const DOCS_DIR = process.env['AGENT349_TEST_DOCS_DIR'];
const RUN_BATCH = process.env['GEMINI_TEST_BATCH'] === '1';

const FIXTURES = join(process.cwd(), 'tests/fixtures/media');
const INVOICE_PDF = join(FIXTURES, 'invoice.pdf');
const PIXEL_PNG = join(FIXTURES, 'pixel.png');

/**
 * The schema lives in the test, not in the SDK: extracting invoices is what
 * this scenario validates, not something Agent349 knows about.
 */
const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    invoiceNumber: { type: 'string' },
    issueDate: { type: 'string' },
    currency: { type: 'string' },
    total: { type: 'number' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          quantity: { type: 'number' },
          unitPrice: { type: 'number' },
        },
        required: ['description'],
      },
    },
  },
  required: ['invoiceNumber', 'total', 'currency'],
};

function provider(): GeminiProvider {
  return new GeminiProvider({ apiKey: API_KEY, defaultModel: MODEL });
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: MODEL,
    systemPrompt: 'You extract structured data from documents. Answer with JSON only.',
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    temperature: 0,
    ...overrides,
  };
}

function context(): ExecutionContext {
  return {
    tenantId: 'it-tenant',
    userId: 'it-user',
    roles: ['user'],
    sessionId: 'it-session',
    agentId: 'it-agent',
    requestId: 'it-request',
  };
}

describe.skipIf(API_KEY === '')('GeminiProvider — live API', () => {
  it('answers a plain text prompt and reports usage', async () => {
    const response = await provider().call(request());

    expect(response.content.toLowerCase()).toContain('ready');
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBe(
      response.usage.inputTokens + response.usage.outputTokens,
    );
    expect(response.providerType).toBe('gemini');
    expect(response.executionMode).toBe('sync');
  }, 60_000);

  it('validates the API key', async () => {
    expect(await provider().validate()).toEqual({ ok: true });
  }, 60_000);

  it('lists real models', async () => {
    const models = await provider().listModels();
    expect(models.some((m) => m.startsWith('gemini'))).toBe(true);
  }, 60_000);

  it('streams text deltas', async () => {
    const deltas: string[] = [];
    const response = await provider().call(
      request({
        messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }],
        onToken: (delta) => deltas.push(delta),
      }),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(response.content).toBe(deltas.join(''));
  }, 60_000);

  it('reads an image', async () => {
    const response = await provider().call(
      request({
        messages: [
          {
            role: 'user',
            content: [text('What colour is this image? One word.'), imageFromPath(PIXEL_PNG)],
          },
        ],
      }),
    );

    expect(response.content.toLowerCase()).toContain('red');
    expect(response.usage.inputByModality?.some((m) => m.modality === 'image')).toBe(true);
  }, 60_000);

  it('reports a token breakdown by modality', async () => {
    const response = await provider().call(
      request({
        messages: [{ role: 'user', content: [text('Summarise'), documentFromPath(INVOICE_PDF)] }],
      }),
    );

    const modalities = response.usage.inputByModality?.map((m) => m.modality) ?? [];
    expect(modalities.length).toBeGreaterThan(0);
  }, 60_000);

  it('calls a tool and round-trips the result statelessly', async () => {
    const gemini = provider();
    const tools = [
      {
        name: 'get_balance',
        description: 'Returns the balance of an account',
        inputSchema: {
          type: 'object',
          properties: { account: { type: 'string' } },
          required: ['account'],
        },
      },
    ];

    const first = await gemini.call(
      request({
        systemPrompt: 'Use the provided tools when asked about accounts.',
        messages: [{ role: 'user', content: 'What is the balance of account 1001?' }],
        tools,
      }),
    );

    expect(first.stopReason).toBe('tool_use');
    const call = first.toolCalls![0]!;
    expect(call.toolName).toBe('get_balance');

    // The second turn replays the assistant blocks (including Gemini's thought
    // signatures) plus the tool result — the stateless multi-turn contract.
    const second = await gemini.call(
      request({
        systemPrompt: 'Use the provided tools when asked about accounts.',
        messages: [
          { role: 'user', content: 'What is the balance of account 1001?' },
          { role: 'assistant', content: first.contentBlocks! },
          {
            role: 'tool',
            toolCallId: call.id,
            name: call.toolName,
            content: '{"balance": 4210.55, "currency": "UYU"}',
          },
        ],
        tools,
      }),
    );

    expect(second.stopReason).toBe('end');
    // The model formats the number as it sees fit ("4,210.55", "4.210,55"),
    // so compare on digits alone.
    expect(second.content.replace(/[^0-9]/g, '')).toContain('421055');
  }, 120_000);

  it('surfaces an authentication failure as a ProviderError', async () => {
    const bad = new GeminiProvider({ apiKey: 'not-a-real-key', defaultModel: MODEL });

    await expect(bad.call(request())).rejects.toMatchObject({ name: 'ProviderError' });
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// The functional scenario: document → Agent349 → Gemini → structured JSON
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(API_KEY === '')('invoice → JSON extraction', () => {
  it('extracts an invoice PDF into JSON matching the caller schema', async () => {
    const response = await provider().call(
      request({
        messages: [
          {
            role: 'user',
            content: [text('Extract the invoice data.'), documentFromPath(INVOICE_PDF)],
          },
        ],
        responseFormat: {
          type: 'json_schema',
          name: 'invoice',
          schema: INVOICE_SCHEMA,
          validate: true,
        },
      }),
    );

    expect(response.structured).toMatchObject({
      mode: 'native_schema',
      parsed: true,
      validation: 'valid',
    });

    const invoice = response.structured!.value as {
      invoiceNumber: string;
      total: number;
      currency: string;
    };
    expect(invoice.invoiceNumber).toBe('INV-2026-0042');
    expect(invoice.total).toBeCloseTo(302.5, 2);
    expect(invoice.currency).toBe('EUR');
  }, 120_000);

  it('extracts the same invoice through the governed Orchestrator path', async () => {
    const config = ConfigLoader.from({
      llm: {
        defaultProvider: 'gemini',
        defaultModel: MODEL,
        providers: { gemini: { type: 'gemini', apiKey: API_KEY, defaultModel: MODEL } },
      },
    }).get();
    const orchestrator = await Orchestrator.fromConfig(config);

    try {
      const response = await orchestrator.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [text('Extract the invoice data.'), documentFromPath(INVOICE_PDF)],
            },
          ],
          responseFormat: { type: 'json_schema', schema: INVOICE_SCHEMA, validate: true },
        }),
        context(),
      );

      expect(response.structured?.validation).toBe('valid');

      // Usage reached the metrics plane with tenant attribution.
      const usage = await orchestrator.tokens.getByTenant('it-tenant', {
        from: new Date(Date.now() - 300_000),
        to: new Date(Date.now() + 300_000),
      });
      expect(usage.totalInputTokens).toBeGreaterThan(0);
    } finally {
      await orchestrator.shutdown();
    }
  }, 120_000);

  it('uploads, reads back and deletes a file', async () => {
    // Kept separate from the generation tests: the Files API has its own quota,
    // so this still verifies the file lifecycle when generation is throttled.
    const gemini = provider();
    const ref = await gemini.uploadFile({
      content: { kind: 'path', path: INVOICE_PDF },
      fileName: 'invoice.pdf',
    });

    expect(ref.providerType).toBe('gemini');
    expect(ref.mimeType).toBe('application/pdf');
    expect(ref.byteLength).toBeGreaterThan(0);
    expect(ref.expiresAt).toBeInstanceOf(Date);
    expect(ref.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const fetched = await gemini.getFile(ref.fileId);
    expect(fetched.fileId).toBe(ref.fileId);

    await gemini.deleteFile(ref.fileId);
  }, 120_000);

  it('uploads a document once and reuses the reference', async () => {
    const gemini = provider();
    const ref = await gemini.uploadFile({
      content: { kind: 'path', path: INVOICE_PDF },
      fileName: 'invoice.pdf',
    });

    try {
      expect(ref.providerType).toBe('gemini');
      expect(ref.expiresAt).toBeInstanceOf(Date);

      const response = await gemini.call(
        request({
          messages: [
            { role: 'user', content: [text('What is the invoice number?'), fromProviderFile(ref)] },
          ],
        }),
      );

      expect(response.content).toContain('INV-2026-0042');
    } finally {
      await gemini.deleteFile(ref.fileId);
    }
  }, 120_000);

  it("uploads automatically under fileHandling 'upload' and reports the reference", async () => {
    const gemini = provider();
    const response = await gemini.call(
      request({
        messages: [
          {
            role: 'user',
            content: [text('What is the invoice number?'), documentFromPath(INVOICE_PDF)],
          },
        ],
        fileHandling: 'upload',
      }),
    );

    expect(response.uploadedFiles).toHaveLength(1);
    expect(response.content).toContain('INV-2026-0042');

    for (const ref of response.uploadedFiles ?? []) {
      await gemini.deleteFile(ref.fileId);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional: real documents supplied by the operator
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(API_KEY === '' || DOCS_DIR === undefined)('real documents', () => {
  it('extracts structured data from every document in the directory', async () => {
    const entries = (await readdir(DOCS_DIR!)).filter((name) =>
      ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(name).toLowerCase()),
    );
    expect(entries.length).toBeGreaterThan(0);

    const gemini = provider();
    for (const name of entries.slice(0, 3)) {
      const path = join(DOCS_DIR!, name);
      const block =
        extname(name).toLowerCase() === '.pdf' ? documentFromPath(path) : imageFromPath(path);

      const response = await gemini.call(
        request({
          messages: [{ role: 'user', content: [text('Extract the invoice data.'), block] }],
          responseFormat: { type: 'json_schema', schema: INVOICE_SCHEMA },
        }),
      );

      expect(response.structured?.parsed, `${name} produced unparseable output`).toBe(true);
      expect(validateAgainstSchema(response.structured!.value, INVOICE_SCHEMA)).toEqual([]);
    }
  }, 300_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional: batch (slow — a job can take minutes to hours)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(API_KEY === '' || !RUN_BATCH)('batch processing', () => {
  it('submits a job, polls it, and correlates results by customId', async () => {
    const gemini = provider();
    const job = await gemini.submitBatch(
      [
        {
          customId: 'invoice-1',
          request: request({
            messages: [
              {
                role: 'user',
                content: [text('Extract the invoice data.'), documentFromPath(INVOICE_PDF)],
              },
            ],
            responseFormat: { type: 'json_schema', schema: INVOICE_SCHEMA },
          }),
        },
      ],
      { displayName: 'agent349-integration' },
    );

    expect(job.jobId).not.toBe('');
    expect(['queued', 'running']).toContain(job.status);

    // Polling cadence belongs to the application: the SDK runs no timers.
    let current = job;
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && current.status !== 'completed' && current.status !== 'failed') {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      current = await gemini.getBatch(job.jobId);
    }

    expect(current.status).toBe('completed');

    const byId = new Map<string, unknown>();
    for await (const item of gemini.streamBatchResults(job.jobId)) {
      byId.set(item.customId, item.response?.content ?? item.error);
    }

    expect(byId.has('invoice-1')).toBe(true);
    expect(String(byId.get('invoice-1'))).toContain('INV-2026-0042');
  }, 1_000_000);
});
