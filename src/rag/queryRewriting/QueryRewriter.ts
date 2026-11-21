import type {
  LLMMessage,
  LLMRequest,
  ProviderProbe,
  QueryRewriteFallbackReason,
  QueryRewriteOutcome,
} from '../../types/index.js';
import type { EventBus } from '../../events/EventBus.js';
import type { GlossaryEntry } from '../lexicon/Lexicon.js';
import { formatGlossary } from '../lexicon/Lexicon.js';

/** Per-call input of a rewrite besides the query and the history. */
export interface RewriteCallOptions {
  /**
   * Glossary entries whose terms occur in the query or the conversation:
   * the rewrite keeps each term and adds its meaning or equivalents, so the
   * search finds either form.
   */
  glossary?: GlossaryEntry[];
}

/** Prompt section for glossary entries (empty when there are none). */
export function glossaryPrompt(glossary: GlossaryEntry[] | undefined): string {
  if (glossary === undefined || glossary.length === 0) return '';
  return (
    '\n\nDomain glossary of the document collection:\n' +
    formatGlossary(glossary) +
    '\nWhen the query uses a glossary term, keep the term and add its meaning or equivalent terms, so the search finds documents using either form; this applies even when the query is otherwise self-contained. Do not add glossary terms the query does not use.'
  );
}

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

export type { QueryRewriteFallbackReason, QueryRewriteOutcome };

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

/**
 * Failure description for a rewriter probe that fell back to the original query.
 *
 * @internal Shared by the built-in rewriters.
 */
export function probeError(model: string, outcome: QueryRewriteOutcome): string {
  switch (outcome.fallbackReason) {
    case 'error':
      return outcome.error ?? `model '${model}' request failed`;
    case 'empty':
      return (
        `model '${model}' returned an empty rewrite` +
        (outcome.error !== undefined
          ? ` (${outcome.error}; lower rag.queryRewriting.reasoningEffort)`
          : '')
      );
    case 'too_long':
      return `model '${model}' returned an implausibly long rewrite`;
    case 'too_short':
      return `model '${model}' returned a degenerate (too short) rewrite`;
    default:
      return `model '${model}' did not produce a rewrite`;
  }
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

  /** LLM provider used by this rewriter, when it uses one. */
  get provider(): string | undefined {
    return undefined;
  }

  /** Model used by this rewriter, when it uses one. */
  get model(): string | undefined {
    return undefined;
  }

  /**
   * Rewrites the query and reports whether the rewrite was applied, and why
   * not when it fell back to the original. The RAG pipeline calls this method
   * so the outcome reaches the search trace and the audit log.
   *
   * The default implementation wraps {@link rewrite} and can only tell whether
   * the text changed. The built-in rewriters override it to report the
   * fallback reason as well.
   *
   * @param query               - Original user query.
   * @param conversationHistory - Recent messages for context-aware strategies.
   * @param _options            - Glossary entries; ignored by rewriters that do not use them.
   * @returns The query to search with and how it was obtained. Never throws.
   */
  async rewriteWithOutcome(
    query: string,
    conversationHistory?: LLMMessage[],
    _options?: RewriteCallOptions,
  ): Promise<QueryRewriteOutcome> {
    const rewritten = await this.rewrite(query, conversationHistory);
    return { query: rewritten, applied: rewritten !== query };
  }

  /**
   * Probes the rewriter with a real request and reports whether it can
   * produce rewrites. Intended for startup checks: a failing rewriter never
   * fails a search, it silently keeps the original query.
   *
   * The default implementation reports success; rewriters that call a model
   * override it.
   *
   * @returns The probe outcome. Never throws.
   */
  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }
}
