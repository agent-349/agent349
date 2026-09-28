import type { LLMMessage } from '../../types/index.js';
import type { LLMProvider } from '../../llm/LLMProvider.js';
import { MemoryStrategy } from './MemoryStrategy.js';

/**
 * Configuration accepted by {@link IncrementalSummary}.
 */
export interface IncrementalSummaryConfig {
  /**
   * Number of messages that triggers compression.
   * When `messages.length > summaryThreshold`, compression runs.
   * @default 15
   */
  summaryThreshold?: number;
  /**
   * Number of the most-recent messages to retain verbatim after compression.
   * The remaining older messages are replaced by a single summary entry.
   * @default 5
   */
  keepRecent?: number;
  /**
   * Model identifier passed to the LLM for the summarisation call.
   * Defaults to the model in the original LLM request context.
   * Recommended: a fast, inexpensive model (e.g. `'claude-haiku-4-5'`).
   */
  summaryModel: string;
}

const SUMMARY_SYSTEM_PROMPT =
  'You are a conversation historian. ' +
  'Produce a concise, factual summary of the conversation below. ' +
  'Preserve all key decisions, facts, tool results, and user intentions. ' +
  'Be brief but complete. Write in third person.';

const SUMMARY_PREFIX = '[Conversation Summary]\n';

/**
 * Compression strategy that uses an LLM to summarise old messages.
 *
 * When the history exceeds `summaryThreshold` messages:
 *
 * 1. The older messages (all except the most-recent `keepRecent`) are sent to
 *    the LLM for summarisation.
 * 2. The LLM's summary is prepended as a `{ role: 'user' }` context block.
 * 3. The compressed history = `[summaryBlock, ...keepRecent messages]`.
 *
 * Suitable for long-running conversations (analysis, research, multi-turn
 * planning) where losing older context would degrade answer quality.
 *
 * @example
 * ```typescript
 * const strategy = new IncrementalSummary(
 *   claudeProvider,
 *   { summaryThreshold: 15, keepRecent: 5, summaryModel: 'claude-haiku-4-5' },
 * );
 * const compressed = await strategy.compress(messages);
 * ```
 */
export class IncrementalSummary extends MemoryStrategy {
  override readonly type = 'incremental_summary' as const;

  readonly #provider: LLMProvider;
  readonly #summaryThreshold: number;
  readonly #keepRecent: number;
  readonly #summaryModel: string;

  /**
   * @param provider - LLM provider used for the summarisation call.
   * @param config   - Strategy configuration.
   */
  constructor(provider: LLMProvider, config: IncrementalSummaryConfig) {
    super();
    this.#provider = provider;
    this.#summaryThreshold = config.summaryThreshold ?? 15;
    this.#keepRecent = config.keepRecent ?? 5;
    this.#summaryModel = config.summaryModel;
  }

  /**
   * Returns `true` when the message count exceeds `summaryThreshold`.
   */
  override shouldCompress(messages: LLMMessage[]): boolean {
    return messages.length > this.#summaryThreshold;
  }

  /**
   * Calls the LLM to summarise older messages and returns the compressed history.
   *
   * If all messages fit within `keepRecent`, no summarisation is performed and
   * the original array is returned unchanged.
   *
   * @param messages - Full message history to compress.
   * @returns Compressed history: `[summaryBlock, ...recentMessages]`.
   */
  override async compress(messages: LLMMessage[]): Promise<LLMMessage[]> {
    const keepRecent = Math.min(this.#keepRecent, messages.length);
    const olderMessages = messages.slice(0, messages.length - keepRecent);
    const recentMessages = messages.slice(-keepRecent);

    if (olderMessages.length === 0) {
      return messages;
    }

    const conversationText = olderMessages
      .map((m) => {
        const role = m.role.toUpperCase();
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${role}: ${content}`;
      })
      .join('\n');

    const response = await this.#provider.call({
      model: this.#summaryModel,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Please summarise this conversation:\n\n${conversationText}`,
        },
      ],
    });

    const summaryBlock: LLMMessage = {
      role: 'user',
      content: `${SUMMARY_PREFIX}${response.content}`,
    };

    return [summaryBlock, ...recentMessages];
  }

  /** The configured message threshold that triggers compression. */
  get summaryThreshold(): number {
    return this.#summaryThreshold;
  }

  /** The number of recent messages preserved verbatim after compression. */
  get keepRecent(): number {
    return this.#keepRecent;
  }
}
