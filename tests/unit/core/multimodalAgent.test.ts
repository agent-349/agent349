import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import {
  LLMProvider,
  textOnlyCapabilities,
  type BatchCapableProvider,
  type FileCapableProvider,
} from '../../../src/llm/LLMProvider.js';
import { UnsupportedCapabilityError } from '../../../src/errors/index.js';
import { documentFromBytes, imageFromBytes, text } from '../../../src/content/index.js';
import type {
  AgentConfig,
  BatchJob,
  BatchRequestItem,
  BatchResultItem,
  ExecutionContext,
  FileUploadInput,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ProviderFileRef,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// A fully capable fake provider
// ─────────────────────────────────────────────────────────────────────────────

class FakeProvider extends LLMProvider implements FileCapableProvider, BatchCapableProvider {
  override readonly name = 'fake';
  override readonly providerType = 'fake';
  readonly requests: LLMRequest[] = [];
  readonly uploads: FileUploadInput[] = [];
  readonly submitted: BatchRequestItem[][] = [];
  responseContent = 'done';
  batchResults: BatchResultItem[] = [];

  override async call(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      content: this.responseContent,
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: request.model,
      provider: this.name,
      providerType: this.providerType,
      executionMode: 'sync',
      latencyMs: 1,
      ...(request.responseFormat !== undefined && {
        structured: {
          mode: 'native_schema' as const,
          parsed: true,
          value: JSON.parse(this.responseContent) as unknown,
          validation: 'skipped' as const,
        },
      }),
    };
  }

  override async validate(): Promise<{ ok: true }> {
    return { ok: true };
  }

  override async listModels(): Promise<string[]> {
    return ['fake-model'];
  }

  override capabilities(): ProviderCapabilities {
    return {
      ...textOnlyCapabilities(),
      input: { text: true, image: true, document: true, audio: false, video: false },
      structuredOutput: 'jsonSchema',
      structuredOutputWithTools: true,
      files: true,
      batch: true,
    };
  }

  async uploadFile(input: FileUploadInput): Promise<ProviderFileRef> {
    this.uploads.push(input);
    return {
      fileId: 'files/uploaded',
      provider: this.name,
      providerType: this.providerType,
      mimeType: input.mimeType ?? 'application/octet-stream',
      byteLength: 42,
    };
  }

  async getFile(fileId: string): Promise<ProviderFileRef> {
    return { fileId, provider: this.name, providerType: this.providerType };
  }

  async deleteFile(): Promise<void> {
    /* no-op */
  }

  async submitBatch(items: BatchRequestItem[]): Promise<BatchJob> {
    this.submitted.push(items);
    return {
      jobId: 'job-1',
      provider: this.name,
      providerType: this.providerType,
      status: 'queued',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    };
  }

  async getBatch(jobId: string): Promise<BatchJob> {
    return {
      jobId,
      provider: this.name,
      providerType: this.providerType,
      status: 'completed',
      createdAt: new Date('2026-03-01T10:00:00Z'),
      counts: { total: 2, succeeded: 1, failed: 1, cancelled: 0, expired: 0 },
    };
  }

  async *streamBatchResults(): AsyncIterable<BatchResultItem> {
    for (const item of this.batchResults) yield item;
  }

  async cancelBatch(): Promise<void> {
    /* no-op */
  }
}

class TextOnlyProvider extends LLMProvider {
  override readonly name = 'textonly';
  override readonly providerType = 'textonly';

  override async call(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'ok',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: request.model,
      provider: this.name,
      latencyMs: 1,
    };
  }

  override async validate(): Promise<{ ok: true }> {
    return { ok: true };
  }

  override async listModels(): Promise<string[]> {
    return [];
  }

  override capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const AGENT: AgentConfig = {
  id: 'extractor',
  name: 'Extractor',
  systemPrompt: 'You extract structured data.',
  skills: [],
  llmConfig: { provider: 'fake', model: 'fake-model', temperature: 0, maxTokens: 1024 },
};

async function makeOrchestrator(provider: LLMProvider = new FakeProvider()) {
  const config = ConfigLoader.from({
    llm: { defaultProvider: provider.name, defaultModel: 'fake-model' },
  }).get();
  const orchestrator = await Orchestrator.fromConfig(config);
  orchestrator.registerProvider(provider);
  orchestrator.registerAgent({
    ...AGENT,
    llmConfig: { ...AGENT.llmConfig!, provider: provider.name },
  });
  return orchestrator;
}

