import type { EmbeddingResult, ProviderProbe } from '../types.js';

/**
 * Abstract base class for all embedding providers in the RAG module.
 *
 * Concrete implementations translate the SDK's normalised {@link EmbeddingResult}
 * to and from the provider-specific wire format:
 *
 * | Provider | Class | Models |
 * |----------|-------|--------|
 * | OpenAI   | `OpenAIEmbeddingProvider` | text-embedding-3-small/large |
 * | Cohere   | `CohereEmbeddingProvider` | embed-v4.0, embed-multilingual-v3.0 |
 * | Ollama   | `OllamaEmbeddingProvider` | nomic-embed-text, mxbai-embed-large |
 *
 * **Critical:** Every collection must use a single, consistent embedding model.
 * Mixing models across documents in the same collection produces incorrect
 * similarity scores.
 *
 * @example
 * ```typescript
 * class MyEmbeddingProvider extends EmbeddingProvider {
 *   readonly name = 'my-provider';
 *   readonly model = 'my-model-v1';
 *   getDimensions() { return 768; }
 *   async embed(text) { ... }
 *   async embedBatch(texts) { ... }
 *   async validate() { ... }  // → { ok: true } | { ok: false, error }
 * }
 * ```
 */
export abstract class EmbeddingProvider {
  /** Human-readable provider identifier (e.g. `'openai'`, `'cohere'`, `'ollama'`). */
  abstract readonly name: string;

  /** Active model identifier (e.g. `'text-embedding-3-small'`). */
  abstract readonly model: string;

  /**
   * Embeds a single text string and returns the dense vector representation.
   *
   * @param text - The input text to embed.
   * @returns {@link EmbeddingResult} containing the vector, dimension count,
   *          token usage, and latency.
   * @throws {@link ProviderError} on API errors or connectivity issues.
   */
  abstract embed(text: string): Promise<EmbeddingResult>;

  /**
   * Embeds multiple texts in a single batch request.
   *
   * Where possible implementations use a single provider API call for the whole
   * batch (more efficient than calling `embed()` in a loop).
   *
   * @param texts - Array of input strings to embed. Must be non-empty.
   * @returns Array of {@link EmbeddingResult}s in the same order as `texts`.
   * @throws {@link ProviderError} on API errors or connectivity issues.
   */
  abstract embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

  /**
   * Returns the number of dimensions in vectors produced by this provider.
   *
   * This value must remain stable for the lifetime of a collection — changing
   * the model or dimension configuration invalidates all stored vectors.
   */
  abstract getDimensions(): number;

  /**
   * Verifies that the provider is reachable and correctly configured.
   *
   * Implementations must not throw: a failed probe is reported as
   * `{ ok: false, error }` so callers can log *why* the provider is unusable.
   *
   * @returns `{ ok: true }` when operational, `{ ok: false, error }` otherwise.
   */
  abstract validate(): Promise<ProviderProbe>;
}
