import type { ExecutionContext } from '../types/index.js';
import type {
  Passage,
  RAGQuery,
  RAGResult,
  FormatOptions,
  RerankerValidation,
  ProviderProbe,
} from './types.js';
import type { EmbeddingRouter } from './embedding/EmbeddingRouter.js';
import type { VectorStoreAdapter } from './vectorstore/VectorStoreAdapter.js';
import type { RerankerProvider } from './reranker/RerankerProvider.js';
import type { QueryRewriter } from './queryRewriting/QueryRewriter.js';
import type { EventBus } from '../events/EventBus.js';
import type { TokenTracker } from '../tokens/TokenTracker.js';
import { RAGError } from '../errors/RAGError.js';
import { RerankerError } from '../errors/RerankerError.js';
import { TokenLimitError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// RAGPipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orchestrates the four-stage Retrieval-Augmented Generation pipeline:
 *
 * ```
 * 1. EMBED   — Embed the query via the collection's configured embedding provider.
 * 2. SEARCH  — Search each collection (vector / keyword / hybrid).
 * 3. RERANK  — Optionally rerank the merged candidates with a RerankerProvider.
 * 4. FORMAT  — Return normalised Passage[] ready for LLM context injection.
 * ```
 *
 * **Multi-collection:** When `ragQuery.collections` contains more than one name,
 * each collection is searched independently. Results are then deduplicated by
 * document ID (keeping the highest score after per-collection min-max
 * normalisation) before re-ranking.
 *
 * **Embedding provider routing:** The pipeline reads the first collection's
 * `embeddingModel` field from the vector store. That field is expected to use a
 * `"provider/model"` format (e.g. `"openai/text-embedding-3-small"`). The first
 * segment (`split('/')[0]`) is used as the provider name when calling the
 * {@link EmbeddingRouter}.
 *
 * **Re-ranker failures:** when `rerank` is requested and the configured
 * re-ranker fails, the pipeline throws {@link RerankerError} rather than
 * returning an un-reranked result (`rerankPolicy: 'require'`, the default).
 * Pass `rerankPolicy: 'degrade'` — per query or via
 * `rag.retrieval.rerankPolicy` — to restore the previous fall-back behaviour.
 *
 * **Events emitted** (via the provided {@link EventBus}):
 * - `rag.embed.start` / `rag.embed.end`
 * - `rag.search.start` / `rag.search.end`
 * - `rag.rerank.start` / `rag.rerank.end`
 * - `rag.pipeline.complete`
 *
 * @example
 * ```typescript
 * const pipeline = new RAGPipeline(embeddingRouter, vectorStore, reranker, bus, tokens);
 * const result = await pipeline.search({ query: 'earnings', collections: ['docs'] }, context);
 * const context = pipeline.formatForContext(result.passages);
 * ```
 */
export class RAGPipeline {
  readonly #embedding: EmbeddingRouter;
  readonly #store: VectorStoreAdapter;
  #reranker: RerankerProvider | undefined;
  readonly #queryRewriter: QueryRewriter | undefined;
  readonly #bus: EventBus;
  readonly #tokens: TokenTracker;
  readonly #defaultRerankPolicy: 'require' | 'degrade';

  /**
   * @param embeddingRouter - Router that delegates embed calls to the correct provider.
   * @param vectorStore     - Storage backend for vector and keyword search.
   * @param reranker        - Optional re-ranker applied after merging results.
   * @param eventBus        - Bus for pipeline lifecycle events.
   * @param tokenTracker    - Tracker for LLM token usage (reranker calls).
   * @param queryRewriter   - Optional query rewriter applied before embedding.
   * @param defaultRerankPolicy - What to do when a requested re-rank fails.
   *                          Overridable per query via `RAGQuery.rerankPolicy`.
   *                          Default: `'require'`.
   */
  constructor(
    embeddingRouter: EmbeddingRouter,
    vectorStore: VectorStoreAdapter,
    reranker: RerankerProvider | undefined,
    eventBus: EventBus,
    tokenTracker: TokenTracker,
    queryRewriter?: QueryRewriter,
    defaultRerankPolicy: 'require' | 'degrade' = 'require',
  ) {
    this.#embedding = embeddingRouter;
    this.#store = vectorStore;
    this.#reranker = reranker;
    this.#bus = eventBus;
    this.#tokens = tokenTracker;
    this.#queryRewriter = queryRewriter;
    this.#defaultRerankPolicy = defaultRerankPolicy;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Replaces (or clears) the re-ranker applied after retrieval.
   *
   * Enables registering a custom {@link RerankerProvider} after the pipeline has
   * been assembled. Pass `undefined` to disable re-ranking.
   *
   * @param reranker - The re-ranker to use, or `undefined` to clear it.
   */
  setReranker(reranker: RerankerProvider | undefined): void {
    this.#reranker = reranker;
  }

  /** The re-ranker currently applied after retrieval, if any. */
  get reranker(): RerankerProvider | undefined {
    return this.#reranker;
  }

  /**
   * Probes the configured re-ranker and reports whether it can serve queries.
   *
   * Intended to be called at application startup. Without it, a re-ranker that
   * is unreachable or misconfigured is only discovered on a user's first query
   * — and under `rerankPolicy: 'require'` that first query fails. Probing early
   * turns a runtime incident into a boot-time log line.
   *
   * Never throws: a failed probe is reported in the returned value. Deciding
   * whether an unavailable re-ranker should block startup belongs to the host
   * application, not to the SDK.
   *
   * @returns A {@link RerankerValidation} describing configuration and reachability.
   */
  async validateReranker(): Promise<RerankerValidation> {
    const reranker = this.#reranker;
    if (reranker === undefined) {
      return { configured: false, available: false };
    }

    const startMs = Date.now();
    // `validate()` is contracted not to throw, but a third-party provider might;
    // a health check that crashes the boot sequence would defeat its purpose.
    let probe: ProviderProbe;
    try {
      probe = await reranker.validate();
    } catch (err) {
      probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - startMs;

    this.#bus.emit(probe.ok ? 'rag.reranker.available' : 'rag.reranker.unavailable', {
      provider: reranker.name,
      latencyMs,
      ...(probe.ok ? {} : { error: probe.error ?? 'the re-ranker probe did not succeed' }),
    });

    return {
      configured: true,
      provider: reranker.name,
      available: probe.ok,
      latencyMs,
      ...(probe.ok ? {} : { error: probe.error ?? 'the re-ranker probe did not succeed' }),
    };
  }

  /**
   * Runs the full RAG pipeline for the given query.
   *
   * @param ragQuery - Search parameters including query text, collections, and options.
   * @param context  - Execution context for token tracking and event attribution.
   * @returns {@link RAGResult} with the final ranked passages and pipeline metrics.
   * @throws When a required collection does not exist, or the embedding provider
   *         is not registered in the router.
   */
  async search(ragQuery: RAGQuery, context: ExecutionContext): Promise<RAGResult> {
    const pipelineStart = Date.now();
    const emit = (type: string, data: Record<string, unknown>): void => {
      this.#bus.emit(type, {
        ...data,
        _context: {
          tenantId: context.tenantId,
          userId: context.userId,
          sessionId: context.sessionId,
          agentId: context.agentId,
          requestId: context.requestId,
        },
      });
    };

    const {
      query: rawQuery,
      collections,
      topK = 10,
      finalTopK = 5,
      searchMode = 'hybrid',
      hybridAlpha = 0.7,
      rerank = true,
      rerankPolicy = this.#defaultRerankPolicy,
      filters,
      minScore = 0,
      rrfK = 60,
      conversationHistory,
    } = ragQuery;

    // ── 0. QUERY REWRITING (optional) ────────────────────────────────────────
    let query = rawQuery;
    let queryRewriteLatencyMs: number | undefined;
    if (this.#queryRewriter !== undefined) {
      const rewriteStart = Date.now();
      query = await this.#queryRewriter.rewrite(rawQuery, conversationHistory);
      queryRewriteLatencyMs = Date.now() - rewriteStart;
      emit('rag.query_rewrite.end', { latencyMs: queryRewriteLatencyMs });
    }

    // ── 1. EMBED ────────────────────────────────────────────────────────────
    // Validate that all collections use the same embedding provider before
    // embedding the query. Mixed providers would produce incompatible vectors.
    const collInfos = await Promise.all(collections.map((c) => this.#store.collectionInfo(c)));

    const knownProviders = new Set(
      collInfos
        .filter((info) => info.embeddingModel !== '')
        .map((info) => info.embeddingModel.split('/')[0]),
    );

    if (knownProviders.size > 1) {
      throw new RAGError(
        `Multi-collection queries require a uniform embedding provider. ` +
          `Found: ${[...knownProviders].join(', ')}. ` +
          `Query collections that share the same embedding provider, or search them separately.`,
        'embeddingProvider',
      );
    }

    const collWithMeta = collInfos.find((info) => info.embeddingModel !== '');
    if (collWithMeta === undefined) {
      throw new RAGError(
        `Cannot resolve embedding provider: no collection metadata found for ` +
          `[${collections.join(', ')}]. ` +
          `Ensure collections are created via the SDK before querying.`,
        'embeddingModel',
      );
    }

    emit('rag.embed.start', { query });
    const embedStart = Date.now();

    const providerName = collWithMeta.embeddingModel.split('/')[0]!;
    const embResult = await this.#embedding.embed(query, providerName);

    const embeddingLatencyMs = Date.now() - embedStart;
    emit('rag.embed.end', {
      latencyMs: embeddingLatencyMs,
      dimensions: embResult.dimensions,
    });

    // ── 2. SEARCH ───────────────────────────────────────────────────────────
    emit('rag.search.start', { collections, searchMode });
    const searchStart = Date.now();

    const allPassages: Passage[] = [];
    for (const collection of collections) {
      let passages: Passage[];
      switch (searchMode) {
        case 'vector':
          passages = await this.#store.search(collection, embResult.vector, topK, filters);
          break;
        case 'keyword':
          passages = await this.#store.keywordSearch(collection, query, topK, filters);
          break;
        case 'hybrid':
        default:
          passages = await this.#store.hybridSearch(
            collection,
            embResult.vector,
            query,
            topK,
            hybridAlpha,
            filters,
            rrfK,
          );
      }
      allPassages.push(...passages);
    }

    const searchLatencyMs = Date.now() - searchStart;
    emit('rag.search.end', {
      totalFound: allPassages.length,
      latencyMs: searchLatencyMs,
    });

    // ── 3. MERGE & DEDUPLICATE ───────────────────────────────────────────────
    const merged = deduplicatePassages(allPassages);

    // ── 4. RERANK (optional) ────────────────────────────────────────────────
    let finalPassages: Passage[];
    let rerankLatencyMs: number | undefined;
    let rerankTokens: number | undefined;
    let reranked = false;

    if (rerank && this.#reranker !== undefined) {
      emit('rag.rerank.start', { passageCount: merged.length });
      const rerankStart = Date.now();

      try {
        const estimatedRerankTokens = Math.ceil(
          (query.length + merged.reduce((sum, passage) => sum + passage.content.length, 0)) / 4,
        );
        const decision = await this.#tokens.checkLimits(
          context.tenantId,
          context.userId,
          estimatedRerankTokens,
        );
        if (decision.exceeded) {
          emit('tokens.limit.observed', {
            mode: decision.mode,
            operation: 'rag.rerank',
            estimatedTokens: decision.estimatedTokens,
            violation: decision.violation,
          });
        }
        if (!decision.allowed && decision.violation !== undefined) {
          throw new TokenLimitError(
            context.tenantId,
            decision.violation,
            decision.violation.scope === 'user' ? context.userId : undefined,
          );
        }

        const rerankResult = await this.#reranker.rerank(query, merged, finalTopK);
        finalPassages = rerankResult.passages;

        rerankLatencyMs = Date.now() - rerankStart;
        rerankTokens = rerankResult.tokensUsed;
        reranked = true;

        emit('rag.rerank.end', {
          latencyMs: rerankLatencyMs,
          finalCount: finalPassages.length,
        });

        // Track reranker token usage if reported.
        if (rerankTokens !== undefined && rerankTokens > 0) {
          await this.#tokens.record(context, {
            inputTokens: rerankTokens,
            outputTokens: 0,
            totalTokens: rerankTokens,
            provider: this.#reranker.name,
            model: rerankResult.model,
            toolName: 'rag.search',
          });
        }
      } catch (err) {
        if (err instanceof TokenLimitError) throw err;
        emit('rag.rerank.error', {
          error: err instanceof Error ? err.message : String(err),
          policy: rerankPolicy,
        });

        // A configured re-ranker that fails is a production incident, not a
        // detail to smooth over: it is the only stage producing absolute
        // relevance scores, so without it `minScore` stops discriminating and
        // the pipeline would return the nearest neighbours of *any* query as
        // confident matches. Under 'require' the failure is surfaced; only an
        // explicit 'degrade' falls back to retrieval order.
        if (rerankPolicy === 'require') {
          if (err instanceof RerankerError) throw err;
          throw new RerankerError(
            this.#reranker.name,
            'request',
            err instanceof Error ? err.message : String(err),
            { cause: err instanceof Error ? err : undefined },
          );
        }

        finalPassages = merged.sort((a, b) => b.score - a.score).slice(0, finalTopK);
      }
    } else {
      // No re-ranking requested, or no re-ranker configured at all. The policy
      // deliberately does not apply here: it governs the failure of a re-ranker
      // the deployment chose to run, not the absence of one. A re-ranker that is
      // configured but unreachable is caught at startup by `validateReranker()`.
      finalPassages = merged.sort((a, b) => b.score - a.score).slice(0, finalTopK);
    }

    // ── 5. FILTER BY minScore ────────────────────────────────────────────────
    if (minScore > 0) {
      finalPassages = finalPassages.filter((p) => p.score >= minScore);
    }

    const totalLatencyMs = Date.now() - pipelineStart;
    const metrics = {
      embeddingLatencyMs,
      searchLatencyMs,
      totalLatencyMs,
      ...(queryRewriteLatencyMs !== undefined && { queryRewriteLatencyMs }),
      ...(rerankLatencyMs !== undefined && { rerankLatencyMs }),
      ...(rerankTokens !== undefined && { tokensUsed: rerankTokens + embResult.tokensUsed }),
    };

    emit('rag.pipeline.complete', { totalLatencyMs, metrics });

    return {
      passages: finalPassages,
      totalFound: allPassages.length,
      query,
      collections,
      searchMode,
      reranked,
      metrics,
    };
  }

  /**
   * Formats a list of passages into a single string suitable for injection into
   * an LLM system prompt or user message.
   *
   * @param passages - Passages to format (typically from {@link search}).
   * @param options  - Formatting options.
   * @returns A formatted string with passages joined by the configured separator.
   */
  formatForContext(passages: Passage[], options: FormatOptions = {}): string {
    const {
      includeSource = true,
      includeScore = false,
      maxCharsPerPassage,
      template,
      separator = '\n---\n',
    } = options;

    const parts = passages.map((p) => {
      const content =
        maxCharsPerPassage !== undefined ? p.content.slice(0, maxCharsPerPassage) : p.content;

      const source = p.metadata.source ?? p.metadata.title ?? p.metadata.documentId;

      if (template !== undefined) {
        return template.replace('{{content}}', content).replace('{{source}}', source);
      }

      let text = content;
      if (includeSource) text += `\nSource: ${source}`;
      if (includeScore) text += `\nScore: ${p.score.toFixed(3)}`;
      return text;
    });

    return parts.join(separator);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges passages from multiple collections by:
 * 1. Normalising scores per-collection to [0, 1] via min-max scaling.
 * 2. Deduplicating by passage ID (keeping the highest score for each ID).
 * 3. Sorting the remaining passages by score descending.
 *
 * Input passages are never mutated — normalised copies are created internally.
 */
function deduplicatePassages(passages: Passage[]): Passage[] {
  if (passages.length === 0) return [];

  // Clone to avoid mutating the input.
  const cloned = passages.map((p) => ({ ...p }));

  // Group by collection.
  const byCollection = new Map<string, typeof cloned>();
  for (const p of cloned) {
    const group = byCollection.get(p.collection) ?? [];
    group.push(p);
    byCollection.set(p.collection, group);
  }

  // Min-max normalise scores within each collection.
  for (const group of byCollection.values()) {
    const max = Math.max(...group.map((p) => p.score));
    const min = Math.min(...group.map((p) => p.score));
    const range = max - min || 1;
    for (const p of group) {
      p.score = (p.score - min) / range;
    }
  }

  // Deduplicate by ID (keep highest score).
  const seen = new Map<string, (typeof cloned)[0]>();
  for (const p of cloned) {
    const existing = seen.get(p.id);
    if (existing === undefined || p.score > existing.score) {
      seen.set(p.id, p);
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}
