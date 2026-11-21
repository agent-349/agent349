import type { JSONSchema, LLMRequest, LLMResponse } from '../../types/index.js';
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
   *
   * Scores from separate calls are not fully comparable — each call judges its
   * passages against each other as much as against the query — so the default
   * scores every candidate of a normal search in one call. Larger sets are
   * split into batches that run in parallel.
   * @default 50
   */
  batchSize?: number;
  /**
   * Independent scoring passes per batch, averaged. Smoothes the run-to-run
   * variance of small or reasoning models, at `samples` times the cost.
   * Passes run in parallel. Clamped to 1–5.
   * @default 1
   */
  samples?: number;
  /**
   * Whether to request a JSON-Schema-constrained answer when the provider
   * supports it natively (`'auto'`), or always parse a plain JSON array
   * (`'off'`). Structured output removes most parse failures and ties each
   * score to its passage number instead of to its position in a list.
   * @default 'auto'
   */
  structuredOutput?: 'auto' | 'off';
  /**
   * Max completion tokens requested per batch call, sent as-is regardless of
   * batch size. Overrides the computed default: the visible answer
   * (a few tokens per passage) plus a reasoning allowance that grows with
   * {@link reasoningEffort} (see {@link LLMReranker}).
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

/**
 * Relevance rubric. Anchored levels make scores comparable across queries,
 * calls and models — an open "0 to 1" scale lets each call drift — and the
 * explicit "judge meaning, not wording" rule addresses the failure that
 * motivated it: a colloquial query ("fake dollars") scored 0.0 against the
 * passage that answered it in formal terms ("counterfeit banknotes"), so the
 * answer was cut by `minScore`. The anti-coincidence rules of the previous
 * prompt are kept: they stop acronyms and shared vocabulary from scoring.
 */
const SYSTEM_PROMPT = `You judge how well passages from a document collection answer a search query. Score each passage on this scale:

1.0 — directly answers the query: it contains the specific rule, procedure, figure or fact asked for.
0.7 — contains a substantial part of the answer, or the answer follows from it without assumptions.
0.4 — about the same specific subject or procedure, but does not contain the answer.
0.1 — only tangentially related: same broad area, document type or vocabulary.
0.0 — unrelated.
Use intermediate values for passages between two levels.

Judge meaning, not wording. Queries are often colloquial, misspelled or phrased in other terms than the documents ("fake dollars" for "counterfeit banknotes", "can a coworker use my login" for "credentials are personal and non-transferable"). A passage that addresses the same need in other words deserves the same score as one using the query's words. The document title before each passage tells you where it comes from.

Do not reward coincidences. A short query or acronym matching only as a substring of an unrelated word ("ute" inside "attribute") is not a match, and sharing a general topic or vocabulary is not enough for more than 0.1. Do not guess: when the query is short, an acronym or unfamiliar and the passage does not genuinely address it, 0.0 is the correct answer.

Score every passage on its own against the query, not against the other passages.`;

/** Answer instruction for plain-text mode (no native structured output). */
const textInstruction = (n: number): string =>
  `Reply with ONLY a JSON array of ${n} numbers from 0.0 to 1.0, one per passage, in the listed order. ` +
  `No other text. Example for 3 passages: [0.7, 0.0, 1.0]`;

/** Answer instruction for structured mode. */
const structuredInstruction = (n: number): string =>
  `Return one score for each of the ${n} passages, identified by its number in brackets.`;

