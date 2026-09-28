import type { RawDocument, TextChunk, ChunkingConfig } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// ChunkingStrategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all text chunking strategies.
 *
 * A chunking strategy splits a {@link RawDocument} into an ordered list of
 * {@link TextChunk}s suitable for embedding and indexing.
 *
 * @example
 * ```typescript
 * class MyChunker extends ChunkingStrategy {
 *   readonly name = 'my-chunker';
 *   chunk(doc, config) { ... }
 * }
 * ```
 */
export abstract class ChunkingStrategy {
  /** Identifier for this strategy. */
  abstract readonly name: string;

  /**
   * Splits a raw document into text chunks.
   *
   * @param document - Source document to chunk.
   * @param config   - Chunking configuration.
   * @returns Ordered array of text chunks.
   */
  abstract chunk(document: RawDocument, config: ChunkingConfig): TextChunk[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (module-internal, exported for chunker implementations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimates token count for a string.
 *
 * Uses the rule of thumb that ~4 characters = 1 token (Latin scripts).
 * Suitable for chunking decisions; not meant for billing calculations.
 */
export function tokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns the last `n` tokens (approximately) from a string by slicing
 * from the end. Used to construct the overlap prefix for the next chunk.
 */
export function getLastNTokens(text: string, n: number): string {
  const approxChars = n * 4;
  if (text.length <= approxChars) return text;
  // Try to break at a word boundary
  const slice = text.slice(text.length - approxChars);
  const firstSpace = slice.indexOf(' ');
  return firstSpace > 0 ? slice.slice(firstSpace + 1) : slice;
}

/**
 * Returns the first `n` tokens (approximately) from a string.
 * Used to build the overlap suffix carried from the previous chunk.
 */
export function getFirstNTokens(text: string, n: number): string {
  const approxChars = n * 4;
  if (text.length <= approxChars) return text;
  const slice = text.slice(0, approxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}
