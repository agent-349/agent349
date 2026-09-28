import type { Passage, RerankResult, ProviderProbe } from '../types.js';
import { RerankerProvider } from './RerankerProvider.js';
import { ProviderError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration accepted by {@link CohereReranker}.
 */
export interface CohereRerankerConfig {
  /** Cohere API key. */
  apiKey: string;
  /**
   * Reranker model identifier.
   * @default 'rerank-v3.5'
   */
  model?: string;
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

const DEFAULT_MODEL = 'rerank-v3.5';
const DEFAULT_BASE_URL = 'https://api.cohere.com';

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — minimal subset of Cohere rerank response
// ─────────────────────────────────────────────────────────────────────────────

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  id: string;
  results: CohereRerankResult[];
  meta: { billed_units: { search_units: number } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CohereReranker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-ranker backed by the Cohere Rerank API.
 *
 * Sends each passage's title and content (see `scoringText`) to
 * `POST /v2/rerank` and uses the returned
 * `relevance_score` to reorder passages. Cohere's rerankers are purpose-built
 * for this task and typically produce better results than LLM scoring at a
 * fraction of the latency (~100 ms vs 1–3 s).
 *
 * @example
 * ```typescript
 * const reranker = new CohereReranker({
 *   apiKey: process.env.COHERE_API_KEY!,
 *   model: 'rerank-v3.5',
 * });
 *
 * const result = await reranker.rerank('quarterly earnings', passages, 5);
 * // result.passages — sorted by Cohere relevance_score descending
 * ```
 */
export class CohereReranker extends RerankerProvider {
  override readonly name = 'cohere';

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseURL: string;
  readonly #timeoutMs: number;

  constructor(config: CohereRerankerConfig) {
    super();
    this.#apiKey = config.apiKey;
    this.#model = config.model ?? DEFAULT_MODEL;
    this.#baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RerankerProvider implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reranks `passages` using Cohere's dedicated rerank model.
   *
   * All passage text is sent in a single API call. The response scores are
   * normalised to [0, 1] by Cohere, so no post-processing is needed.
   *
   * @param query    - Original user query.
   * @param passages - Candidate passages to rerank.
   * @param topK     - Maximum number of passages to return.
   * @throws {@link ProviderError} on API or network errors.
   */
  override async rerank(query: string, passages: Passage[], topK: number): Promise<RerankResult> {
    if (passages.length === 0) {
      return { passages: [], model: this.#model, latencyMs: 0, tokensUsed: 0 };
    }

    const startMs = Date.now();

    let raw: Response;
    try {
      raw = await fetch(`${this.#baseURL}/v2/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query,
          documents: passages.map((p) => this.scoringText(p)),
          model: this.#model,
          top_n: topK,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new ProviderError('cohere', `Network error: ${String(err)}`, this.#model);
    }

    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      throw new ProviderError('cohere', `HTTP ${raw.status}: ${body}`, this.#model, raw.status);
    }

    const data = (await raw.json()) as CohereRerankResponse;
    const latencyMs = Date.now() - startMs;

    const reranked = data.results.map((r) => ({
      ...passages[r.index]!,
      score: r.relevance_score,
    }));

    return {
      passages: reranked,
      model: this.#model,
      latencyMs,
      tokensUsed: data.meta.billed_units.search_units,
    };
  }

  /** @inheritdoc */
  override async validate(): Promise<ProviderProbe> {
    try {
      await this.rerank(
        'test',
        [{ id: 'p', content: 'test', score: 1, collection: 'test', metadata: { documentId: 'p' } }],
        1,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
