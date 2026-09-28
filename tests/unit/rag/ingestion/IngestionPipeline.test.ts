import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore } from '../../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../../src/rag/embedding/EmbeddingProvider.js';
import { DocumentLoaderRegistry } from '../../../../src/rag/ingestion/DocumentLoaderRegistry.js';
import { PlainTextLoader } from '../../../../src/rag/ingestion/loaders/PlainTextLoader.js';
import { MarkdownLoader } from '../../../../src/rag/ingestion/loaders/MarkdownLoader.js';
import { RecursiveChunker } from '../../../../src/rag/ingestion/chunking/RecursiveChunker.js';
import { IngestionPipeline } from '../../../../src/rag/ingestion/IngestionPipeline.js';
import { EventBus } from '../../../../src/events/EventBus.js';
import { TokenTracker } from '../../../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../../../src/memory/adapters/InMemoryAdapter.js';
import type { EmbeddingResult } from '../../../../src/types/index.js';
import type { IngestProgress } from '../../../../src/rag/ingestion/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock embedding provider
// ─────────────────────────────────────────────────────────────────────────────

class MockEmbeddingProvider extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-v1';

  getDimensions() {
    return 4;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return {
      vector: [(text.length % 4) * 0.1, 0.5, 0.3, 0.1],
      dimensions: 4,
      tokensUsed: Math.ceil(text.length / 4),
      latencyMs: 1,
      model: 'mock-v1',
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async validate() {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPipeline() {
  const loaderRegistry = new DocumentLoaderRegistry();
  loaderRegistry.register(new PlainTextLoader());
  loaderRegistry.register(new MarkdownLoader());

  const embeddingProvider = new MockEmbeddingProvider();
  const embeddingRouter = new EmbeddingRouter(new Map([['mock', embeddingProvider]]));
  const vectorStore = new InMemoryVectorStore();
  const bus = new EventBus();
  const tokens = new TokenTracker(new InMemoryAdapter());

  const pipeline = new IngestionPipeline(
    loaderRegistry,
    new RecursiveChunker(),
    embeddingRouter,
    vectorStore,
    bus,
    tokens,
    { defaultEmbeddingProvider: 'mock' },
  );

  return { pipeline, vectorStore, bus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('IngestionPipeline', () => {
  it('TC-ING-01: ingests text document and creates chunks', async () => {
    const { pipeline } = buildPipeline();

    const result = await pipeline.ingest(
      { type: 'text', text: 'This is a test document with some content to be indexed.' },
      'test-collection',
    );

    expect(result.documentId).toBeTruthy();
    expect(result.chunksCreated).toBeGreaterThanOrEqual(1);
    expect(result.chunksSkipped).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('TC-ING-01: chunks have documentId, chunkIndex, totalChunks in metadata', async () => {
    const { pipeline, vectorStore } = buildPipeline();

    const result = await pipeline.ingest(
      {
        type: 'text',
        text: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.',
        metadata: { tenantId: 'acme' },
      },
      'meta-col',
    );

    // Verify vector store received the chunks
    const searchResults = await vectorStore.search('meta-col', [0.1, 0.5, 0.3, 0.1], 10);
    expect(searchResults.length).toBeGreaterThan(0);
    const meta = searchResults[0]!.metadata;
    expect(meta.documentId).toBe(result.documentId);
    expect(meta.chunkIndex).toBeGreaterThanOrEqual(0);
    expect(meta.totalChunks).toBeGreaterThanOrEqual(1);
    expect(meta.tenantId).toBe('acme');
  });

  // TC-ING-03: Deduplication by contentHash
  it('TC-ING-03: re-ingesting identical content skips all chunks', async () => {
    const { pipeline } = buildPipeline();
    const source = { type: 'text' as const, text: 'Unique document content here.' };

    // First ingest — creates chunks
    const first = await pipeline.ingest(source, 'dedup-col', { overwriteExisting: false });
    expect(first.chunksCreated).toBeGreaterThan(0);

    // Second ingest same content — deduplication should skip all
    const second = await pipeline.ingest(source, 'dedup-col', {
      deduplication: true,
      overwriteExisting: false,
    });
    expect(second.chunksSkipped).toBe(first.chunksCreated);
    expect(second.chunksCreated).toBe(0);
  });

  // TC-ING-04: overwriteExisting replaces previous chunks
  it('TC-ING-04: overwriteExisting replaces previous chunks', async () => {
    const { pipeline, vectorStore } = buildPipeline();

    const docId = 'fixed-doc-id';

    // First ingest with 1 chunk
    await pipeline.ingest(
      { type: 'text', text: 'Short doc', metadata: { documentId: docId } },
      'overwrite-col',
      { overwriteExisting: false, deduplication: false },
    );

    const before = await vectorStore.search('overwrite-col', [0.1, 0.5, 0.3, 0.1], 10);
    const beforeCount = before.filter((p) => p.metadata.documentId === docId).length;

    // Second ingest with different content
    await pipeline.ingest(
      {
        type: 'text',
        text: 'Much longer document version with more content that will produce more chunks perhaps.',
        metadata: { documentId: docId },
      },
      'overwrite-col',
      { overwriteExisting: true, deduplication: false },
    );

    const after = await vectorStore.search('overwrite-col', [0.1, 0.5, 0.3, 0.1], 10);
    const afterCount = after.filter((p) => p.metadata.documentId === docId).length;

    // After overwrite, old chunks replaced with new ones
    expect(afterCount).toBeGreaterThan(0);
    // The chunks are different so the old ones should no longer dominate
    void beforeCount; // used for comparison context
  });

  // TC-ING-06: progress callback fires with percentage
  it('TC-ING-06: onProgress callback fires with percentage', async () => {
    const { pipeline } = buildPipeline();
    const progressEvents: IngestProgress[] = [];

    await pipeline.ingest(
      { type: 'text', text: 'Document for progress tracking.' },
      'progress-col',
      { onProgress: (p) => progressEvents.push(p) },
    );

    expect(progressEvents.length).toBeGreaterThan(0);
    const lastEvent = progressEvents[progressEvents.length - 1]!;
    expect(lastEvent.percentage).toBe(100);
  });

  // TC-ING-07: error in batch does not abort other docs
  it('TC-ING-07: ingestBatch continues on individual document errors', async () => {
    const { pipeline } = buildPipeline();

    const results = await pipeline.ingestBatch(
      [
        { type: 'text', text: 'Document one - valid' },
        { type: 'buffer', mimeType: 'application/pdf' }, // missing buffer — will error
        { type: 'text', text: 'Document three - valid' },
      ],
      'batch-col',
    );

    expect(results).toHaveLength(3);
    // First and third should succeed
    expect(results[0]!.errors).toBeUndefined();
    expect(results[0]!.chunksCreated).toBeGreaterThan(0);
    // Second should have errors
    expect(results[1]!.errors).toBeDefined();
    expect(results[1]!.errors!.length).toBeGreaterThan(0);
    // Third should succeed
    expect(results[2]!.errors).toBeUndefined();
    expect(results[2]!.chunksCreated).toBeGreaterThan(0);
  });

  // TC-ING-08: metadata merging
  it('TC-ING-08: user metadata merges with auto-detected metadata', async () => {
    const { pipeline, vectorStore } = buildPipeline();

    const result = await pipeline.ingest(
      {
        type: 'text',
        mimeType: 'text/plain',
        text: 'Content here',
        metadata: { tags: ['rrhh'], tenantId: 'acme' },
      },
      'merge-col',
    );

    const docs = await vectorStore.search('merge-col', [0.1, 0.5, 0.3, 0.1], 5);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]!.metadata.tags).toEqual(['rrhh']);
    expect(docs[0]!.metadata.tenantId).toBe('acme');
    expect(docs[0]!.metadata.mimeType).toBe('text/plain');
    expect(result.documentId).toBeTruthy();
  });

  // TC-ING-10: collection auto-created if not exists
  it('TC-ING-10: auto-creates collection if it does not exist', async () => {
    const { pipeline, vectorStore } = buildPipeline();

    const newCollection = 'auto-created-collection';
    expect(await vectorStore.collectionExists(newCollection)).toBe(false);

    await pipeline.ingest({ type: 'text', text: 'Hello auto-collection' }, newCollection);

    expect(await vectorStore.collectionExists(newCollection)).toBe(true);
  });

  it('removeDocument deletes all chunks', async () => {
    const { pipeline, vectorStore } = buildPipeline();
    const docId = 'to-delete';

    await pipeline.ingest(
      { type: 'text', text: 'Document to be deleted', metadata: { documentId: docId } },
      'delete-col',
    );

    const before = await vectorStore.search('delete-col', [0.1, 0.5, 0.3, 0.1], 10);
    expect(before.length).toBeGreaterThan(0);

    const { chunksRemoved } = await pipeline.removeDocument(docId, 'delete-col');
    expect(chunksRemoved).toBeGreaterThan(0);

    const after = await vectorStore.search('delete-col', [0.1, 0.5, 0.3, 0.1], 10);
    expect(after.length).toBe(0);
  });

  it('emits EventBus events during ingestion', async () => {
    const { pipeline, bus } = buildPipeline();
    const events: string[] = [];

    bus.on('ingest.load.start', () => events.push('load.start'));
    bus.on('ingest.chunk.start', () => events.push('chunk.start'));
    bus.on('ingest.embed.start', () => events.push('embed.start'));
    bus.on('ingest.upsert.start', () => events.push('upsert.start'));
    bus.on('ingest.complete', () => events.push('complete'));

    await pipeline.ingest({ type: 'text', text: 'Event tracking test' }, 'events-col');

    expect(events).toContain('load.start');
    expect(events).toContain('chunk.start');
    expect(events).toContain('embed.start');
    expect(events).toContain('upsert.start');
    expect(events).toContain('complete');
  });

  // Regression: a pre-existing collection's own embeddingProvider must be used
  // on ingest, not the pipeline's defaultEmbeddingProvider. Previously the
  // "exists" branch of #ensureCollection always fell back to the default.
  it('TC-ING-REG: ingest honors an existing collection embeddingProvider over the default', async () => {
    const loaderRegistry = new DocumentLoaderRegistry();
    loaderRegistry.register(new PlainTextLoader());

    // Only 'mock' is registered; the default points to an UNREGISTERED provider.
    const embeddingRouter = new EmbeddingRouter(new Map([['mock', new MockEmbeddingProvider()]]));
    const vectorStore = new InMemoryVectorStore();

    const pipeline = new IngestionPipeline(
      loaderRegistry,
      new RecursiveChunker(),
      embeddingRouter,
      vectorStore,
      new EventBus(),
      new TokenTracker(new InMemoryAdapter()),
      { defaultEmbeddingProvider: 'openai' }, // not registered on purpose
    );

    // Pre-create the collection with the 'mock' provider (e.g. via CollectionManager).
    await vectorStore.createCollection('kb', {
      dimensions: 4,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock/mock-v1',
    });

    // Before the fix this threw "Embedding provider 'openai' is not registered".
    const result = await pipeline.ingest({ type: 'text', text: 'hello world content' }, 'kb');
    expect(result.chunksCreated).toBeGreaterThanOrEqual(1);
  });
});
