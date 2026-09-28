import type { Passage, RerankResult, ProviderProbe } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// RerankerProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all re-ranking providers in the RAG module.
 *
 * Re-rankers receive the candidate passages returned by the vector store and
 * reorder them by their semantic relevance to the original query. The result
 * is a smaller, higher-quality set of passages passed to the LLM context.
 *
 * | Provider                | Class            | Latency   | Quality   |
 * |-------------------------|------------------|-----------|-----------|
 * | Cohere Rerank           | `CohereReranker` | ~100 ms   | High      |
 * | Cross-encoder via TEI   | `TEIReranker`    | ~100–300 ms | High    |
 * | LLM-based               | `LLMReranker`    | ~1–3 s    | Very high |
 *
 * A cross-encoder is a *model*; **TEI** (Hugging Face Text Embeddings Inference)
 * is the server that hosts it, consumed by {@link TEIReranker}.
 *
 * @example
 * ```typescript
 * class MyReranker extends RerankerProvider {
 *   readonly name = 'my-reranker';
 *   async rerank(query, passages, topK) { ... }
 *   async validate() { return { ok: true }; }
 * }
 * ```
 */
export abstract class RerankerProvider {
  /** Human-readable provider identifier (e.g. `'cohere'`, `'llm'`). */
  abstract readonly name: string;

  /**
   * Reorders `passages` by their relevance to `query` and returns the top `topK`.
   *
   * Implementations may call an external API (Cohere, a local cross-encoder) or
   * use an LLM to assign relevance scores. The returned passages must have their
   * `score` field updated to reflect the new relevance ranking.
   *
   * @param query    - The original user query.
   * @param passages - Candidate passages to rerank (pre-filtered by the vector store).
   * @param topK     - Maximum number of passages to return.
   * @returns {@link RerankResult} containing the reordered passages and latency metrics.
   * @throws {@link ProviderError} on API errors or connectivity issues.
   */
  abstract rerank(query: string, passages: Passage[], topK: number): Promise<RerankResult>;

  /**
   * Verifies that the provider is reachable and correctly configured.
   *
   * Implementations must not throw: a failed probe is reported as
   * `{ ok: false, error }` so callers can log *why* the provider is unusable.
   *
   * @returns `{ ok: true }` when operational, `{ ok: false, error }` otherwise.
   */
  abstract validate(): Promise<ProviderProbe>;

  /**
   * Builds the text a re-ranker scores for a passage: the document title
   * followed by the chunk content.
   *
   * A chunk arrives at the re-ranker stripped of the document it belongs to,
   * and a cross-encoder judges whether *that text* answers the query. When the
   * document type or subject lives in the file name rather than the body —
   * routine for scanned or exported corporate documents — the passage never
   * states what it is, and a query naming the document by its type scores near
   * zero. Measured on a real corpus, asking "do we have a covid circular?"
   * against circulars whose body never uses the word "circular" scored 0.019
   * on content alone and 0.648 with the title prepended, moving from zero
   * passages above a 0.1 threshold to five.
   *
   * The title is the whole win: adding category or ingestion date moved scores
   * by less than 0.03 either way, and every extra token competes with the real
   * content for the model's attention, so the prefix is deliberately minimal.
   *
   * Retrieval already searches the title and the synthesis prompt already
   * receives it — the re-ranker was the only stage judging passages blind.
   *
   * Implementations must score this text but **return the original passages**:
   * a rewritten `content` would leak the prefix into UI snippets and into the
   * LLM context.
   *
   * @param passage - The passage to score.
   * @returns Title and content, or the content alone when no title is known.
   */
  protected scoringText(passage: Passage): string {
    const title = passage.metadata.title;
    return title !== undefined && title !== '' ? `${title}\n\n${passage.content}` : passage.content;
  }
}
