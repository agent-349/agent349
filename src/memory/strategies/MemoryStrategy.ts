import type { LLMMessage } from '../../types/index.js';

/**
 * Abstract base for conversation-history compression strategies.
 *
 * Concrete strategies (e.g. {@link SlidingWindow}, {@link IncrementalSummary})
 * implement two responsibilities:
 *
 * 1. **`shouldCompress`** — decide whether the current message list is long enough
 *    to warrant compression.
 * 2. **`compress`** — transform the message list into a shorter representation
 *    that preserves the essential context.
 *
 * @example
 * ```typescript
 * class MyStrategy extends MemoryStrategy {
 *   readonly type = 'sliding_window' as const;
 *   shouldCompress(msgs: LLMMessage[]) { return msgs.length > 30; }
 *   async compress(msgs: LLMMessage[]) { return msgs.slice(-20); }
 * }
 * ```
 */
export abstract class MemoryStrategy {
  /** Discriminator used for logging and configuration. */
  abstract readonly type: 'sliding_window' | 'incremental_summary';

  /**
   * Returns `true` when the conversation history is long enough that
   * compression should be applied.
   *
   * @param messages - Current full message list.
   */
  abstract shouldCompress(messages: LLMMessage[]): boolean;

  /**
   * Reduces the message list to a more compact form.
   *
   * The returned array must preserve enough context for the agent to continue
   * the conversation coherently. The original array is **not** mutated.
   *
   * @param messages - Full message history to compress.
   * @returns A shorter message list that captures the essential context.
   */
  abstract compress(messages: LLMMessage[]): Promise<LLMMessage[]>;
}
