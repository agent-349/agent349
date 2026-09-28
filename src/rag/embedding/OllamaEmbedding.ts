import type { EmbeddingResult, ProviderProbe } from '../types.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import { ProviderError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration accepted by {@link OllamaEmbeddingProvider}.
 */
export interface OllamaEmbeddingConfig {
  /**
   * Model identifier — must match a model pulled in Ollama.
   * @default 'nomic-embed-text'
   */
  model?: string;
  /**
   * Ollama server base URL.
   * @default 'http://localhost:11434'
   */
  baseURL?: string;
  /** Request timeout in milliseconds. Default: 60 000. */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Known native dimensions for popular Ollama embedding models. */
const MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'bge-m3': 1024,
};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — Ollama /api/embed response
// ─────────────────────────────────────────────────────────────────────────────

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
  prompt_eval_count?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// OllamaEmbeddingProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedding provider backed by a local Ollama server.
 *
 * Uses the `POST /api/embed` endpoint introduced in Ollama ≥ 0.3 which
 * accepts an `input` array and returns all vectors in one response.
 *
 * **Typical local models:**
 * - `nomic-embed-text` — 768 dims, good general purpose
 * - `mxbai-embed-large` — 1024 dims, higher quality
 * - `bge-m3` — 1024 dims, multilingual
 *
 * @example
 * ```typescript
 * const provider = new OllamaEmbeddingProvider({
 *   model: 'nomic-embed-text',
 *   baseURL: 'http://localhost:11434',
 * });
 *
 * const result = await provider.embed('What is the balance?');
 * // result.vector — 768-dimensional float array
 * ```
 */
export class OllamaEmbeddingProvider extends EmbeddingProvider {
  override readonly name = 'ollama';
  override readonly model: string;

  readonly #baseURL: string;
  readonly #timeoutMs: number;

  constructor(config: OllamaEmbeddingConfig = {}) {
    super();
    this.model = config.model ?? DEFAULT_MODEL;
    this.#baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? 60_000;
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
   * Embeds multiple texts using a single `/api/embed` call.
   *
   * @param texts - Non-empty array of strings to embed.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.#callAPI(texts);
  }

  /** @inheritdoc */
  override getDimensions(): number {
    return MODEL_DIMENSIONS[this.model] ?? 768;
  }

  /**
   * Validates that the Ollama server is reachable and the model is available.
   *
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

  async #callAPI(texts: string[]): Promise<EmbeddingResult[]> {
    const startMs = Date.now();

    let raw: Response;
    try {
      raw = await fetch(`${this.#baseURL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new ProviderError('ollama', `Network error: ${String(err)}`, this.model);
    }

    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      throw new ProviderError('ollama', `HTTP ${raw.status}: ${body}`, this.model, raw.status);
    }

    const data = (await raw.json()) as OllamaEmbedResponse;
    const latencyMs = Date.now() - startMs;
    const tokensUsed = Math.round((data.prompt_eval_count ?? 0) / (texts.length || 1));

    return data.embeddings.map((vector) => ({
      vector,
      model: data.model,
      dimensions: vector.length,
      tokensUsed,
      latencyMs,
    }));
  }
}
