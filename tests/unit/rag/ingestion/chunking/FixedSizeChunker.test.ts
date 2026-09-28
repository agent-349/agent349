import { describe, it, expect } from 'vitest';
import { FixedSizeChunker } from '../../../../../src/rag/ingestion/chunking/FixedSizeChunker.js';
import type { RawDocument } from '../../../../../src/rag/ingestion/types.js';

function makeDoc(content: string): RawDocument {
  return { content, metadata: { documentId: 'doc-1' }, extractionMethod: 'test' };
}

describe('FixedSizeChunker', () => {
  const chunker = new FixedSizeChunker();
  const config = {
    strategy: 'fixed_size' as const,
    chunkSize: 10,
    chunkOverlap: 2,
    minChunkSize: 1,
  };

  it('chunks long text into multiple windows', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunker.chunk(makeDoc(text), config);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('short text returns single chunk', () => {
    const chunks = chunker.chunk(makeDoc('hello world'), { ...config, chunkSize: 50 });
    expect(chunks.length).toBe(1);
  });

  it('assigns chunkIndex and totalChunks', () => {
    const text = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunker.chunk(makeDoc(text), config);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.metadata.chunkIndex).toBe(i);
      expect(chunks[i]!.metadata.totalChunks).toBe(chunks.length);
    }
  });

  it('content hashes are valid sha256', () => {
    const chunks = chunker.chunk(makeDoc('a b c d e f g h i j k l m'), config);
    for (const c of chunks) {
      expect(c.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('returns empty array for empty document', () => {
    const chunks = chunker.chunk(makeDoc(''), config);
    expect(chunks.length).toBe(0);
  });
});
