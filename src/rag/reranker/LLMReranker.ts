import type { LLMRequest } from '../../types/index.js';
import type { Passage, RerankResult, ProviderProbe } from '../types.js';
import { RerankerProvider } from './RerankerProvider.js';
import { RerankerError } from '../../errors/RerankerError.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import type { EventBus } from '../../events/EventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link LLMReranker}.
 */
export interface LLMRerankerConfig {
  /** The {@link LLMRouter} instance used to call the LLM. */
  llmRouter: LLMRouter;
  /** Name of the registered provider to use (e.g. `'claude'`, `'openai'`). */
  provider: string;
  /** Model identifier to request (e.g. `'claude-haiku-4-5'`). */
  model: string;
  /**
   * Maximum number of passages to score in a single LLM call.
   * Larger values reduce LLM calls but increase prompt size.
   * @default 10
   */
  batchSize?: number;
  /**
   * Max completion tokens requested per batch call, sent as-is regardless of
   * batch size. Overrides the computed default (see {@link LLMReranker}).
   *
   * Reasoning-capable models (e.g. GPT-5) spend part of this budget on hidden
   * reasoning tokens before emitting any visible text, so a value sized only
   * for the visible JSON array (as a non-reasoning model needs) can leave the
   * model no room to answer — the response comes back empty and fails to
   * parse. Raise this when using such a model with a reranker-unfriendly
   * default reasoning effort; see {@link reasoningEffort}.
   */
  maxTokens?: number;
  /**
   * Reasoning effort hint passed to the LLM, for reasoning-capable models
   * (e.g. GPT-5). Only `OpenAIProvider` currently reads this field — other
   * adapters (Claude, Ollama, Gemini) ignore it, and an OpenAI-compatible
   * endpoint that rejects the parameter has it dropped automatically by the
   * provider's parameter-relaxation retry. So it is always safe to set: it
   * is a no-op wherever it doesn't apply.
   *
   * Scoring passage relevance needs no deep reasoning, so the default here
   * is `'minimal'` — favouring a small, predictable token footprint over
   * reasoning quality the task doesn't benefit from. Set explicitly to
   * override, including to `undefined`-equivalent by omitting both this and
   * relying on the provider's own default (pass a provider default via
   * `llm.providers.<name>.reasoningEffort` instead of this field for that).
   * @default 'minimal'
   */
  reasoningEffort?: LLMRequest['reasoningEffort'];
  /**
   * EventBus for emitting `rag.rerank.parse_error` when the LLM response
   * cannot be parsed as a JSON score array. Omit to skip the event; the
   * configured {@link LLMRerankerConfig.onParseFailure} behaviour still applies.
   */
  eventBus?: EventBus;
  /**
   * What to do when the LLM response cannot be parsed as a score array.
   *
   * - `'throw'` (default) — raise a `RerankerError`. The alternative is to
   *   invent scores, which produces a result indistinguishable from a genuine
   *   ranking: plausibly ordered, above any `minScore`, and reported as
   *   `reranked: true`. No caller can detect that.
   * - `'degrade'` — fall back to descending scores preserving the input order.
   *
   * Wired from `rag.retrieval.rerankPolicy` by the Orchestrator.
   */
  onParseFailure?: 'throw' | 'degrade';
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMReranker
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strict passage relevance scorer. Given a search query and a list of passages, score each passage's relevance to the query on a scale from 0.0 (no real connection) to 1.0 (directly answers the query).

Score low (0.0-0.15) unless the passage is clearly and specifically about the query's subject. Sharing a general topic, technology, or document type is NOT enough for a higher score. A short or acronym-like query matching only as a coincidental substring inside a longer, unrelated word (e.g. "ute" inside "attribute" or "autenticado") is NOT a match and must NOT raise the score. Do not guess or give the benefit of the doubt when the query is short, an acronym, or unfamiliar — if there is no genuine lexical or topical connection, 0.0 is the correct, expected answer, not a failure to find something.

Reply ONLY with a JSON array of numbers — one score per passage, in the same order as listed.
Do not include any other text, explanation, or formatting.
Example for 3 passages: [0.9, 0.05, 0.7]`;

/** Recommended default — see {@link LLMRerankerConfig.reasoningEffort}. */
const DEFAULT_REASONING_EFFORT: LLMRequest['reasoningEffort'] = 'minimal';

/** Approximate visible-output cost of one "0.87, "-style score entry. */
const TOKENS_PER_PASSAGE = 8;

/**
 * Headroom added on top of the visible-output estimate, sized as a default
 * that's still generous for a reasoning-capable model kept at
 * {@link DEFAULT_REASONING_EFFORT} — not merely the couple of tokens a
 * non-reasoning model needs for the JSON brackets. A model that ignores
 * `reasoningEffort` entirely (Claude, Ollama, Gemini) just leaves this
 * unused; `finish_reason`/`stopReason` is not truncated either way.
 */
const DEFAULT_TOKEN_HEADROOM = 256;

/**
 * LLM-based re-ranker that uses an existing {@link LLMRouter} to score passages.
 *
 * Passages are processed in batches of `batchSize`. For each batch the LLM is
 * asked to return a JSON array of relevance scores (0.0–1.0) in passage order.
 * Passages are then sorted by score and the top `topK` are returned.
 *
 * **Trade-offs vs other re-rankers:**
 * - Highest quality — the same model that generates answers also ranks context.
 * - Higher latency (~1–3 s per batch) and token cost.
 * - Requires a capable model that can reliably output JSON arrays.
 *
 * @example
 * ```typescript
 * const reranker = new LLMReranker({
 *   llmRouter: router,
 *   provider: 'claude',
 *   model: 'claude-haiku-4-5',
 *   batchSize: 5,
 * });
 *
 * const result = await reranker.rerank('quarterly earnings', passages, 3);
 * ```
 */
export class LLMReranker extends RerankerProvider {
  override readonly name = 'llm';

  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #batchSize: number;
  readonly #maxTokens: number | undefined;
  readonly #reasoningEffort: LLMRequest['reasoningEffort'];
  readonly #bus: EventBus | undefined;
  readonly #onParseFailure: 'throw' | 'degrade';

  constructor(config: LLMRerankerConfig) {
    super();
    this.#router = config.llmRouter;
    this.#provider = config.provider;
    this.#model = config.model;
    this.#batchSize = config.batchSize ?? 10;
    this.#maxTokens = config.maxTokens;
    this.#reasoningEffort = config.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    this.#bus = config.eventBus;
    this.#onParseFailure = config.onParseFailure ?? 'throw';
  }

  /**
   * Scores all passages using the configured LLM (in batches) and returns the
   * top `topK` by relevance score.
   *
   * @param query    - Original user query.
   * @param passages - Candidate passages to rerank.
   * @param topK     - Maximum number of passages to return.
   * @returns {@link RerankResult} with rescored passages and usage metrics.
   */
  override async rerank(query: string, passages: Passage[], topK: number): Promise<RerankResult> {
    if (passages.length === 0) {
      return { passages: [], model: this.#model, latencyMs: 0, tokensUsed: 0 };
    }

    const startMs = Date.now();
    let totalTokens = 0;

    // Process in batches, building a flat list of (passage, score) pairs.
    const scored: Array<{ passage: Passage; score: number }> = [];

    for (let i = 0; i < passages.length; i += this.#batchSize) {
      const batch = passages.slice(i, i + this.#batchSize);
      const { scores, tokensUsed } = await this.#scoreBatch(query, batch);
      totalTokens += tokensUsed;

      for (let j = 0; j < batch.length; j++) {
        scored.push({ passage: batch[j]!, score: scores[j] ?? 0 });
      }
    }

    // Sort descending by LLM score and take topK.
    const reranked = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ passage, score }) => ({ ...passage, score }));

    return {
      passages: reranked,
      model: this.#model,
      latencyMs: Date.now() - startMs,
      tokensUsed: totalTokens,
    };
  }

  /** Returns `true` if the underlying LLM provider is reachable (circuit closed). */
  override async validate(): Promise<ProviderProbe> {
    try {
      const req: LLMRequest = {
        model: this.#model,
        systemPrompt: 'Reply with: [1.0]',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 16,
      };
      await this.#router.call(req, this.#provider);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async #scoreBatch(
    query: string,
    batch: Passage[],
  ): Promise<{ scores: number[]; tokensUsed: number }> {
    const passageList = batch.map((p, i) => `[${i + 1}] ${this.scoringText(p)}`).join('\n\n');

    const userContent =
      `Query: ${query}\n\n` +
      `${batch.length} passage${batch.length === 1 ? '' : 's'} to score:\n\n` +
      passageList +
      `\n\nReply with ONLY a JSON array of ${batch.length} numbers from 0.0 to 1.0.`;

    const request: LLMRequest = {
      model: this.#model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: this.#maxTokens ?? batch.length * TOKENS_PER_PASSAGE + DEFAULT_TOKEN_HEADROOM,
      ...(this.#reasoningEffort !== undefined && { reasoningEffort: this.#reasoningEffort }),
    };

    const response = await this.#router.call(request, this.#provider);
    const tokensUsed = response.usage.inputTokens + response.usage.outputTokens;
    const scores = this.#parseScores(response.content, batch.length);

    return { scores, tokensUsed };
  }

  /**
   * Extracts the first JSON number array from the LLM response text.
   *
   * On parse failure, emits `rag.rerank.parse_error` (if an EventBus was
   * provided) and then applies {@link LLMRerankerConfig.onParseFailure}:
   * `'throw'` (default) raises a {@link RerankerError}, `'degrade'` falls back
   * to descending scores that preserve the original passage order.
   *
   * @throws {@link RerankerError} when the response is unparseable and
   *         `onParseFailure` is `'throw'`.
   */
  #parseScores(text: string, expectedLength: number): number[] {
    const match = text.match(/\[[\s\d.,]+\]/);
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'number')) {
          // Pad or truncate to match the expected batch length.
          const scores = parsed;
          while (scores.length < expectedLength) scores.push(0);
          return scores.slice(0, expectedLength);
        }
      } catch {
        // Fall through to degraded fallback.
      }
    }

    // Emit a parse-error event so the caller can detect degraded reranking.
    this.#bus?.emit('rag.rerank.parse_error', {
      model: this.#model,
      responsePreview: text.slice(0, 200),
      expectedLength,
      onParseFailure: this.#onParseFailure,
    });

    // Synthetic scores are indistinguishable from real ones downstream, so by
    // default an unparseable response is an error rather than a silent guess.
    if (this.#onParseFailure === 'throw') {
      throw new RerankerError(
        this.name,
        'parse',
        `model '${this.#model}' did not return a JSON array of ${expectedLength} scores`,
      );
    }

    // Fallback: descending scores [1.0, (n-1)/n, ..., 1/n] — all > 0, preserves original order.
    return Array.from({ length: expectedLength }, (_, i) => (expectedLength - i) / expectedLength);
  }
}
