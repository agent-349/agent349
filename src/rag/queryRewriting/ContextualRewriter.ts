import type { LLMMessage, LLMRequest } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import { QueryRewriter, rewriteReasoningEffort } from './QueryRewriter.js';
import type { QueryRewriteFallbackReason, QueryRewriterOptions } from './QueryRewriter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a query rewriting assistant. Your task is to rewrite a search query to be self-contained, resolving any ambiguities, pronouns, or implicit references using the conversation history.

Rules:
- Return ONLY the rewritten query. No explanation, no quotes, no prefix.
- If the query is already self-contained, return it unchanged.
- Expand abbreviations using context if possible.
- Keep the rewritten query concise (under 100 words).`;

// ─────────────────────────────────────────────────────────────────────────────
// ContextualRewriter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query rewriter that resolves implicit references against conversation history.
 *
 * Useful for follow-up questions where the user refers back to something
 * mentioned earlier in the conversation without restating it.
 *
 * @example
 * ```
 * History:
 *   User: "Tell me about Plan A"
 *   Assistant: "Plan A costs $50/month and includes..."
 *
 * Query: "And what about cancellation?"
 * Rewritten: "What is the cancellation policy for Plan A?"
 * ```
 */
export class ContextualRewriter extends QueryRewriter {
  override readonly name = 'contextual';

  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #historyWindow: number;
  readonly #options: QueryRewriterOptions;

  /**
   * @param router        - LLM router instance.
   * @param provider      - Provider name registered in the router (e.g. `'claude'`).
   * @param model         - Model identifier (e.g. `'claude-haiku-4-5'`).
   * @param historyWindow - Number of recent messages to include as context. Default: 6.
   * @param options       - Reasoning effort (default `'minimal'`) and the bus for fallback events.
   */
  constructor(
    router: LLMRouter,
    provider: string,
    model: string,
    historyWindow = 6,
    options: QueryRewriterOptions = {},
  ) {
    super();
    this.#router = router;
    this.#provider = provider;
    this.#model = model;
    this.#historyWindow = historyWindow;
    this.#options = options;
  }

  /**
   * Rewrites the query using recent conversation history to resolve
   * implicit references and ambiguous pronouns.
   *
   * Returns the original query unchanged when:
   * - No conversation history is provided.
   * - The LLM call fails (graceful degradation).
   * - The LLM returns an empty or implausibly long response.
   *
   * @param query               - Original user query.
   * @param conversationHistory - Recent conversation messages.
   */
  override async rewrite(query: string, conversationHistory?: LLMMessage[]): Promise<string> {
    if (conversationHistory === undefined || conversationHistory.length === 0) {
      return query;
    }

    const recentHistory = conversationHistory.slice(-this.#historyWindow);
    const historyText = recentHistory
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = typeof m.content === 'string' ? m.content : '[structured content]';
        return `${role}: ${content}`;
      })
      .join('\n');

    const request: LLMRequest = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Conversation history:\n${historyText}\n\nQuery to rewrite: ${query}`,
        },
      ],
      model: this.#model,
      temperature: 0,
      maxTokens: 150,
      ...rewriteReasoningEffort(this.#options),
    };

    try {
      const response = await this.#router.call(request, this.#provider);
      const rewritten = typeof response.content === 'string' ? response.content.trim() : '';

      // Fallback if the LLM returns empty or implausibly long output.
      if (rewritten.length === 0) return this.#fallback(query, 'empty', response.stopReason);
      if (rewritten.length >= 500) return this.#fallback(query, 'too_long', response.stopReason);
      return rewritten;
    } catch (err) {
      // Degrade gracefully — use original query if rewriting fails.
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
