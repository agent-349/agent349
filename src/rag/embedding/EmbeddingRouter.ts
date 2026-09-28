import type { EmbeddingResult } from '../types.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import { ProviderError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata snapshot for a registered embedding provider.
 * Returned by {@link EmbeddingRouter.getProviderInfo}.
 */
export interface EmbeddingProviderInfo {
  /** Provider identifier (e.g. `'openai'`, `'cohere'`). */
  name: string;
  /** Active model identifier (e.g. `'text-embedding-3-small'`). */
  model: string;
  /** Vector dimensions produced by this provider. */
  dimensions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// EmbeddingRouter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Multi-provider router for embedding calls.
 *
 * The router dispatches `embed` / `embedBatch` calls to the correct
 * {@link EmbeddingProvider} based on the `providerName` argument.
 *
 * **Critical consistency rule:** every document collection must use a single
 * provider + model combination. The router enforces nothing about this; it is
 * the caller's (typically {@link RAGPipeline}'s) responsibility to pass the
 * correct `providerName` for each collection.
 *
 * @example
 * ```typescript
 * const router = new EmbeddingRouter(
 *   new Map([['openai', new OpenAIEmbeddingProvider({ apiKey: '...' })]])
 * );
 *
 * const result = await router.embed('quarterly earnings report', 'openai');
 * // result.vector — dense float array from text-embedding-3-small
 * ```
 */
export class EmbeddingRouter {
  readonly #providers: Map<string, EmbeddingProvider>;

  /**
   * @param providers - Initial provider map, keyed by provider name.
   *                    Defaults to an empty map; add providers via
   *                    {@link registerProvider}.
   */
  constructor(providers: Map<string, EmbeddingProvider> = new Map()) {
    this.#providers = new Map(providers);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a provider (or replaces an existing registration with the same name).
   *
   * @param provider - The embedding provider to register.
   */
  registerProvider(provider: EmbeddingProvider): void {
    this.#providers.set(provider.name, provider);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Embedding API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Embeds a single string using the named provider.
   *
   * @param text         - Input text to embed.
   * @param providerName - Name of the registered provider to use.
   * @returns {@link EmbeddingResult} from the provider.
   * @throws {@link ProviderError} if the provider is not registered, or if the
   *                               underlying provider call fails.
   */
  async embed(text: string, providerName: string): Promise<EmbeddingResult> {
    return this.#getProvider(providerName).embed(text);
  }

  /**
   * Embeds multiple texts using the named provider in a single batch call.
   *
   * @param texts        - Array of input strings to embed.
   * @param providerName - Name of the registered provider to use.
   * @returns Array of {@link EmbeddingResult}s in the same order as `texts`.
   * @throws {@link ProviderError} if the provider is not registered, or if the
   *                               underlying provider call fails.
   */
  async embedBatch(texts: string[], providerName: string): Promise<EmbeddingResult[]> {
    return this.#getProvider(providerName).embedBatch(texts);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Introspection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns metadata for the named provider.
   *
   * @param name - Provider name to look up.
   * @throws {@link ProviderError} if no provider with that name is registered.
   */
  getProviderInfo(name: string): EmbeddingProviderInfo {
    const provider = this.#getProvider(name);
    return {
      name: provider.name,
      model: provider.model,
      dimensions: provider.getDimensions(),
    };
  }

  /**
   * Returns the names of all registered providers.
   */
  listProviders(): string[] {
    return [...this.#providers.keys()];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #getProvider(name: string): EmbeddingProvider {
    const provider = this.#providers.get(name);
    if (provider === undefined) {
      throw new ProviderError(name, `Embedding provider '${name}' is not registered`);
    }
    return provider;
  }
}
