import { createHash } from 'node:crypto';
import type { DocumentMetadata } from '../types.js';
import type { RawDocument, TextChunk, ChunkingConfig } from '../types.js';
import { ChunkingStrategy, tokenCount, getLastNTokens } from './ChunkingStrategy.js';

// Default separator hierarchy for recursive splitting
const DEFAULT_SEPARATORS = ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' '];

// ─────────────────────────────────────────────────────────────────────────────
// RecursiveChunker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively splits documents by a hierarchy of separators.
 *
 * The algorithm finds the highest-priority separator present in the text and
 * splits there. Each resulting segment is recursively processed: if it still
 * exceeds `chunkSize`, the next separator in the hierarchy is tried.
 *
 * This preserves semantic boundaries (e.g. Markdown headers) rather than
 * splitting mid-paragraph.
 *
 * An **overlap** prefix from the previous chunk is prepended to each new chunk
 * so that context is not lost at boundaries.
 */
export class RecursiveChunker extends ChunkingStrategy {
  override readonly name = 'recursive';

  override chunk(document: RawDocument, config: ChunkingConfig): TextChunk[] {
    const separators = config.separators ?? DEFAULT_SEPARATORS;
    const chunkSize = config.chunkSize ?? 512;
    const overlap = config.chunkOverlap ?? 50;
    const minSize = config.minChunkSize ?? 100;

    const rawChunks = this.#recursiveSplit(
      document.content,
      separators,
      chunkSize,
      overlap,
      minSize,
    );

    // Assign final metadata to each chunk
    const total = rawChunks.length;
    return rawChunks.map((text, idx) => {
      const startOffset = document.content.indexOf(text.trimStart()) || 0;
      const metadata: DocumentMetadata = {
        ...document.metadata,
        chunkIndex: idx,
        totalChunks: total,
      };

      return {
        content: text,
        index: idx,
        startOffset,
        endOffset: startOffset + text.length,
        metadata,
        contentHash: sha256(text),
      } satisfies TextChunk;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #recursiveSplit(
    text: string,
    separators: string[],
    chunkSize: number,
    overlap: number,
    minSize: number,
  ): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Base case: fits in one chunk — always keep it (minSize applies only to split fragments)
    if (tokenCount(trimmed) <= chunkSize) {
      return [trimmed];
    }

    // Find the first separator that actually appears in the text
    const separator =
      separators.find((s) => trimmed.includes(s)) ?? separators[separators.length - 1]!;

    // Split and reassemble
    const parts = trimmed.split(separator);
    const chunks: string[] = [];
    let current = '';

    // Separators deeper than the current one — used to recursively split
    // individual parts that still exceed chunkSize.
    const deeperSeps = separators.slice(separators.indexOf(separator) + 1);

    for (const part of parts) {
      const trimmedPart = part.trim();
      if (!trimmedPart) continue;

      const candidate = current ? `${current}${separator}${trimmedPart}` : trimmedPart;

      if (tokenCount(candidate) > chunkSize && current) {
        // Flush current chunk
        const chunkText = current.trim();
        if (tokenCount(chunkText) >= minSize) {
          chunks.push(chunkText);
        }

        // Start new chunk with overlap from previous
        const overlapText = getLastNTokens(current, overlap);
        current = overlapText ? `${overlapText}${separator}${trimmedPart}` : trimmedPart;
      } else {
        current = candidate;
      }

      // If the current buffer already exceeds chunkSize (a single part too large),
      // recursively split it using deeper separators and reset current.
      if (tokenCount(current) > chunkSize && deeperSeps.length > 0) {
        const subChunks = this.#recursiveSplit(current, deeperSeps, chunkSize, overlap, minSize);
        // All sub-chunks except the last are final; the last becomes the new current
        // so it can be merged with the next part.
        for (let s = 0; s < subChunks.length - 1; s++) {
          chunks.push(subChunks[s]!);
        }
        current = subChunks[subChunks.length - 1] ?? '';
      }
    }

    // Flush remaining content
    if (current) {
      const finalText = current.trim();
      if (tokenCount(finalText) > chunkSize && deeperSeps.length > 0) {
        // Final buffer still too large — recursively split
        chunks.push(...this.#recursiveSplit(finalText, deeperSeps, chunkSize, overlap, minSize));
      } else if (tokenCount(finalText) >= minSize) {
        chunks.push(finalText);
      } else if (chunks.length > 0) {
        // Append tiny tail to the last chunk to avoid losing content
        const last = chunks[chunks.length - 1]!;
        chunks[chunks.length - 1] = `${last} ${finalText}`;
      } else {
        // Only chunk — keep it even if small
        chunks.push(finalText);
      }
    }

    // If no natural split produced useful results, try the next separator
    if (chunks.length <= 1 && separators.length > 1 && deeperSeps.length > 0) {
      return this.#recursiveSplit(trimmed, deeperSeps, chunkSize, overlap, minSize);
    }

    return chunks;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
