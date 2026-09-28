import type { LLMMessage } from '../../types/index.js';
import { MemoryStrategy } from './MemoryStrategy.js';

/**
 * Configuration accepted by {@link SlidingWindow}.
 */
export interface SlidingWindowConfig {
  /**
   * Maximum number of messages to retain.
   * When the history exceeds this count, the oldest messages are discarded.
   * @default 20
   */
  maxMessages?: number;
}

/**
 * Compression strategy that keeps only the most recent `maxMessages` messages.
 *
 * This is the simplest strategy: no LLM calls required. Older messages are
 * silently dropped. Suitable for short-lived interactions (support chat,
 * quick queries) where long historical context is not critical.
 *
 * @example
 * ```typescript
 * const strategy = new SlidingWindow({ maxMessages: 10 });
 * strategy.shouldCompress(messages); // true when messages.length > 10
 * const trimmed = await strategy.compress(messages); // last 10 messages
 * ```
 */
export class SlidingWindow extends MemoryStrategy {
  override readonly type = 'sliding_window' as const;

  readonly #maxMessages: number;

  /**
   * @param config - Strategy configuration.
   */
  constructor(config: SlidingWindowConfig = {}) {
    super();
    this.#maxMessages = config.maxMessages ?? 20;
  }

  /**
   * Returns `true` when the message count exceeds `maxMessages`.
   */
  override shouldCompress(messages: LLMMessage[]): boolean {
    return messages.length > this.#maxMessages;
  }

  /**
   * Returns the last `maxMessages` entries from the history.
   * The original array is not mutated.
   *
   * @param messages - Full message history.
   * @returns Trimmed history containing only the most recent messages.
   */
  override async compress(messages: LLMMessage[]): Promise<LLMMessage[]> {
    return messages.slice(-this.#maxMessages);
  }

  /** The configured window size. */
  get maxMessages(): number {
    return this.#maxMessages;
  }
}
