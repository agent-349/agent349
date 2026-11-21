/**
 * Native stop words: what each adapter sends to its engine, and how the
 * pipeline and facade choose between native and query-side application.
 * Offline — engines are faked at the HTTP / pool level.
 */
import { describe, it, expect, vi } from 'vitest';

import { WeaviateAdapter } from '../../../src/rag/vectorstore/WeaviateAdapter.js';
import { MilvusAdapter } from '../../../src/rag/vectorstore/MilvusAdapter.js';
import { PgVectorAdapter } from '../../../src/rag/vectorstore/PgVectorAdapter.js';
import type { PgVectorPool } from '../../../src/rag/vectorstore/PgVectorAdapter.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { StopWords } from '../../../src/rag/lexicon/Lexicon.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { mockFetch } from '../../fixtures/mockFetch.js';
import type { CollectionConfig, StopWordsApplyResult } from '../../../src/types/index.js';

const BASE: CollectionConfig = {
  dimensions: 3,
  distanceMetric: 'cosine',
  embeddingProvider: 'openai',
  embeddingModel: 'openai/m',
};

// ─────────────────────────────────────────────────────────────────────────────
// StopWords.list
// ─────────────────────────────────────────────────────────────────────────────

describe('StopWords.list', () => {
  it('lists each word with and without accents, never protected or kept words', () => {
    const list = new StopWords({ stopWords: 'auto', keepWords: ['como'] }).list(['es']);
    expect(list).toContain('qué');
    expect(list).toContain('que');
    expect(list).not.toContain('como');
    expect(list).not.toContain('no');
    expect(list).not.toContain('sin');
    expect(new StopWords({ stopWords: 'auto' }).list(['pt'])).not.toContain('no'); // "no" is protected
  });

  it('is empty when stop words are off', () => {
    expect(new StopWords({ stopWords: false }).list(['es'])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────────

describe('WeaviateAdapter — stop words', () => {
  it('creates the class with the SDK words as additions to preset none', async () => {
    const { fetch, calls } = mockFetch([
      { method: 'POST', path: /^\/v1\/schema$/, reply: () => ({}) },
      { method: 'POST', path: /^\/v1\/batch\/objects$/, reply: () => [{ result: {} }] },
    ]);
    await new WeaviateAdapter({ fetch }).createCollection('docs', {
      ...BASE,
      stopWords: ['la', 'de'],
    });
    expect(calls.find((c) => c.path === '/v1/schema')!.body).toMatchObject({
      invertedIndexConfig: { stopwords: { preset: 'none', additions: ['la', 'de'] } },
    });
  });

  it('replaces the stop words of an existing class with PUT, keeping the rest of the schema', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /^\/v1\/schema\/Agent349_docs$/,
        reply: () => ({
          class: 'Agent349_docs',
          invertedIndexConfig: {
            indexNullState: true,
            stopwords: { preset: 'none' },
            bm25: { b: 0.75, k1: 1.2 },
          },
          properties: [{ name: 'content' }],
        }),
      },
      { method: 'PUT', path: /^\/v1\/schema\/Agent349_docs$/, reply: () => ({}) },
    ]);
    const adapter = new WeaviateAdapter({ fetch });
    expect(adapter.nativeStopWords).toBe('mutable');
    const result = await adapter.applyStopWords('docs', { words: ['la'], languages: ['es'] });
    expect(result).toEqual({ applied: true, engine: 'weaviate', method: 'schema', wordCount: 1 });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({
      class: 'Agent349_docs',
      invertedIndexConfig: {
        indexNullState: true,
        bm25: { b: 0.75, k1: 1.2 },
        stopwords: { preset: 'none', additions: ['la'], removals: [] },
      },
      properties: [{ name: 'content' }],
    });
  });
});

describe('MilvusAdapter — stop words', () => {
  it('puts the SDK words in the BM25 analyzer at creation', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'POST',
        path: /\/collections\/has$/,
        reply: () => ({ code: 0, data: { has: false } }),
      },
      { method: 'POST', path: /./, reply: () => ({ code: 0, data: {} }) },
    ]);
    await new MilvusAdapter({ fetch }).createCollection('docs', {
      ...BASE,
      stopWords: ['la', 'de'],
    });
    const create = calls.find(
      (c) =>
        c.path.endsWith('/collections/create') &&
        (c.body as { collectionName: string }).collectionName === 'docs',
    )!;
    const content = (
      create.body as { schema: { fields: { fieldName: string; elementTypeParams?: object }[] } }
    ).schema.fields.find((f) => f.fieldName === 'content')!;
    expect(content.elementTypeParams).toEqual({
      max_length: 65535,
      enable_analyzer: true,
      analyzer_params: {
        tokenizer: 'standard',
        filter: ['lowercase', { type: 'stop', stop_words: ['la', 'de'] }],
      },
    });
  });

  it('reports that an existing collection cannot change them', async () => {
    const adapter = new MilvusAdapter({ fetch: mockFetch([]).fetch });
    expect(adapter.nativeStopWords).toBe('creation');
    expect(
      await adapter.applyStopWords('docs', { words: ['la'], languages: ['es'] }),
    ).toMatchObject({
      applied: false,
      reason: 'creation_only',
    });
  });
});

