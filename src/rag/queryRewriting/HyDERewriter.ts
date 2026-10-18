import type { LLMMessage, LLMRequest } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import { QueryRewriter, rewriteReasoningEffort } from './QueryRewriter.js';
import type { QueryRewriteFallbackReason, QueryRewriterOptions } from './QueryRewriter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a document generation assistant. Given a question, generate a short hypothetical document passage (2-4 sentences) that would be a perfect answer to the question.

Rules:
- Write in the style of a factual document or knowledge base article.
- Do not include phrases like "According to..." or "In this document...".
- Return ONLY the passage. No intro, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────────
// HyDERewriter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HyDE (Hypothetical Document Embedding) rewriter.
 *
 * Instead of embedding the raw query directly, generates a short hypothetical
 * document passage that would answer the query, then uses that passage as the
 * search query. This closes the vocabulary mismatch between a question and
 * the indexed answer-style documents.
 *
 * **Trade-off:** adds one LLM call per query but significantly improves recall
 * for abstract, paraphrased, or open-ended queries.
 *
 * @example
 * ```
 * Query: "vacation days policy"
 * HyDE output:
 *   "Employees are entitled to 15 business days of paid vacation per year.
 *    Vacation must be requested at least 15 days in advance..."
 * → This passage is embedded and used for similarity search.
 * ```
 */
export class HyDERewriter extends QueryRewriter {
  override readonly name = 'hyde';

  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #options: QueryRewriterOptions;

  /**
   * @param router   - LLM router instance.
   * @param provider - Provider name registered in the router (e.g. `'claude'`).
   * @param model    - Model identifier (e.g. `'claude-haiku-4-5'`).
   * @param options  - Reasoning effort (default `'minimal'`) and the bus for fallback events.
   */
  constructor(
    router: LLMRouter,
    provider: string,
    model: string,
    options: QueryRewriterOptions = {},
  ) {
    super();
    this.#router = router;
    this.#provider = provider;
    this.#model = model;
    this.#options = options;
  }

  /**
   * Generates a hypothetical document passage for the query.
   *
   * Returns the original query unchanged when:
   * - The LLM call fails (graceful degradation).
   * - The LLM returns a response that is too short to be meaningful.
   *
   * @param query - Original user query. Conversation history is ignored by HyDE.
   */
  override async rewrite(query: string, _conversationHistory?: LLMMessage[]): Promise<string> {
    const request: LLMRequest = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: query }],
      model: this.#model,
      temperature: 0.3, // Slight variability for document diversity
      maxTokens: 200,
      ...rewriteReasoningEffort(this.#options),
    };

    try {
      const response = await this.#router.call(request, this.#provider);
      const hypothetical = typeof response.content === 'string' ? response.content.trim() : '';

      // A HyDE passage shorter than ~20 chars is probably degenerate — fall back.
      if (hypothetical.length === 0) return this.#fallback(query, 'empty', response.stopReason);
      if (hypothetical.length <= 20) return this.#fallback(query, 'too_short', response.stopReason);
      return hypothetical;
    } catch (err) {
      // Degrade gracefully — use original query if generation fails.
      return this.#fallback(
        query,
        'error',
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  #fallback(
    query: string,
    reason: QueryRewriteFallbackReason,
    stopReason?: string,
    error?: string,
  ): string {
    this.#options.eventBus?.emit('rag.query_rewrite.fallback', {
      strategy: this.name,
      provider: this.#provider,
      model: this.#model,
      reason,
      ...(stopReason !== undefined && { stopReason }),
      ...(error !== undefined && { error }),
    });
    return query;
  }
}
