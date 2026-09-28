import type { DocumentSource, RawDocument } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// DocumentLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all document loaders.
 *
 * Each loader handles one or more MIME types and converts the raw
 * document bytes (file, buffer, or text) into a {@link RawDocument} with
 * fully extracted text content and auto-detected metadata.
 *
 * @example
 * ```typescript
 * class MyLoader extends DocumentLoader {
 *   readonly name = 'my-loader';
 *   readonly supportedMimeTypes = ['application/x-my-type'];
 *   canLoad(source) { return source.mimeType === 'application/x-my-type'; }
 *   async load(source) { ... }
 * }
 * ```
 */
export abstract class DocumentLoader {
  /** Human-readable loader identifier. */
  abstract readonly name: string;

  /** MIME types this loader can handle. */
  abstract readonly supportedMimeTypes: string[];

  /**
   * Returns `true` when this loader can handle the given source.
   *
   * @param source - Document source to inspect.
   */
  abstract canLoad(source: DocumentSource): boolean;

  /**
   * Loads the document from `source` and extracts its text content.
   *
   * @param source - Document source to load.
   * @returns Extracted raw document with text and metadata.
   * @throws {@link ValidationError} when the source cannot be loaded.
   */
  abstract load(source: DocumentSource): Promise<RawDocument>;
}
