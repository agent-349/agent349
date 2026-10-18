import type { LLMMessage, LLMRequest } from '../../types/index.js';
import type { EventBus } from '../../events/EventBus.js';

/** Options shared by the built-in LLM query rewriters. */
export interface QueryRewriterOptions {
  /**
   * Reasoning effort of the rewriting call. Default `'minimal'`: the rewrite
   * has a small token budget, and a model that reasons by default (gpt-5,
   * gpt-5-mini, gpt-5-nano) spends all of it on reasoning and returns an
   * empty reply. Pass `null` to send none. Providers without the notion
   * ignore it; OpenAI models that reject it are retried without it.
   */
  reasoningEffort?: LLMRequest['reasoningEffort'] | null;
  /** Receives `rag.query_rewrite.fallback` whenever the original query is kept because rewriting failed. */
  eventBus?: EventBus;
}

/** Why a rewriter kept the original query. */
export type QueryRewriteFallbackReason = 'error' | 'empty' | 'too_long' | 'too_short';

/** Default reasoning effort of the built-in rewriters. */
export const DEFAULT_REWRITE_REASONING_EFFORT: LLMRequest['reasoningEffort'] = 'minimal';

/** The `reasoningEffort` request field for `options` (absent when `null`). */
export function rewriteReasoningEffort(
  options: QueryRewriterOptions,
): Pick<LLMRequest, 'reasoningEffort'> {
  const effort =
    options.reasoningEffort === undefined
      ? DEFAULT_REWRITE_REASONING_EFFORT
      : options.reasoningEffort;
  return effort === null || effort === undefined ? {} : { reasoningEffort: effort };
}

// ─────────────────────────────────────────────────────────────────────────────
// QueryRewriter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for query rewriting strategies.
 *
 * A `QueryRewriter` transforms a raw user query into a form better suited for
 * semantic search before embedding. This improves retrieval quality for:
 * - Ambiguous or context-dependent queries (resolved by `ContextualRewriter`)
 * - Abstract queries with vocabulary different from the indexed documents
 *   (improved by `HyDERewriter`)
 *
 * | Strategy           | Class                  | Use case                          |
 * |--------------------|------------------------|-----------------------------------|
 * | Contextual         | `ContextualRewriter`   | Follow-up questions in a conversation |
 * | HyDE               | `HyDERewriter`         | Abstract or paraphrased queries   |
 *
 * @example
 * ```typescript
 * const rewriter = new ContextualRewriter(llmRouter, 'claude-haiku-4-5');
 * const rewritten = await rewriter.rewrite('And the price?', conversationHistory);
 * // 'What is the price of Plan A?' — resolved using conversation context
 * ```
 */
export abstract class QueryRewriter {
  /** Unique name for this rewriter strategy (e.g. `'contextual'`, `'hyde'`). */
  abstract readonly name: string;

  /**
   * Rewrites the query into a form better suited for semantic search.
   *
   * @param query               - Original user query.
   * @param conversationHistory - Recent messages for context-aware strategies.
   *                              Pass `undefined` or an empty array when no
   *                              history is available; strategies must handle
   *                              this gracefully by returning the original query.
   * @returns The rewritten query string. Never throws — falls back to the
   *          original query on any LLM error.
   */
  abstract rewrite(query: string, conversationHistory?: LLMMessage[]): Promise<string>;
}
