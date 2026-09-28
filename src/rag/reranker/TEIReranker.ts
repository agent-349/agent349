import type { Passage, RerankResult, ProviderProbe } from '../types.js';
import { RerankerProvider } from './RerankerProvider.js';
import { ProviderError } from '../../errors/index.js';
import type { EventBus } from '../../events/EventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration accepted by {@link TEIReranker}.
 */
export interface TEIRerankerConfig {
  /**
   * Base URL of the Text Embeddings Inference server (e.g.
   * `'http://127.0.0.1:8090'`). The `/rerank` path is appended automatically.
   */
  baseUrl: string;
  /**
   * Stable label identifying the cross-encoder model served by this instance,
   * used **only** for observability/audit (reported as `RerankResult.model`).
   * It is never sent to TEI — a TEI instance serves a single model and the
   * `/rerank` protocol has no model parameter. Defaults to `'tei'`.
   */
  modelLabel?: string;
  /** Optional bearer token (sent as `Authorization: Bearer <apiKey>`). */
  apiKey?: string;
  /**
   * Extra HTTP headers (e.g. gateway routing). A header `Authorization` here
   * overrides the `apiKey`-derived bearer.
   */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /**
   * When `true`, requests TEI's raw (uncalibrated) cross-encoder logits instead
   * of the default sigmoid-normalised [0, 1] scores. Advanced use only: raw
   * scores are not comparable across models and change the meaning of any
   * downstream `minScore` threshold. Default: `false`.
   */
  rawScores?: boolean;
  /**
   * Maximum passages sent per request. When more passages are supplied they are
   * split into batches scored independently (cross-encoder scores are absolute,
   * so cross-batch results remain comparable) and merged. Omit to send all
   * passages in a single request.
   */
  maxBatchSize?: number;
  /** Maximum concurrent batch requests. Default: 2. Ignored without batching. */
  concurrency?: number;
  /** Retries on 429 / 5xx / network errors (exponential backoff). Default: 2. */
  maxRetries?: number;
  /** Optional EventBus for retry/observability events. */
  eventBus?: EventBus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants & wire types
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MODEL_LABEL = 'tei';
const BASE_BACKOFF_MS = 250;

/** One entry of the TEI `/rerank` response array. */
interface TEIRerankItem {
  index: number;
  score: number;
}

/** A batch-local scoring result mapped back to a global passage index. */
interface ScoredIndex {
  globalIndex: number;
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEIReranker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-ranker backed by a Hugging Face **Text Embeddings Inference** (TEI) server
 * running a cross-encoder reranking model.
 *
 * Sends each passage's title and content (see `scoringText`) to
 * `POST {baseUrl}/rerank` (`{ query, texts,
 * raw_scores }`) and reorders passages by the returned relevance `score`. A TEI
 * instance serves one model, so no model is sent on the wire — `modelLabel` is
 * an observability tag only.
 *
 * Cross-encoder scores are absolute (query–passage relevance), so when passages
 * are batched the per-batch results are directly comparable and merged into a
 * single global ranking before the top `topK` are selected.
 *
 * Pipeline-level fallback (on failure the search degrades to score ordering) is
 * handled by {@link RAGPipeline} and is deliberately not duplicated here.
 *
 * @example
 * ```typescript
 * const reranker = new TEIReranker({
 *   baseUrl: 'http://127.0.0.1:8090',
 *   modelLabel: 'BAAI/bge-reranker-v2-m3',
 * });
 * const result = await reranker.rerank('quarterly earnings', passages, 5);
 * ```
 */
export class TEIReranker extends RerankerProvider {
  override readonly name = 'tei';

  readonly #baseUrl: string;
  readonly #modelLabel: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #rawScores: boolean;
  readonly #maxBatchSize: number | undefined;
  readonly #concurrency: number;
  readonly #maxRetries: number;
  readonly #bus: EventBus | undefined;

  constructor(config: TEIRerankerConfig) {
    super();
    this.#baseUrl = config.baseUrl.replace(/\/$/, '');
    this.#modelLabel = config.modelLabel ?? DEFAULT_MODEL_LABEL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#rawScores = config.rawScores ?? false;
    this.#maxBatchSize =
      config.maxBatchSize !== undefined && config.maxBatchSize > 0
        ? config.maxBatchSize
        : undefined;
    this.#concurrency =
      config.concurrency !== undefined && config.concurrency > 0
        ? config.concurrency
        : DEFAULT_CONCURRENCY;
    this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#bus = config.eventBus;

    // Auth precedence: an explicit Authorization header wins over apiKey.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...config.headers,
    };
    if (
      config.apiKey !== undefined &&
      config.apiKey !== '' &&
      headers['Authorization'] === undefined
    ) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    this.#headers = headers;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RerankerProvider implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reranks `passages` via the TEI cross-encoder and returns the top `topK`.
   *
   * @param query    - Original user query.
   * @param passages - Candidate passages to rerank.
   * @param topK     - Maximum number of passages to return.
   * @throws {@link ProviderError} on network, HTTP, or malformed-response errors.
   */
  override async rerank(query: string, passages: Passage[], topK: number): Promise<RerankResult> {
    if (passages.length === 0) {
      return { passages: [], model: this.#modelLabel, latencyMs: 0, tokensUsed: 0 };
    }

    const startMs = Date.now();
    const batches = this.#buildBatches(passages);
    const scored = await this.#runBatches(query, passages, batches);

    // Merge all batches into one ranking; cross-encoder scores are comparable.
    const reranked = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ globalIndex, score }) => ({ ...passages[globalIndex]!, score }));

