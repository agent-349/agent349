import type { LLMMessage } from '../../types/index.js';

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