/** JSON Schema of the structured answer: one `{ id, score }` per passage. */
const SCORES_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Passage number, as listed in brackets.' },
          score: { type: 'number', description: 'Relevance from 0.0 to 1.0.' },
        },
        required: ['id', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

/** Recommended default — see {@link LLMRerankerConfig.reasoningEffort}. */
const DEFAULT_REASONING_EFFORT: LLMRequest['reasoningEffort'] = 'minimal';

/** Default passages per call: every candidate of a normal search at once. */
const DEFAULT_BATCH_SIZE = 50;

/** Approximate visible-output cost of one score entry (`{"id":12,"score":0.7},`). */
const TOKENS_PER_PASSAGE = 16;

/**
 * Reasoning allowance on top of the visible answer, by reasoning effort.
 *
 * A reasoning model spends hidden tokens before the visible JSON; a budget
 * sized only for the JSON leaves it no room and the answer comes back empty
 * (observed with `gpt-5-nano` at `'low'`, which failed every parse with the
 * former fixed 256-token headroom). Models that do not reason leave the
 * allowance unused. Unset effort means the provider default, which for
 * reasoning models is usually `'medium'`.
 */
const REASONING_ALLOWANCE: Record<string, number> = {
  none: 256,
  minimal: 256,
  low: 2048,
  medium: 6144,
  high: 16384,
  xhigh: 24576,
};
const DEFAULT_REASONING_ALLOWANCE = 6144;

/**
 * LLM-based re-ranker that uses an existing {@link LLMRouter} to score passages.
 *
 * The model scores every passage against an anchored relevance rubric (1.0
 * answers the query, 0.7 contains most of the answer, 0.4 same subject without
 * the answer, 0.1 tangential, 0.0 unrelated) in a single call — batches of
 * `batchSize`, run in parallel, only for unusually large candidate sets. When
 * the provider supports JSON Schema natively, the answer is constrained to
 * `{ scores: [{ id, score }] }`; otherwise the model replies with a JSON
 * array in passage order. Passages are then sorted by score and the top
 * `topK` returned.
 *
 * **Trade-offs vs other re-rankers:**
 * - Best on colloquial or paraphrased queries — it judges meaning, where a
 *   small cross-encoder mostly rewards shared wording.
 * - Higher latency (one model call, ~2–5 s) and token cost.
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
  readonly #samples: number;
  readonly #structuredOutput: 'auto' | 'off';
  readonly #maxTokens: number | undefined;
  readonly #reasoningEffort: LLMRequest['reasoningEffort'];
  readonly #bus: EventBus | undefined;
  readonly #onParseFailure: 'throw' | 'degrade';

  constructor(config: LLMRerankerConfig) {
    super();
    this.#router = config.llmRouter;
    this.#provider = config.provider;
    this.#model = config.model;
    this.#batchSize = Math.max(1, config.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#samples = Math.min(5, Math.max(1, Math.floor(config.samples ?? 1)));
    this.#structuredOutput = config.structuredOutput ?? 'auto';
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

    const batches: Passage[][] = [];
    for (let i = 0; i < passages.length; i += this.#batchSize) {
      batches.push(passages.slice(i, i + this.#batchSize));
    }

    // Every batch and every sample in parallel: latency is one model call.
    const results = await Promise.all(
      batches.map((batch) =>
        Promise.all(Array.from({ length: this.#samples }, () => this.#scoreBatch(query, batch))),
      ),
    );

    // Average the samples of each passage, building a flat (passage, score) list.
    const scored: Array<{ passage: Passage; score: number }> = [];
    results.forEach((samples, b) => {
      const batch = batches[b]!;
      for (const sample of samples) totalTokens += sample.tokensUsed;
      for (let j = 0; j < batch.length; j++) {
        const sum = samples.reduce((acc, sample) => acc + (sample.scores[j] ?? 0), 0);
        scored.push({ passage: batch[j]!, score: sum / samples.length });
      }
    });

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

  /** The LLM provider instance that serves the scoring calls. */
  override get billingProvider(): string {
    return this.#provider;
  }

  /** Model this re-ranker scores with. */
  override get model(): string {
    return this.#model;
  }

  /**
   * Scores one probe passage exactly as {@link rerank} would — same prompt,
   * reasoning effort and token budget — and succeeds only when the reply
   * parses as a score.
   *
   * A bare reachability call is not enough: a reasoning model (e.g.
   * `gpt-5-nano`) given a tiny budget and no reasoning effort spends it all on
   * reasoning and returns an empty reply, which the old probe reported as
   * available while proving nothing about the model's ability to score.
   */
  override async validate(): Promise<ProviderProbe> {
    try {
      const probe: Passage = {
        id: 'probe',
        content: 'The Pro plan costs 20 dollars per user per month.',
        score: 1,
        collection: 'probe',
        metadata: { documentId: 'probe' },
      };
      const response = await this.#router.call(
        this.#scoringRequest('How much does the Pro plan cost?', [probe]),
        this.#provider,
      );
      if (this.#extractScores(response, 1) === undefined) {
        return {
          ok: false,
          error:
            `model '${this.#model}' did not return a score` +
            (response.stopReason === 'max_tokens'
              ? ' (the reply hit the token limit; raise rag.reranker.maxTokens or lower reasoningEffort)'
              : `: ${JSON.stringify(response.content.slice(0, 80))}`),
        };
      }
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
    const response = await this.#router.call(this.#scoringRequest(query, batch), this.#provider);
    const tokensUsed = response.usage.inputTokens + response.usage.outputTokens;
    const scores = this.#parseScores(response, batch.length);

    return { scores, tokensUsed };
  }

  /** Whether to request JSON-Schema-constrained output from this provider and model. */
  #useStructuredOutput(): boolean {
    if (this.#structuredOutput === 'off') return false;
    try {
      const provider = this.#router.getProvider(this.#provider);
      return provider?.capabilities(this.#model).structuredOutput === 'jsonSchema';
    } catch {
      return false;
    }
  }

  /** Completion budget: the visible answer plus a reasoning allowance for the effort. */
  #completionBudget(passageCount: number): number {
    if (this.#maxTokens !== undefined) return this.#maxTokens;
    const effort = this.#reasoningEffort;
    const allowance =
      effort === undefined
        ? DEFAULT_REASONING_ALLOWANCE
        : (REASONING_ALLOWANCE[effort] ?? DEFAULT_REASONING_ALLOWANCE);
    return passageCount * TOKENS_PER_PASSAGE + allowance;
  }

  /** The scoring request for one batch, shared by {@link rerank} and {@link validate}. */
  #scoringRequest(query: string, batch: Passage[]): LLMRequest {
    const structured = this.#useStructuredOutput();
    const passageList = batch.map((p, i) => `[${i + 1}] ${this.scoringText(p)}`).join('\n\n');

    const userContent =
      `Query: ${query}\n\n` +
      `${batch.length} passage${batch.length === 1 ? '' : 's'} to score:\n\n` +
      passageList +
      '\n\n' +
      (structured ? structuredInstruction(batch.length) : textInstruction(batch.length));

    return {
      model: this.#model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: this.#completionBudget(batch.length),
      ...(this.#reasoningEffort !== undefined && { reasoningEffort: this.#reasoningEffort }),
      ...(structured && {
        responseFormat: {
          type: 'json_schema' as const,
          name: 'passage_scores',
          schema: SCORES_SCHEMA,
          strict: true,
        },
      }),
    };
  }

  /**
   * Scores from a model response: the structured `{ scores: [{ id, score }] }`
   * answer when present (ids are 1-based passage numbers), otherwise the first
   * JSON number array in the text. Scores are clamped to [0, 1]; passages the
   * model left out score 0. `undefined` when nothing parses.
   */
  #extractScores(response: LLMResponse, expectedLength: number): number[] | undefined {
    const structured = response.structured;
    let value: unknown = structured?.parsed === true ? structured.value : undefined;
    if (value === undefined) {
      try {
        const trimmed = response.content.trim();
        if (trimmed.startsWith('{')) value = JSON.parse(trimmed);
      } catch {
        value = undefined;
      }
    }
    const byId = LLMReranker.#scoresFromObject(value, expectedLength);
    if (byId !== undefined) return byId;
    const list = LLMReranker.#tryParseScores(response.content, expectedLength);
    return list?.map(clampScore);
  }

  /** Scores from a `{ scores: [...] }` object (entries `{ id, score }` or bare numbers). */
  static #scoresFromObject(value: unknown, expectedLength: number): number[] | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const entries = (value as { scores?: unknown }).scores;
    if (!Array.isArray(entries)) return undefined;
    if (entries.every((e) => typeof e === 'number')) {
      const list = entries.slice(0, expectedLength).map(clampScore);
      while (list.length < expectedLength) list.push(0);
      return list;
    }
    const scores = new Array<number>(expectedLength).fill(0);
    let matched = 0;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const { id, score } = entry as { id?: unknown; score?: unknown };
      if (typeof id !== 'number' || typeof score !== 'number') continue;
      const index = Math.round(id) - 1;
      if (index < 0 || index >= expectedLength) continue;
      scores[index] = clampScore(score);
      matched++;
    }
    return matched > 0 ? scores : undefined;
  }

  /** The first JSON number array in `text`, padded or truncated to `expectedLength`; `undefined` if none. */
  static #tryParseScores(text: string, expectedLength: number): number[] | undefined {
    const match = text.match(/\[[\s\d.,]+\]/);
    if (!match) return undefined;
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'number')) {
        const scores = parsed;
        while (scores.length < expectedLength) scores.push(0);
        return scores.slice(0, expectedLength);
      }
    } catch {
      // not a JSON array
    }
    return undefined;
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
  #parseScores(response: LLMResponse, expectedLength: number): number[] {
    const scores = this.#extractScores(response, expectedLength);
    if (scores !== undefined) return scores;
    const text = response.content;

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

/** A score clamped to [0, 1]; non-finite values become 0. */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}
