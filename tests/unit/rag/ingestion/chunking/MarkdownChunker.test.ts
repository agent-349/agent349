import { describe, it, expect } from 'vitest';
import { MarkdownChunker } from '../../../../../src/rag/ingestion/chunking/MarkdownChunker.js';
import type { RawDocument } from '../../../../../src/rag/ingestion/types.js';

function makeDoc(content: string): RawDocument {
  return { content, metadata: { documentId: 'doc-1' }, extractionMethod: 'test' };
}

describe('MarkdownChunker', () => {
  const chunker = new MarkdownChunker();
  const config = {
    strategy: 'markdown' as const,
    chunkSize: 100,
    chunkOverlap: 10,
    minChunkSize: 5,
  };

  it('splits at ## boundaries', () => {
    const md = [
      '# Document',
      '',
      '## Section One',
      'Content for section one with several words.',
      '',
      '## Section Two',
      'Content for section two with different words.',
    ].join('\n');

    const chunks = chunker.chunk(makeDoc(md), config);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Each section should be in its own chunk (or sub-chunks)
    const allText = chunks.map((c) => c.content).join(' ');
    expect(allText).toContain('Section One');
    expect(allText).toContain('Section Two');
  });

  it('records headerPath in metadata.custom', () => {
    const md = '## Section\nBody text here';
    const chunks = chunker.chunk(makeDoc(md), config);
    expect(chunks.length).toBeGreaterThan(0);
    // custom.headerPath should be set
    expect((chunks[0]!.metadata.custom as Record<string, unknown>)?.headerPath).toBeDefined();
  });

  it('assigns chunkIndex and totalChunks', () => {
    const md = [
      '## A\nText for A section',
      '## B\nText for B section',
      '## C\nText for C section',
    ].join('\n');
    const chunks = chunker.chunk(makeDoc(md), config);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.metadata.chunkIndex).toBe(i);
      expect(chunks[i]!.metadata.totalChunks).toBe(chunks.length);
    }
  });

  it('sub-splits large sections', () => {
    // A section with a lot of content that exceeds chunkSize
    const bigSection = '## Big Section\n' + 'word '.repeat(200);
    const chunks = chunker.chunk(makeDoc(bigSection), { ...config, chunkSize: 30 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('content hashes are valid sha256', () => {
    const md = '## Section\nSome body text here';
    const chunks = chunker.chunk(makeDoc(md), config);
    for (const c of chunks) {
      expect(c.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
