import { SDKError } from './SDKError.js';

// ─────────────────────────────────────────────────────────────────────────────
// RerankerError
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage of the re-ranking call at which the failure occurred.
 *
 * - `'request'` — the re-ranker could not be reached or returned an error
 *   (network failure, HTTP error, timeout, provider rejection).
 * - `'parse'`   — the re-ranker responded, but its output could not be
 *   interpreted as relevance scores (LLM-based re-rankers only).
 */
export type RerankerFailureStage = 'request' | 'parse';

/**
 * Thrown when a re-ranker was required for a query but could not produce a
 * ranking.
 *
 * Re-ranking is not a cosmetic step: it is the only stage that assigns
 * *absolute* relevance scores, and therefore the only one that makes a
 * `minScore` threshold meaningful. Retrieval scores are min-max normalised per
 * collection, so the best candidate always scores 1.0 — with or without a real
 * match. Silently continuing without the re-ranker turns "no relevant results"
 * into "the five nearest neighbours", which reads as a confident answer built on
 * irrelevant context.
 *
 * Under `rerankPolicy: 'require'` (the default) the pipeline therefore surfaces
 * this error instead of degrading. Callers that genuinely prefer approximate
 * ordering to an error can opt in with `rerankPolicy: 'degrade'`.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await orch.rag.search({ query, collections: ['docs'] }, ctx);
 * } catch (err) {
 *   if (err instanceof RerankerError) {
 *     // Relevance cannot be guaranteed — surface the degradation, do not hide it.
 *   }
 * }
 * ```
 */
export class RerankerError extends SDKError {
  override readonly name = 'RerankerError';

  /** Name of the re-ranker provider that failed (e.g. `'tei'`, `'llm'`, `'cohere'`). */
  readonly provider: string;

  /** Stage at which the failure occurred. */
  readonly stage: RerankerFailureStage;

  /**
   * @param provider - Provider name reported by the {@link RerankerProvider}.
   * @param stage    - Whether the call itself failed or its response was unusable.
   * @param reason   - Human-readable description of the failure.
   * @param options  - Standard `ErrorOptions` (forward the original `cause`).
   */
  constructor(
    provider: string,
    stage: RerankerFailureStage,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `Re-ranker '${provider}' failed at the ${stage} stage: ${reason}. ` +
        `Relevance filtering cannot be applied, so the query was not answered. ` +
        `Set rag.retrieval.rerankPolicy to 'degrade' to fall back to retrieval order instead.`,
      'RERANKER_UNAVAILABLE',
      options,
    );
    this.provider = provider;
    this.stage = stage;
  }
}