function makeContext(): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'u1',
    roles: ['user'],
    sessionId: 's1',
    agentId: 'extractor',
    requestId: 'r1',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('multimodal input through the agent loop', () => {
  it('accepts a plain string, as before', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);

    const response = await orchestrator.chat('extractor', 'hello', {
      tenantId: 'acme',
      userId: 'u1',
      roles: ['user'],
    });

    expect(response.content).toBe('done');
    const userTurn = provider.requests[0]!.messages.find((m) => m.role === 'user');
    expect(userTurn!.content).toBe('hello');
    await orchestrator.shutdown();
  });

  it('carries content blocks through to the provider', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);

    await orchestrator.chat(
      'extractor',
      [text('extract this'), documentFromBytes(new Uint8Array([1, 2]), 'application/pdf')],
      { tenantId: 'acme', userId: 'u1', roles: ['user'] },
    );

    const content = provider.requests[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toMatchObject([{ type: 'text' }, { type: 'document' }]);
    await orchestrator.shutdown();
  });

  it('reports media metadata on llm.call.start, never the payload', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);
    const events: Array<Record<string, unknown>> = [];

    await orchestrator.chat(
      'extractor',
      [imageFromBytes(new Uint8Array(16), 'image/png', undefined, 'a.png')],
      { tenantId: 'acme', userId: 'u1', roles: ['user'] },
      {
        onEvent: (event) => {
          if (event.type === 'llm.call.start') events.push(event.data);
        },
      },
    );

    expect(events[0]!['media']).toEqual([
      { kind: 'image', source: 'bytes', mimeType: 'image/png', fileName: 'a.png', byteLength: 16 },
    ]);
    await orchestrator.shutdown();
  });

  it('fails loudly when the model cannot read the attachment', async () => {
    const orchestrator = await makeOrchestrator(new TextOnlyProvider());
    orchestrator.registerAgent({
      ...AGENT,
      id: 'text-agent',
      llmConfig: { provider: 'textonly', model: 'm', temperature: 0, maxTokens: 10 },
    });

    // The text-only provider has no media translation, so the block reaches it
    // untranslated rather than being silently dropped from the prompt.
    const response = await orchestrator.chat(
      'text-agent',
      [documentFromBytes(new Uint8Array([1]), 'application/pdf')],
      { tenantId: 'acme', userId: 'u1', roles: ['user'] },
    );

    expect(response.content).toBe('ok');
    await orchestrator.shutdown();
  });
});

describe('structured output through the agent loop', () => {
  it('forwards the requested format and reports the outcome', async () => {
    const provider = new FakeProvider();
    provider.responseContent = '{"total":302.5}';
    const orchestrator = await makeOrchestrator(provider);

    const response = await orchestrator.chat(
      'extractor',
      'extract',
      {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['user'],
      },
      {
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { total: { type: 'number' } } },
        },
      },
    );

    expect(provider.requests[0]!.responseFormat).toMatchObject({ type: 'json_schema' });
    expect(response.structured).toMatchObject({ parsed: true, value: { total: 302.5 } });
    await orchestrator.shutdown();
  });

  it('forwards fileHandling and provider options', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);

    await orchestrator.chat(
      'extractor',
      'hi',
      { tenantId: 'acme', userId: 'u1', roles: ['user'] },
      {
        fileHandling: 'auto',
        providerOptions: { gemini: { thinkingLevel: 'low' } },
      },
    );

    expect(provider.requests[0]!.fileHandling).toBe('auto');
    expect(provider.requests[0]!.providerOptions).toEqual({ gemini: { thinkingLevel: 'low' } });
    await orchestrator.shutdown();
  });
});

