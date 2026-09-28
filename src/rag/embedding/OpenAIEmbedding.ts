import OpenAI, { AzureOpenAI } from 'openai';
import type { EmbeddingResult, ProviderProbe } from '../types.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import { ProviderError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration accepted by {@link OpenAIEmbeddingProvider}.
 *
 * When `apiVersion` is set the provider automatically uses the `AzureOpenAI`
 * client and treats `baseURL` as the Azure resource endpoint.
 */
export interface OpenAIEmbeddingConfig {
  /** API key — OpenAI secret key or Azure API key. */
  apiKey: string;
  /**
   * Embedding model identifier.
   * @default 'text-embedding-3-small'
   */
  model?: string;
  /**
   * Override the output vector dimensions.
   *
   * Only supported by `text-embedding-3-small` and `text-embedding-3-large`
   * (the Matryoshka family). Reducing dimensions trades recall for lower
   * storage and faster retrieval. Omit to use the model's native dimension.
   */
  dimensions?: number;
  /**
   * Base URL override (proxy or Azure resource endpoint).
   * For Azure: `https://my-resource.openai.azure.com`.
   */
  baseURL?: string;
  /**
   * Azure API version (e.g. `'2024-02-01'`).
   * When present, `AzureOpenAI` is used automatically.
   */
  apiVersion?: string;
  /** OpenAI organisation ID (ignored for Azure). */
  organization?: string;
  /** Maximum automatic retries on transient failures. Default: 2. */
  maxRetries?: number;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'text-embedding-3-small';

/** Native vector dimensions keyed by model identifier. */
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIEmbeddingProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedding provider backed by the OpenAI Embeddings API.
 *
 * Supports all current OpenAI embedding models and Azure OpenAI deployments.
 * The `text-embedding-3-*` models additionally support truncating vectors to
 * fewer dimensions via the `dimensions` config option (Matryoshka
 * representation learning).
 *
 * - **Single embed**: `POST /v1/embeddings` with `input: string`.
 * - **Batch embed**: single `POST /v1/embeddings` with `input: string[]` — more
 *   efficient than iterating `embed()`.
 *
 * @example
 * ```typescript
 * const provider = new OpenAIEmbeddingProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'text-embedding-3-small',
 * });
 *
 * const result = await provider.embed('What is the balance of account 1001?');
 * // result.vector — 1536-dimensional float array
 * // result.tokensUsed — prompt token count
 * ```
 */
export class OpenAIEmbeddingProvider extends EmbeddingProvider {
  override readonly name = 'openai';
  override readonly model: string;

  readonly #client: OpenAI;
  readonly #dimensions: number | undefined;

  /**
   * @param config - Provider configuration.
   * @param client - Optional pre-constructed OpenAI/AzureOpenAI client.
   *                 Primarily used for testing — omit in production.
   */
  constructor(config: OpenAIEmbeddingConfig, client?: OpenAI) {
    super();
    this.model = config.model ?? DEFAULT_MODEL;
    this.#dimensions = config.dimensions;
    this.#client = client ?? OpenAIEmbeddingProvider.#createClient(config);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EmbeddingProvider implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Embeds a single string.
   *
   * @param text - Text to embed. Must not be empty.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async embed(text: string): Promise<EmbeddingResult> {
    const startMs = Date.now();
    let raw: OpenAI.CreateEmbeddingResponse;

    try {
      raw = await this.#client.embeddings.create({
        model: this.model,
        input: text,
        ...(this.#dimensions !== undefined && { dimensions: this.#dimensions }),
      });
    } catch (err) {
      throw this.#wrapError(err);
    }

    const item = raw.data[0]!;
    const vector = item.embedding;
    return {
      vector,
      model: raw.model,
      dimensions: vector.length,
      tokensUsed: raw.usage.prompt_tokens,
      latencyMs: Date.now() - startMs,
    };
  }

  /**
   * Embeds multiple texts in a single API call.
   *
   * Results are returned in the same order as the input `texts` array.
   *
   * @param texts - Non-empty array of strings to embed.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const startMs = Date.now();
    let raw: OpenAI.CreateEmbeddingResponse;

    try {
      raw = await this.#client.embeddings.create({
        model: this.model,
        input: texts,
        ...(this.#dimensions !== undefined && { dimensions: this.#dimensions }),
      });
    } catch (err) {
      throw this.#wrapError(err);
    }

    const latencyMs = Date.now() - startMs;
    // Sort by index to guarantee input-order output.
    const sorted = [...raw.data].sort((a, b) => a.index - b.index);
    // Distribute token usage evenly across the batch (OpenAI only gives total).
    const tokensPerItem = Math.round(raw.usage.prompt_tokens / (sorted.length || 1));

    return sorted.map((item) => ({
      vector: item.embedding,
      model: raw.model,
      dimensions: item.embedding.length,
      tokensUsed: tokensPerItem,
      latencyMs,
    }));
  }

  /**
   * Returns the number of vector dimensions produced by this provider.
   *
   * If a custom `dimensions` override was configured, that value is returned.
   * Otherwise falls back to the model's native dimension count (or 1536 for
   * unknown models as a safe default matching the ada-002 family).
   */
  override getDimensions(): number {
    if (this.#dimensions !== undefined) return this.#dimensions;
    return MODEL_DIMENSIONS[this.model] ?? 1536;
  }

  /**
   * Validates connectivity and credentials by embedding a short probe string.
   * Reports the failure reason instead of throwing.
   */
  override async validate(): Promise<ProviderProbe> {
    try {
      await this.embed('test');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #wrapError(err: unknown): unknown {
    if (err instanceof OpenAI.APIError) {
      return new ProviderError('openai', err.message, this.model, err.status ?? undefined);
    }
    return err;
  }

  static #createClient(config: OpenAIEmbeddingConfig): OpenAI {
    const shared = {
      apiKey: config.apiKey,
      ...(config.maxRetries !== undefined && { maxRetries: config.maxRetries }),
      ...(config.timeoutMs !== undefined && { timeout: config.timeoutMs }),
    };

    if (config.apiVersion !== undefined) {
      return new AzureOpenAI({
        ...shared,
        endpoint: config.baseURL,
        apiVersion: config.apiVersion,
      });
    }

    return new OpenAI({
      ...shared,
      ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
      ...(config.organization !== undefined && { organization: config.organization }),
    });
  }
}
