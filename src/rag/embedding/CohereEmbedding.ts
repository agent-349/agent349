import type { EmbeddingResult, ProviderProbe } from '../types.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import { ProviderError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input type hint passed to the Cohere embed API.
 *
 * Cohere optimises embeddings differently depending on whether the text will
 * be stored (document) or used as a query (query). Use `'search_document'`
 * when indexing and `'search_query'` at retrieval time.
 */
export type CohereInputType = 'search_document' | 'search_query' | 'classification' | 'clustering';

/**
 * Configuration accepted by {@link CohereEmbeddingProvider}.
 */
export interface CohereEmbeddingConfig {
  /** Cohere API key. */
  apiKey: string;
  /**
   * Model identifier.
   * @default 'embed-v4.0'
   */
  model?: string;
  /**
   * Input type hint forwarded to the Cohere API.
   * @default 'search_document'
   */
  inputType?: CohereInputType;
  /**
   * Base URL override (e.g. for the Cohere EU endpoint).
   * @default 'https://api.cohere.com'
   */
  baseURL?: string;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'embed-v4.0';
const DEFAULT_BASE_URL = 'https://api.cohere.com';

/** Native vector dimensions keyed by model identifier. */
const MODEL_DIMENSIONS: Record<string, number> = {
  'embed-v4.0': 1536,
  'embed-multilingual-v3.0': 1024,
  'embed-english-v3.0': 1024,
  'embed-multilingual-light-v3.0': 384,
  'embed-english-light-v3.0': 384,
};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — minimal subset of Cohere embed response
// ─────────────────────────────────────────────────────────────────────────────

interface CohereEmbedResponse {
  id: string;
  embeddings: { float: number[][] };
  meta: { billed_units: { input_tokens: number } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CohereEmbeddingProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedding provider backed by the Cohere Embed API.
 *
 * Uses the `v2/embed` endpoint with `embedding_types: ['float']`.
 * The `inputType` parameter tells Cohere whether each text is a document
 * to be indexed or a search query — use `'search_document'` when building
 * the index and `'search_query'` at retrieval time.
 *
 * @example
 * ```typescript
 * const provider = new CohereEmbeddingProvider({
 *   apiKey: process.env.COHERE_API_KEY!,
 *   model: 'embed-v4.0',
 *   inputType: 'search_document',
 * });
 *
 * const result = await provider.embed('quarterly earnings');
 * // result.vector — 1536-dimensional float array
 * ```
 */
export class CohereEmbeddingProvider extends EmbeddingProvider {
  override readonly name = 'cohere';
  override readonly model: string;

  readonly #apiKey: string;
  readonly #inputType: CohereInputType;
  readonly #baseURL: string;
  readonly #timeoutMs: number;

  constructor(config: CohereEmbeddingConfig) {
    super();
    this.model = config.model ?? DEFAULT_MODEL;
    this.#apiKey = config.apiKey;
    this.#inputType = config.inputType ?? 'search_document';
    this.#baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EmbeddingProvider implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Embeds a single string.
   *
   * @param text - Text to embed.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async embed(text: string): Promise<EmbeddingResult> {
    const [result] = await this.#callAPI([text]);
    return result!;
  }

  /**
   * Embeds multiple texts in a single API call.
   *
   * Cohere's `/v2/embed` endpoint accepts a `texts` array natively,
   * so the entire batch is sent in one HTTP request.
   *
   * @param texts - Non-empty array of strings to embed.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.#callAPI(texts);
  }

  /** @inheritdoc */
  override getDimensions(): number {
    return MODEL_DIMENSIONS[this.model] ?? 1024;
  }

  /** @inheritdoc */
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

  async #callAPI(texts: string[]): Promise<EmbeddingResult[]> {
    const startMs = Date.now();

    let raw: Response;
    try {
      raw = await fetch(`${this.#baseURL}/v2/embed`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          texts,
          model: this.model,
          input_type: this.#inputType,
          embedding_types: ['float'],
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new ProviderError('cohere', `Network error: ${String(err)}`, this.model);
    }

    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      throw new ProviderError('cohere', `HTTP ${raw.status}: ${body}`, this.model, raw.status);
    }

    const data = (await raw.json()) as CohereEmbedResponse;
    const latencyMs = Date.now() - startMs;
    const tokensPerItem = Math.round(
      (data.meta.billed_units.input_tokens ?? 0) / (texts.length || 1),
    );

    return data.embeddings.float.map((vector) => ({
      vector,
      model: this.model,
      dimensions: vector.length,
      tokensUsed: tokensPerItem,
      latencyMs,
    }));
  }
}