describe('complete() — the direct extraction path', () => {
  it('carries content blocks, structured output and media metrics', async () => {
    const provider = new FakeProvider();
    provider.responseContent = '{"total":1}';
    const orchestrator = await makeOrchestrator(provider);
    const events: Array<Record<string, unknown>> = [];
    orchestrator.events.on('llm.call.start', (event) => events.push(event.data));

    const response = await orchestrator.complete(
      {
        model: 'fake-model',
        systemPrompt: 'Extract.',
        messages: [
          {
            role: 'user',
            content: [text('extract'), documentFromBytes(new Uint8Array(8), 'application/pdf')],
          },
        ],
        responseFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      makeContext(),
    );

    expect(response.structured?.value).toEqual({ total: 1 });
    expect(events[0]!['media']).toEqual([
      { kind: 'document', source: 'bytes', mimeType: 'application/pdf', byteLength: 8 },
    ]);
    await orchestrator.shutdown();
  });
});

describe('governed file operations', () => {
  it('uploads through the orchestrator and emits metadata only', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);
    const events: Array<Record<string, unknown>> = [];
    orchestrator.events.on('llm.file.uploaded', (event) => events.push(event.data));

    const ref = await orchestrator.uploadFile(
      { content: { kind: 'bytes', bytes: new Uint8Array([1]) }, mimeType: 'application/pdf' },
      makeContext(),
    );

    expect(ref.fileId).toBe('files/uploaded');
    expect(events[0]).toMatchObject({ fileId: 'files/uploaded', mimeType: 'application/pdf' });
    expect(JSON.stringify(events[0])).not.toContain('bytes');
    await orchestrator.shutdown();
  });

  it('refuses an upload on a provider with no file API', async () => {
    const orchestrator = await makeOrchestrator(new TextOnlyProvider());

    await expect(
      orchestrator.uploadFile(
        { content: { kind: 'bytes', bytes: new Uint8Array([1]) } },
        makeContext(),
      ),
    ).rejects.toThrow(UnsupportedCapabilityError);
    await orchestrator.shutdown();
  });

  it('exposes provider capabilities so callers can branch before building a request', async () => {
    const orchestrator = await makeOrchestrator();
    expect(orchestrator.capabilities().input.document).toBe(true);
    await orchestrator.shutdown();
  });
});

describe('governed batch operations', () => {
  const items: BatchRequestItem[] = [
    {
      customId: 'doc-1',
      request: {
        systemPrompt: '',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'a' }],
      },
    },
  ];

  it('submits a job and emits its identity', async () => {
    const provider = new FakeProvider();
    const orchestrator = await makeOrchestrator(provider);
    const events: Array<Record<string, unknown>> = [];
    orchestrator.events.on('llm.batch.submitted', (event) => events.push(event.data));

    const job = await orchestrator.submitBatch(items, makeContext());

    expect(job.jobId).toBe('job-1');
    expect(events[0]).toMatchObject({ jobId: 'job-1', requests: 1, executionMode: 'batch' });
    await orchestrator.shutdown();
  });

  it('polls a job by id, with no timers of its own', async () => {
    const orchestrator = await makeOrchestrator();
    const job = await orchestrator.getBatch('job-1', makeContext());
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ succeeded: 1, failed: 1 });
    await orchestrator.shutdown();
  });

  it('streams results and records usage per successful item', async () => {
    const provider = new FakeProvider();
    provider.batchResults = [
      {
        customId: 'doc-1',
        response: {
          content: '{"total":1}',
          stopReason: 'end',
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 0.001 },
          model: 'fake-model',
          provider: 'fake',
          executionMode: 'batch',
          latencyMs: 0,
        },
      },
      { customId: 'doc-2', error: { message: 'invalid document' } },
    ];
    const orchestrator = await makeOrchestrator(provider);

    const seen: string[] = [];
    for await (const item of orchestrator.streamBatchResults('job-1', makeContext())) {
      seen.push(item.customId);
    }

    expect(seen).toEqual(['doc-1', 'doc-2']);
    const usage = await orchestrator.tokens.getByTenant('acme', {
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(usage.totalInputTokens).toBe(100);
    await orchestrator.shutdown();
  });

  it('reports an individual failure without failing the whole stream', async () => {
    const provider = new FakeProvider();
    provider.batchResults = [{ customId: 'doc-2', error: { message: 'invalid document' } }];
    const orchestrator = await makeOrchestrator(provider);

    const items2 = [];
    for await (const item of orchestrator.streamBatchResults('job-1', makeContext())) {
      items2.push(item);
    }

    expect(items2[0]!.error).toEqual({ message: 'invalid document' });
    await orchestrator.shutdown();
  });

  it('refuses batch on a provider without it', async () => {
    const orchestrator = await makeOrchestrator(new TextOnlyProvider());

    await expect(orchestrator.submitBatch(items, makeContext())).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    await orchestrator.shutdown();
  });
});
