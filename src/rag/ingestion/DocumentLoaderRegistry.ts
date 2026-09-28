import { extname } from 'node:path';
import type { DocumentSource, RawDocument } from './types.js';
import { EXTENSION_TO_MIME } from './types.js';
import type { DocumentLoader } from './loaders/DocumentLoader.js';
import { ValidationError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// DocumentLoaderRegistry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry of document loaders with automatic MIME type detection.
 *
 * Maintains an ordered list of loaders. When `load()` is called, the
 * registry resolves the MIME type (from `source.mimeType` or by mapping
 * the file extension via {@link EXTENSION_TO_MIME}), then delegates to the
 * first registered loader that reports `canLoad(source) === true`.
 *
 * @example
 * ```typescript
 * const registry = new DocumentLoaderRegistry();
 * registry.register(new PlainTextLoader());
 * registry.register(new MarkdownLoader());
 *
 * const raw = await registry.load({ type: 'file', path: './README.md' });
 * ```
 */
export class DocumentLoaderRegistry {
  readonly #loaders: DocumentLoader[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a loader.
   *
   * Loaders are checked in registration order — register more specific loaders
   * before generic fallbacks.
   *
   * @param loader - Loader to add.
   */
  register(loader: DocumentLoader): void {
    this.#loaders.push(loader);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Loads a document by auto-detecting its type and delegating to the
   * appropriate registered loader.
   *
   * @param source - Document source descriptor.
   * @returns Extracted {@link RawDocument}.
   * @throws {@link ValidationError} if no loader can handle the source MIME type.
   */
  async load(source: DocumentSource): Promise<RawDocument> {
    const resolved = this.#resolveSource(source);
    const loader = this.#loaders.find((l) => l.canLoad(resolved));

    if (!loader) {
      throw new ValidationError(
        'source.mimeType',
        `No loader registered for MIME type '${resolved.mimeType ?? 'unknown'}'. ` +
          `Supported types: ${this.supportedTypes().join(', ')}`,
        resolved.mimeType,
      );
    }

    return loader.load(resolved);
  }

  /**
   * Returns the loader registered for a given MIME type, if any.
   *
   * @param mimeType - MIME type to look up.
   */
  getLoader(mimeType: string): DocumentLoader | undefined {
    return this.#loaders.find((l) => l.supportedMimeTypes.includes(mimeType));
  }

  /**
   * Returns all MIME types currently handled by registered loaders.
   */
  supportedTypes(): string[] {
    return [...new Set(this.#loaders.flatMap((l) => l.supportedMimeTypes))];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolves the MIME type of a source, mutating a shallow copy.
   *
   * Detection priority:
   * 1. `source.mimeType` if already set
   * 2. File extension lookup via {@link EXTENSION_TO_MIME}
   * 3. Fallback to `text/plain` for `type='text'` sources
   */
  #resolveSource(source: DocumentSource): DocumentSource {
    if (source.mimeType) return source;

    let mimeType: string | undefined;

    if (source.path) {
      const ext = extname(source.path).toLowerCase();
      mimeType = EXTENSION_TO_MIME[ext];
    }

    if (!mimeType && source.type === 'text') {
      mimeType = 'text/plain';
    }

    if (mimeType !== undefined) {
      return { ...source, mimeType };
    }
    return source;
  }
}
