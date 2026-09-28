import { createHash } from 'node:crypto';
import type { DocumentMetadata } from '../types.js';
import type { RawDocument, TextChunk, ChunkingConfig } from '../types.js';
import { ChunkingStrategy, tokenCount } from './ChunkingStrategy.js';

// ─────────────────────────────────────────────────────────────────────────────
// FixedSizeChunker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits documents into fixed-size token windows with configurable overlap.
 *
 * Simpler and faster than the recursive approach but less semantically aware —
 * it may split in the middle of sentences or paragraphs. Use
 * {@link RecursiveChunker} when semantic coherence matters.
 */
export class FixedSizeChunker extends ChunkingStrategy {
  override readonly name = 'fixed_size';

  override chunk(document: RawDocument, config: ChunkingConfig): TextChunk[] {
    const chunkSize = config.chunkSize ?? 512;
    const overlap = config.chunkOverlap ?? 50;
    const minSize = config.minChunkSize ?? 100;

    // Tokenize by splitting on whitespace — one "token" ≈ one word
    const words = document.content.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Build character-aligned word segments
    const step = Math.max(1, chunkSize - overlap);
    const rawChunks: string[] = [];

    for (let start = 0; start < words.length; start += step) {
      const slice = words.slice(start, start + chunkSize).join(' ');
      if (tokenCount(slice) >= minSize) {
        rawChunks.push(slice);
      }
    }

    // Ensure the last chunk is included even if small
    const lastStart = Math.max(0, words.length - chunkSize);
    const lastSlice = words.slice(lastStart).join(' ');
    if (
      rawChunks.length === 0 ||
      (rawChunks[rawChunks.length - 1] !== lastSlice && tokenCount(lastSlice) > 0)
    ) {
      // Only add if it wasn't already added
      if (rawChunks[rawChunks.length - 1] !== lastSlice) {
        rawChunks.push(lastSlice);
      }
    }

    const total = rawChunks.length;
    return rawChunks.map((text, idx) => {
      const metadata: DocumentMetadata = {
        ...document.metadata,
        chunkIndex: idx,
        totalChunks: total,
      };

      return {
        content: text,
        index: idx,
        startOffset: 0,
        endOffset: text.length,
        metadata,
        contentHash: createHash('sha256').update(text, 'utf-8').digest('hex'),
      } satisfies TextChunk;
    });
  }
}