    return {
      passages: reranked,
      model: this.#modelLabel,
      latencyMs: Date.now() - startMs,
      tokensUsed: 0,
    };
  }

  /**
   * Verifies the TEI `/rerank` endpoint is reachable and correctly configured.
   *
   * "Unreachable", "expired key" and "model mismatch" call for different
   * operational responses, so the reason is returned rather than collapsed into
   * a boolean.
   */
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

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Splits passage indices into batches of at most `maxBatchSize` (or one batch). */
  #buildBatches(passages: Passage[]): number[][] {
    if (this.#maxBatchSize === undefined || passages.length <= this.#maxBatchSize) {
      return [passages.map((_, i) => i)];
    }
    const batches: number[][] = [];
    for (let i = 0; i < passages.length; i += this.#maxBatchSize) {
      batches.push(
        Array.from({ length: Math.min(this.#maxBatchSize, passages.length - i) }, (_, j) => i + j),
      );
    }
    return batches;
  }

  /** Runs all batches with a bounded concurrency pool and flattens the results. */
  async #runBatches(
    query: string,
    passages: Passage[],
    batches: number[][],
  ): Promise<ScoredIndex[]> {
    const results: ScoredIndex[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batchIndices = batches[cursor++]!;
        const batchScores = await this.#rerankBatch(query, passages, batchIndices);
        results.push(...batchScores);
      }
    };

    const workerCount = Math.min(this.#concurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  /** Reranks one batch and maps batch-local indices back to global passage indices. */
  async #rerankBatch(
    query: string,
    passages: Passage[],
    batchIndices: number[],
  ): Promise<ScoredIndex[]> {
    const texts = batchIndices.map((i) => this.scoringText(passages[i]!));
    const items = await this.#requestWithRetry(query, texts);

    const scored: ScoredIndex[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      // Strict validation: index in range, unique, finite score.
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= batchIndices.length ||
        seen.has(item.index) ||
        typeof item.score !== 'number' ||
        !Number.isFinite(item.score)
      ) {
        continue;
      }
      seen.add(item.index);
      scored.push({ globalIndex: batchIndices[item.index]!, score: item.score });
    }
    return scored;
  }

  /**
   * Performs the `/rerank` POST with retry/backoff on 429 / 5xx / network
   * errors. Non-retriable HTTP errors and malformed responses raise a
   * {@link ProviderError}.
   */
  async #requestWithRetry(query: string, texts: string[]): Promise<TEIRerankItem[]> {
    let attempt = 0;
    // Total tries = maxRetries + 1.
    for (;;) {
      try {
        return await this.#request(query, texts);
      } catch (err) {
        const retriable = err instanceof RetriableTEIError;
        if (!retriable || attempt >= this.#maxRetries) {
          if (err instanceof RetriableTEIError) {
            throw new ProviderError('tei', err.message, this.#modelLabel, err.status);
          }
          throw err;
        }
        const delayMs = err.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt;
        this.#bus?.emit('rag.rerank.tei.retry', {
          attempt: attempt + 1,
          delayMs,
          status: err.status,
        });
        await sleep(delayMs);
        attempt++;
      }
    }
  }

  /** Single `/rerank` request. Throws {@link RetriableTEIError} on transient failures. */
  async #request(query: string, texts: string[]): Promise<TEIRerankItem[]> {
    let raw: Response;
    try {
      raw = await fetch(`${this.#baseUrl}/rerank`, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify({ query, texts, raw_scores: this.#rawScores }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // Network/timeout errors are transient.
      throw new RetriableTEIError(`Network error: ${String(err)}`, undefined, undefined);
    }

    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      if (raw.status === 429 || raw.status >= 500) {
        throw new RetriableTEIError(
          `HTTP ${raw.status}: ${body}`,
          raw.status,
          parseRetryAfterMs(raw.headers.get('retry-after')),
        );
      }
      throw new ProviderError('tei', `HTTP ${raw.status}: ${body}`, this.#modelLabel, raw.status);
    }

    const data: unknown = await raw.json().catch(() => undefined);
    if (!Array.isArray(data)) {
      throw new ProviderError(
        'tei',
        'Malformed /rerank response: expected a JSON array',
        this.#modelLabel,
      );
    }
    return data as TEIRerankItem[];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal error & utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Marks a transient TEI failure eligible for retry. Never surfaced to callers. */
class RetriableTEIError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = 'RetriableTEIError';
  }
}

/** Parses a `Retry-After` header (seconds) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
