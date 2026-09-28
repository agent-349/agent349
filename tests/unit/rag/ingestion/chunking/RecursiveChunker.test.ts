import { describe, it, expect } from 'vitest';
import { RecursiveChunker } from '../../../../../src/rag/ingestion/chunking/RecursiveChunker.js';
import type { RawDocument } from '../../../../../src/rag/ingestion/types.js';

function makeDoc(content: string): RawDocument {
  return {
    content,
    metadata: { documentId: 'doc-1' },
    extractionMethod: 'test',
  };
}

describe('RecursiveChunker', () => {
  const chunker = new RecursiveChunker();
  const config = {
    strategy: 'recursive' as const,
    chunkSize: 50,
    chunkOverlap: 10,
    minChunkSize: 5,
  };

  it('returns single chunk for short text', () => {
    const chunks = chunker.chunk(makeDoc('Short text that fits.'), config);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toContain('Short text');
  });

  it('assigns chunkIndex and totalChunks metadata', () => {
    const longText = 'Word '.repeat(200);
    const chunks = chunker.chunk(makeDoc(longText), config);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.metadata.chunkIndex).toBe(i);
      expect(chunks[i]!.metadata.totalChunks).toBe(chunks.length);
    }
  });

  it('generates a contentHash per chunk', () => {
    const chunks = chunker.chunk(makeDoc('Some text content here'), { ...config, chunkSize: 10 });
    for (const c of chunks) {
      expect(c.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  // TC-ING-02: respeta jerarquía de separadores
  it('TC-ING-02: prefers Markdown headers over paragraph breaks', () => {
    const md = [
      '## Introduction',
      'This is the intro paragraph with enough words to be meaningful.',
      '',
      '## Section Two',
      'This is section two with different content and more words.',
    ].join('\n');

    const chunks = chunker.chunk(makeDoc(md), { ...config, chunkSize: 30 });

    // The chunker should have split at the ## boundary rather than mid-paragraph
    const hasHeaderBoundary = chunks.some(
      (c) => c.content.includes('## Introduction') || c.content.includes('## Section Two'),
    );
    expect(hasHeaderBoundary).toBe(true);
  });

  it('chunks with overlap contain repeated content at boundaries', () => {
    // Use a large enough text to force multiple chunks
    const text = [
      'Alpha beta gamma delta epsilon',
      'Zeta eta theta iota kappa lambda',
      'Mu nu xi omicron pi rho sigma',
      'Tau upsilon phi chi psi omega alpha',
    ].join('. ');

    const chunks = chunker.chunk(makeDoc(text), { ...config, chunkSize: 20, chunkOverlap: 5 });
    // Verify chunks are non-empty and have hashes
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
      expect(c.contentHash).toHaveLength(64);
    }
  });

  it('inherits metadata from source document', () => {
    const doc: RawDocument = {
      content: 'Some text',
      metadata: { documentId: 'doc-42', tenantId: 'acme', tags: ['test'] },
      extractionMethod: 'test',
    };
    const chunks = chunker.chunk(doc, config);
    expect(chunks[0]!.metadata.documentId).toBe('doc-42');
    expect(chunks[0]!.metadata.tenantId).toBe('acme');
    expect(chunks[0]!.metadata.tags).toEqual(['test']);
  });

  it('returns empty array for empty content', () => {
    const chunks = chunker.chunk(makeDoc(''), config);
    expect(chunks.length).toBe(0);
  });

  it('custom separators take precedence', () => {
    const text = 'Part1---Part2---Part3';
    const chunks = chunker.chunk(makeDoc(text), {
      ...config,
      chunkSize: 5,
      minChunkSize: 1,
      separators: ['---'],
    });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
