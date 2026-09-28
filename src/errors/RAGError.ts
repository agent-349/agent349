import { SDKError } from './SDKError.js';

// ─────────────────────────────────────────────────────────────────────────────
// RAGError
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the RAG pipeline when a configuration or runtime constraint is
 * violated — for example, querying collections that use incompatible embedding
 * providers, or failing to resolve the embedding model for a collection.
 *
 * @example
 * ```typescript
 * throw new RAGError(
 *   'Multi-collection queries require a uniform embedding provider. Found: openai, cohere.',
 *   'embeddingProvider',
 * );
 * ```
 */
export class RAGError extends SDKError {
  override readonly name = 'RAGError';

  /**
   * Dot-notation field name that caused the error
   * (e.g. `'embeddingProvider'`, `'embeddingModel'`).
   */
  readonly field: string;

  /**
   * @param message - Human-readable description of the problem.
   * @param field   - Dot-notation path of the invalid or missing field.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(message: string, field: string, options?: ErrorOptions) {
    super(message, 'RAG_ERROR', options);
    this.field = field;
  }
}
