import type { LLMMessage, LLMRequest, ProviderProbe } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import { QueryRewriter, probeError, rewriteReasoningEffort } from './QueryRewriter.js';
import type {
  QueryRewriteFallbackReason,
  QueryRewriteOutcome,
  QueryRewriterOptions,
} from './QueryRewriter.js';

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
    return (await this.rewriteWithOutcome(query, conversationHistory)).query;
  }

  /**
   * Same as {@link rewrite}, reporting whether the rewrite was applied and,
   * when the original query was kept after an attempt, why.
   *
   * @param query               - Original user query.
   * @param conversationHistory - Recent conversation messages.
   * @returns The query to search with and how it was obtained. Never throws.
   */
  override async rewriteWithOutcome(
    query: string,
    conversationHistory?: LLMMessage[],
  ): Promise<QueryRewriteOutcome> {
    if (conversationHistory === undefined || conversationHistory.length === 0) {
      return { query, applied: false };
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
      return { query: rewritten, applied: rewritten !== query };
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

  /** LLM provider used for rewriting. */
  override get provider(): string {
    return this.#provider;
  }

  /** Model used for rewriting. */
  override get model(): string {
    return this.#model;
  }

  /**
   * Rewrites a probe follow-up against a probe history with the same request
   * {@link rewrite} sends, and succeeds only when the model answers with a
   * usable rewrite. Catches a model the credentials cannot access and a
   * reasoning model whose budget is spent before it answers — both of which
   * {@link rewrite} absorbs by silently keeping the original query.
   *
   * @returns The probe outcome. Never throws.
   */
  override async validate(): Promise<ProviderProbe> {
    const outcome = await this.rewriteWithOutcome('And how much does it cost?', [
      { role: 'user', content: 'Tell me about the Pro plan.' },
      {
        role: 'assistant',
        content: 'The Pro plan includes unlimited projects and priority support.',
      },
    ]);
    if (outcome.fallbackReason === undefined) return { ok: true };
    return { ok: false, error: probeError(this.#model, outcome) };
  }

  #fallback(
    query: string,
    reason: QueryRewriteFallbackReason,
    stopReason?: string,
    error?: string,
  ): QueryRewriteOutcome {
    this.#options.eventBus?.emit('rag.query_rewrite.fallback', {
      strategy: this.name,
      provider: this.#provider,
      model: this.#model,
      reason,
      ...(stopReason !== undefined && { stopReason }),
      ...(error !== undefined && { error }),
    });
    return {
      query,
      applied: false,
      fallbackReason: reason,
      ...(error !== undefined && { error }),
      ...(stopReason === 'max_tokens' &&
        reason !== 'error' && { error: 'reply hit the token limit' }),
    };
  }
}