function fakePool(answer: (sql: string) => Record<string, unknown>[] = () => []) {
  const queries: string[] = [];
  const pool: PgVectorPool = {
    async query(sql) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      const rows = answer(sql);
      return { rows, rowCount: rows.length };
    },
    async end() {},
  };
  return { pool, queries };
}

describe('PgVectorAdapter — stop words', () => {
  const engine = (current: string) =>
    fakePool((sql) =>
      /pg_ts_config/.test(sql)
        ? [{ '?column?': 1 }]
        : /pg_get_expr/.test(sql)
          ? [{ expr: `to_tsvector('${current}'::regconfig, ...)` }]
          : [],
    );

  it('creates the collection with the text-search configuration of its single language', async () => {
    const { pool, queries } = fakePool();
    await new PgVectorAdapter({ pool }).createCollection('docs', {
      ...BASE,
      stopWords: ['la'],
      languages: ['es'],
    });
    expect(queries.find((q) => q.startsWith('CREATE TABLE') && q.includes('tsv'))).toContain(
      "to_tsvector('spanish'",
    );
  });

  it('rebuilds the tsv column in one transaction for a language', async () => {
    const { pool, queries } = engine('simple');
    const result = await new PgVectorAdapter({ pool }).applyStopWords('docs', {
      words: ['la'],
      languages: ['es-UY'],
    });
    expect(result).toMatchObject({ applied: true, method: 'text_search_config' });
    const ddl = queries.find((q) => q.startsWith('BEGIN'))!;
    expect(ddl).toContain('DROP COLUMN IF EXISTS tsv');
    expect(ddl).toContain("to_tsvector('spanish'");
    expect(ddl).toContain('USING gin (tsv)');
    expect(ddl.endsWith('COMMIT;')).toBe(true);
  });

  it('does nothing when the configuration is already the right one', async () => {
    const { pool, queries } = engine('spanish');
    expect(
      await new PgVectorAdapter({ pool }).applyStopWords('docs', {
        words: ['la'],
        languages: ['es'],
      }),
    ).toMatchObject({
      applied: true,
      detail: "already 'spanish'",
    });
    expect(queries.some((q) => q.startsWith('BEGIN'))).toBe(false);
  });

  it('needs a single language with a configuration, and clearing restores the default', async () => {
    const adapter = new PgVectorAdapter({ pool: engine('spanish').pool });
    expect(
      await adapter.applyStopWords('docs', { words: ['la'], languages: ['es', 'en'] }),
    ).toMatchObject({
      applied: false,
      reason: 'single_language_only',
    });
    expect(
      await adapter.applyStopWords('docs', { words: ['la'], languages: ['zh'] }),
    ).toMatchObject({
      applied: false,
      reason: 'unsupported_language',
    });
    const { pool, queries } = engine('spanish');
    await new PgVectorAdapter({ pool }).applyStopWords('docs', { words: [], languages: ['es'] });
    expect(queries.find((q) => q.startsWith('BEGIN'))).toContain("to_tsvector('simple'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

class NativeStore extends InMemoryVectorStore {
  readonly applied: { collection: string; words: string[]; languages: string[] }[] = [];
  override get nativeStopWords(): 'mutable' {
    return 'mutable';
  }
  override async applyStopWords(
    collection: string,
    request: { words: string[]; languages: string[] },
  ): Promise<StopWordsApplyResult> {
    this.applied.push({ collection, ...request });
    return {
      applied: true,
      engine: this.name,
      method: 'index_settings',
      wordCount: request.words.length,
    };
  }
}

const pipelineWith = (
  store: InMemoryVectorStore,
  mode?: 'auto' | 'native' | 'query',
  enabled = true,
) =>
  new RAGPipeline(
    new EmbeddingRouter(),
    store,
    undefined,
    new EventBus(),
    new TokenTracker(),
    undefined,
    'require',
    {
      lexicon: {
        ...(enabled && { stopWords: new StopWords({ stopWords: 'auto' }) }),
        ...(mode !== undefined && { stopWordsMode: mode }),
      },
    },
  );

describe('RAGPipeline — where stop words apply', () => {
  it('auto: native when the engine supports it, otherwise from the query', () => {
    expect(pipelineWith(new NativeStore()).stopWordsApplication).toBe('native');
    expect(pipelineWith(new InMemoryVectorStore()).stopWordsApplication).toBe('query');
  });

  it('query always from the query; native never from the query', () => {
    expect(pipelineWith(new NativeStore(), 'query').stopWordsApplication).toBe('query');
    expect(pipelineWith(new InMemoryVectorStore(), 'native').stopWordsApplication).toBe('off');
    expect(pipelineWith(new NativeStore(), 'auto', false).stopWordsApplication).toBe('off');
  });

  it('configureStopWords sends the words of the languages, or clears them when off', async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on('rag.collection.stop_words', (e) => events.push(e.data));
    const store = new NativeStore();
    const pipeline = new RAGPipeline(
      new EmbeddingRouter(),
      store,
      undefined,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        lexicon: { stopWords: new StopWords({ stopWords: 'auto' }) },
      },
    );
    const result = await pipeline.configureStopWords('docs', ['es']);
    expect(result.applied).toBe(true);
    expect(store.applied[0]!.words).toContain('qué');
    expect(store.applied[0]!.words).not.toContain('the');
    expect(events).toHaveLength(1);

    const off = new NativeStore();
    await pipelineWith(off, 'auto', false).configureStopWords('docs', ['es']);
    expect(off.applied[0]!.words).toEqual([]);
  });

  it('configureStopWords clears native stop words in query mode and skips engines without support', async () => {
    const store = new NativeStore();
    expect((await pipelineWith(store, 'query').configureStopWords('docs', ['es'])).applied).toBe(
      true,
    );
    expect(store.applied[0]!.words).toEqual([]);
    expect(
      await pipelineWith(new InMemoryVectorStore()).configureStopWords('docs', ['es']),
    ).toMatchObject({
      applied: false,
      reason: 'not_supported',
    });
  });

  it('stopWordsForCreation gives words and languages only for native application', () => {
    const native = pipelineWith(new NativeStore()).stopWordsForCreation(['es']);
    expect(native.languages).toEqual(['es']);
    expect(native.stopWords).toContain('qué');
    expect(pipelineWith(new InMemoryVectorStore()).stopWordsForCreation(['es'])).toEqual({});
  });

  it('a native pipeline does not touch the keyword query', async () => {
    const store = new NativeStore();
    await store.createCollection('docs', {
      ...BASE,
      embeddingProvider: 'mock',
      embeddingModel: 'mock/m',
    });
    const hybrid = vi.spyOn(store, 'hybridSearch');
    const embedding = new EmbeddingRouter();
    embedding.registerProvider({
      name: 'mock',
      model: 'mock/m',
      embed: async () => ({
        vector: [1, 0, 0],
        model: 'm',
        dimensions: 3,
        tokensUsed: 0,
        latencyMs: 0,
      }),
      embedBatch: async () => [],
      getDimensions: () => 3,
      validate: async () => true,
    } as never);
    const pipeline = new RAGPipeline(
      embedding,
      store,
      undefined,
      new EventBus(),
      new TokenTracker(),
      undefined,
      'require',
      {
        lexicon: { stopWords: new StopWords({ stopWords: 'auto' }) },
      },
    );
    const result = await pipeline.search(
      { query: '¿qué es el plan?', collections: ['docs'] },
      {
        tenantId: 't',
        userId: 'u',
        roles: [],
        sessionId: 's',
        agentId: 'a',
        requestId: 'r',
      },
    );
    expect(hybrid.mock.calls[0]![2]).toBe('¿qué es el plan?');
    expect(result.trace.lexicon).toMatchObject({ stopWords: 'native', stopWordsRemoved: 0 });
  });
});
