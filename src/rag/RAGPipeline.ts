import type { ExecutionContext } from '../types/index.js';
import type {
  Passage,
  RAGQuery,
  RAGResult,
  FormatOptions,
  RerankerValidation,
  ProviderProbe,
} from './types.js';
import type {
  CollectionConfig,
  ModelValidation,
  StopWordsApplyResult,
  QueryExpansionMode,
  QueryRewriteOutcome,
  QueryRewriterValidation,
  RAGTrace,
  RAGTraceCandidate,
} from '../types/index.js';
import type { EmbeddingRouter } from './embedding/EmbeddingRouter.js';
import type { VectorStoreAdapter } from './vectorstore/VectorStoreAdapter.js';
import type { RerankerProvider } from './reranker/RerankerProvider.js';
import type { QueryRewriter } from './queryRewriting/QueryRewriter.js';
import type { EventBus } from '../events/EventBus.js';
import type { TokenTracker } from '../tokens/TokenTracker.js';
import type { QueryExpander } from './queryRewriting/QueryExpander.js';
import { fuseRankedLists } from './fusion/RRF.js';
import type { GlossaryEntry, GlossaryParseResult, StopWords } from './lexicon/Lexicon.js';
import { matchGlossaryTerms, mergeGlossaries } from './lexicon/Lexicon.js';
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
  readonly #queryExpander: QueryExpander | undefined;
  readonly #stopWords: StopWords | undefined;
  readonly #glossary: GlossaryEntry[];
  readonly #maxGlossaryEntries: number;
  readonly #glossaryErrors: GlossaryParseResult['errors'];
  readonly #glossaryRewrite: boolean;
  readonly #stopWordsMode: 'auto' | 'native' | 'query';
  readonly #expansion: Required<Omit<RAGPipelineExpansionOptions, 'fallbackBelow'>> &
    Pick<RAGPipelineExpansionOptions, 'fallbackBelow'>;

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
   * @param options.queryExpander - Generates query variants for multi-query retrieval.
   * @param options.expansion - When to expand (`mode`, default `'off'`), the
   *                          fallback threshold and the fused-candidate cap.
   * @param options.lexicon - Stop words for the keyword component and the
   *                          installation glossary.
   */
  constructor(
    embeddingRouter: EmbeddingRouter,
    vectorStore: VectorStoreAdapter,
    reranker: RerankerProvider | undefined,
    eventBus: EventBus,
    tokenTracker: TokenTracker,
    queryRewriter?: QueryRewriter,
    defaultRerankPolicy: 'require' | 'degrade' = 'require',
    options: {
      queryExpander?: QueryExpander;
      expansion?: RAGPipelineExpansionOptions;
      lexicon?: RAGPipelineLexiconOptions;
    } = {},
  ) {
    this.#embedding = embeddingRouter;
    this.#store = vectorStore;
    this.#reranker = reranker;
    this.#bus = eventBus;
    this.#tokens = tokenTracker;
    this.#queryRewriter = queryRewriter;
    this.#defaultRerankPolicy = defaultRerankPolicy;
    this.#queryExpander = options.queryExpander;
    this.#stopWords = options.lexicon?.stopWords;
    this.#glossary = options.lexicon?.glossary ?? [];
    this.#maxGlossaryEntries = options.lexicon?.maxGlossaryEntries ?? 20;
    this.#glossaryErrors = options.lexicon?.glossaryErrors ?? [];
    this.#glossaryRewrite = options.lexicon?.glossaryRewrite ?? true;
    this.#stopWordsMode = options.lexicon?.stopWordsMode ?? 'auto';
    this.#expansion = {
      mode: options.expansion?.mode ?? 'off',
      maxCandidates: Math.max(1, options.expansion?.maxCandidates ?? 40),
      ...(options.expansion?.fallbackBelow !== undefined && {
        fallbackBelow: options.expansion.fallbackBelow,
      }),
    };
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

  /** The query rewriter applied before embedding, if any. */
  get queryRewriter(): QueryRewriter | undefined {
    return this.#queryRewriter;
  }

  /** The installation glossary (`rag.lexicon.glossaryFile`). */
  get glossary(): GlossaryEntry[] {
    return this.#glossary;
  }

  /**
   * Where stop words apply in this pipeline: `'native'` (the engine),
   * `'query'` (removed from the keyword query) or `'off'`.
   */
  get stopWordsApplication(): 'native' | 'query' | 'off' {
    if (this.#stopWords === undefined || !this.#stopWords.enabled) return 'off';
    if (this.#stopWordsMode === 'query') return 'query';
    if (this.#store.nativeStopWords !== 'none') return 'native';
    return this.#stopWordsMode === 'native' ? 'off' : 'query';
  }

  /**
   * Collection settings for native stop words at creation: the words for
   * `languages` and the languages themselves (pgvector picks its
   * text-search configuration from a single language). Empty when stop
   * words do not apply natively.
   */
  stopWordsForCreation(languages?: string[]): Pick<CollectionConfig, 'stopWords' | 'languages'> {
    if (this.stopWordsApplication !== 'native') return {};
    const words = this.#stopWords!.list(languages);
    return {
      ...(words.length > 0 && { stopWords: words }),
      ...(languages !== undefined && languages.length > 0 && { languages }),
    };
  }

  /**
   * Applies the stop words of `languages` natively to an existing collection,
   * or clears them when stop words are off or `stopWordsMode` is `'query'`
   * (so they are not applied twice). Engines that only take them at
   * creation (Milvus) report `creation_only`. On Meilisearch and pgvector this rewrites
   * the index, so call it when the languages or the lists change, not per search.
   *
   * @param collection - Collection to configure.
   * @param languages  - Languages of the collection (ISO 639-1).
   */
  async configureStopWords(
    collection: string,
    languages: string[] = [],
  ): Promise<StopWordsApplyResult> {
    const engine = this.#store.name;
    if (this.#store.nativeStopWords === 'none') {
      return { applied: false, engine, reason: 'not_supported' };
    }
    // Off, or applied from the query: clear the engine's list so stop words
    // are not applied twice.
    const words =
      this.#stopWords?.enabled === true && this.#stopWordsMode !== 'query'
        ? this.#stopWords.list(languages)
        : [];
    const result = await this.#store.applyStopWords(collection, { words, languages });
    this.#bus.emit('rag.collection.stop_words', { collection, languages, ...result });
    return result;
  }

  /** Lines of the installation glossary file that could not be read. */
  get glossaryErrors(): GlossaryParseResult['errors'] {
    return this.#glossaryErrors;
  }

  /** The query expander used for multi-query retrieval, if any. */
  get queryExpander(): QueryExpander | undefined {
    return this.#queryExpander;
  }

  /**
   * Probes the configured query expander with a real request.
   * Never throws: a failed probe is reported in the returned value.
   *
   * @returns A {@link ModelValidation} with role `'queryExpander'`.
   */
  async validateQueryExpander(): Promise<ModelValidation> {
    const expander = this.#queryExpander;
    if (expander === undefined)
      return { role: 'queryExpander', configured: false, available: false };
    const startMs = Date.now();
    let probe: ProviderProbe;
    try {
      probe = await expander.validate();
    } catch (err) {
      probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return {
      role: 'queryExpander',
      configured: true,
      provider: expander.provider,
      model: expander.model,
      available: probe.ok,
      latencyMs: Date.now() - startMs,
      ...(!probe.ok && { error: probe.error ?? 'the query expander probe did not succeed' }),
    };
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
   * Probes the configured query rewriter with a real request.
   *
   * A rewriter never fails a search — on any error it keeps the original
   * query — so a rewriter pointed at a model the credentials cannot access is
   * otherwise invisible: follow-up questions are just searched literally.
   * Call this at startup next to {@link validateReranker}.
   *
   * Never throws: a failed probe is reported in the returned value.
   *
   * @returns A {@link QueryRewriterValidation} describing configuration and reachability.
   */
  async validateQueryRewriter(): Promise<QueryRewriterValidation> {
    const rewriter = this.#queryRewriter;
    if (rewriter === undefined) {
      return { configured: false, available: false };
    }

    const startMs = Date.now();
    let probe: ProviderProbe;
    try {
      probe = await rewriter.validate();
    } catch (err) {
      probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - startMs;
    const identity = {
      strategy: rewriter.name,
      ...(rewriter.provider !== undefined && { provider: rewriter.provider }),
      ...(rewriter.model !== undefined && { model: rewriter.model }),
    };
    const error = probe.ok
      ? undefined
      : (probe.error ?? 'the query rewriter probe did not succeed');

    this.#bus.emit(probe.ok ? 'rag.query_rewriter.available' : 'rag.query_rewriter.unavailable', {
      ...identity,
      latencyMs,
      ...(error !== undefined && { error }),
    });

    return {
      configured: true,
      ...identity,
      available: probe.ok,
      latencyMs,
      ...(error !== undefined && { error }),
    };
  }

  /**
   * Probes an embedding provider by embedding a short text.
   *
   * Never throws: a failed probe is reported in the returned value.
   *
   * @param providerName - Embedding provider registered in the router.
   * @param model        - Model name to report (informational).
   * @returns A {@link ModelValidation} with role `'embedding'`.
   */
  async validateEmbedding(providerName: string, model?: string): Promise<ModelValidation> {
    const identity = {
      role: 'embedding' as const,
      provider: providerName,
      ...(model !== undefined && { model }),
    };
    if (!this.#embedding.listProviders().includes(providerName)) {
      return { ...identity, configured: false, available: false };
    }
    const startMs = Date.now();
    try {
      await this.#embedding.embed('health check', providerName);
      return { ...identity, configured: true, available: true, latencyMs: Date.now() - startMs };
    } catch (err) {
      return {
        ...identity,
        configured: true,
        available: false,
        latencyMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
    const emit: Emit = (type, data) => {
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
      languages,
    } = ragQuery;

    // Glossary entries the question uses (or the last user turn, for a
    // follow-up that refers back to a term): they steer the rewrite and the
    // expansion. Engine-agnostic — nothing is configured in the vector store.
    const lastUserTurn = [...(conversationHistory ?? [])]
      .reverse()
      .find((m) => m.role === 'user' && typeof m.content === 'string');
    const glossaryMatches = matchGlossaryTerms(
      mergeGlossaries(this.#glossary, ragQuery.glossary),
      [rawQuery, ...(lastUserTurn !== undefined ? [lastUserTurn.content as string] : [])],
      this.#maxGlossaryEntries,
    );
    const glossary = glossaryMatches.map((m) => m.entry);

    // ── 0. QUERY REWRITING (optional) ────────────────────────────────────────
    let query = rawQuery;
    let queryRewriteLatencyMs: number | undefined;
    let rewriteOutcome: QueryRewriteOutcome | undefined;
    if (this.#queryRewriter !== undefined) {
      const rewriteStart = Date.now();
      // On a first question the glossary alone makes the rewriter run (one
      // model call); `glossaryRewrite: false` keeps it for follow-ups.
      const hasHistory = (conversationHistory?.length ?? 0) > 0;
      const passGlossary = glossary.length > 0 && (hasHistory || this.#glossaryRewrite);
      rewriteOutcome = await this.#queryRewriter.rewriteWithOutcome(
        rawQuery,
        conversationHistory,
        passGlossary ? { glossary } : undefined,
      );
      query = rewriteOutcome.query;
      queryRewriteLatencyMs = Date.now() - rewriteStart;
      // A fallback is reported here, with the request context, so it reaches
      // the audit log attributed to the query that suffered it.
      emit('rag.query_rewrite.end', {
        latencyMs: queryRewriteLatencyMs,
        strategy: this.#queryRewriter.name,
        applied: rewriteOutcome.applied,
        ...(this.#queryRewriter.model !== undefined && { model: this.#queryRewriter.model }),
        ...(rewriteOutcome.fallbackReason !== undefined && {
          fallbackReason: rewriteOutcome.fallbackReason,
        }),
        ...(rewriteOutcome.error !== undefined && { error: rewriteOutcome.error }),
      });
    }

    // ── 1–3. EMBED, SEARCH, MERGE ────────────────────────────────────────────
    const providerName = await this.#embeddingProviderFor(collections);
    const retrieveParams: RetrieveParams = {
      providerName,
      collections,
      topK,
      searchMode,
      hybridAlpha,
      filters,
      rrfK,
      ...(languages !== undefined && { languages }),
    };
    const retrieval = await this.#retrieve(query, retrieveParams, context, emit);
    const stopWordsApplication = this.stopWordsApplication;
    const lexicon: RAGTrace['lexicon'] =
      stopWordsApplication !== 'off' || glossary.length > 0
        ? {
            ...(stopWordsApplication !== 'off' && { stopWords: stopWordsApplication }),
            ...(retrieval.stopWordsRemoved > 0 && { keywordQuery: retrieval.keywordText }),
            stopWordsRemoved: retrieval.stopWordsRemoved,
            glossaryTerms: glossaryMatches.map((m) => m.term),
          }
        : undefined;
    let candidates = retrieval.merged;
    let embeddingTokens = retrieval.embeddingTokens;
    let embeddingLatencyMs = retrieval.embeddingLatencyMs;
    let searchLatencyMs = retrieval.searchLatencyMs;
    let totalFound = retrieval.totalFound;
    const retrievalScores = new Map(candidates.map((p) => [p.id, p.score]));
    let foundBy: Map<string, number[]> | undefined;
    let expansion: RAGTrace['expansion'];
    let expansionLatencyMs: number | undefined;

    const mode: QueryExpansionMode =
      this.#queryExpander === undefined ? 'off' : (ragQuery.expansion ?? this.#expansion.mode);

    /** Generates variants, searches them and fuses every result list. */
    const expand = async (
      reason: 'always' | 'below_threshold' | 'no_candidates',
    ): Promise<void> => {
      const expander = this.#queryExpander!;
      const start = Date.now();
      const outcome = await expander.expand(query, glossary.length > 0 ? { glossary } : {});
      if ((outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0) > 0) {
        await this.#tokens.record(context, {
          inputTokens: outcome.inputTokens ?? 0,
          outputTokens: outcome.outputTokens ?? 0,
          totalTokens: (outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0),
          provider: expander.provider,
          model: expander.model,
          toolName: 'rag.search',
        });
      }
      const before = candidates.length;
      if (outcome.variants.length > 0) {
        const extra = await Promise.all(
          outcome.variants.map((v) => this.#retrieve(v, retrieveParams, context, emit)),
        );
        const lists = [candidates, ...extra.map((r) => r.merged)];
        foundBy = new Map();
        lists.forEach((list, index) => {
          for (const p of list) {
            foundBy!.set(p.id, [...(foundBy!.get(p.id) ?? []), index]);
            if (!retrievalScores.has(p.id)) retrievalScores.set(p.id, p.score);
          }
        });
        candidates = fuseRankedLists(lists, rrfK).slice(0, this.#expansion.maxCandidates);
        for (const r of extra) {
          embeddingTokens += r.embeddingTokens;
          embeddingLatencyMs += r.embeddingLatencyMs;
          searchLatencyMs += r.searchLatencyMs;
          totalFound += r.totalFound;
        }
      }
      expansionLatencyMs = Date.now() - start;
      expansion = {
        mode: mode === 'always' ? 'always' : 'fallback',
        triggered: true,
        reason,
        variants: outcome.variants,
        ...(outcome.error !== undefined && { error: outcome.error }),
        candidatesBefore: before,
        candidatesAfter: candidates.length,
      };
      emit('rag.query_expansion.end', {
        latencyMs: expansionLatencyMs,
        mode: expansion.mode,
        reason,
        variants: outcome.variants.length,
        candidatesBefore: before,
        candidatesAfter: candidates.length,
        model: expander.model,
        ...(outcome.error !== undefined && { error: outcome.error }),
      });
    };

    if (mode === 'always') await expand('always');

    // ── 4. RERANK (optional) ────────────────────────────────────────────────
    const rankParams: RankParams = { finalTopK, rerank, rerankPolicy };
    let ranking = await this.#rank(query, candidates, rankParams, context, emit);
    let rerankLatencyMs = ranking.rerankLatencyMs;
    let rerankTokens = ranking.rerankTokens;

    // ── 4b. FALLBACK EXPANSION ──────────────────────────────────────────────
    // Expand only when the plain search found nothing relevant: no candidates,
    // or (re-ranked) none reaching the threshold. Costs and latency fall only
    // on the searches that would otherwise end in "nothing found".
    if (mode === 'fallback') {
      const threshold = this.#expansion.fallbackBelow ?? minScore;
      const best = ranking.rankedAll[0]?.score ?? 0;
      const reason =
        candidates.length === 0
          ? ('no_candidates' as const)
          : ranking.reranked && threshold > 0 && best < threshold
            ? ('below_threshold' as const)
            : undefined;
      if (reason !== undefined) {
        await expand(reason);
        // Re-rank only when the variants brought something to rank again.
        if ((expansion?.variants.length ?? 0) > 0) {
          ranking = await this.#rank(query, candidates, rankParams, context, emit);
          if (ranking.rerankLatencyMs !== undefined) {
            rerankLatencyMs = (rerankLatencyMs ?? 0) + ranking.rerankLatencyMs;
          }
          if (ranking.rerankTokens !== undefined) {
            rerankTokens = (rerankTokens ?? 0) + ranking.rerankTokens;
          }
        }
      } else {
        expansion = {
          mode: 'fallback',
          triggered: false,
          variants: [],
          candidatesBefore: candidates.length,
          candidatesAfter: candidates.length,
        };
      }
    }

    // ── 5. FILTER BY minScore ────────────────────────────────────────────────
    let finalPassages = ranking.finalPassages;
    const beforeMinScore = finalPassages.length;
    if (minScore > 0) {
      finalPassages = finalPassages.filter((p) => p.score >= minScore);
    }

    const trace = buildTrace({
      originalQuery: rawQuery,
      searchQuery: query,
      ...(rewriteOutcome !== undefined &&
        this.#queryRewriter !== undefined && {
          rewrite: { strategy: this.#queryRewriter.name, outcome: rewriteOutcome },
        }),
      ...(expansion !== undefined && { expansion }),
      ...(lexicon !== undefined && { lexicon }),
      candidateCount: candidates.length,
      retrievalScores,
      ...(foundBy !== undefined && { foundBy }),
      rankedAll: ranking.rankedAll,
      reranked: ranking.reranked,
      finalTopK,
      minScore,
      droppedByMinScore: beforeMinScore - finalPassages.length,
    });

    const totalLatencyMs = Date.now() - pipelineStart;
    const llmTokens = rerankTokens ?? 0;
    const metrics = {
      embeddingLatencyMs,
      searchLatencyMs,
      totalLatencyMs,
      ...(queryRewriteLatencyMs !== undefined && { queryRewriteLatencyMs }),
      ...(expansionLatencyMs !== undefined && { expansionLatencyMs }),
      ...(rerankLatencyMs !== undefined && { rerankLatencyMs }),
      ...(rerankTokens !== undefined && { tokensUsed: llmTokens + embeddingTokens }),
    };

    emit('rag.pipeline.complete', {
      totalLatencyMs,
      metrics,
      passageCount: finalPassages.length,
      droppedByMinScore: trace.droppedByMinScore,
      trace,
    });

    return {
      passages: finalPassages,
      totalFound,
      query,
      collections,
      searchMode,
      reranked: ranking.reranked,
      metrics,
      trace,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search stages
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The embedding provider shared by `collections`, read from their metadata.
   *
   * @throws {@link RAGError} when the collections use different providers or
   *         none has SDK metadata.
   */
  async #embeddingProviderFor(collections: string[]): Promise<string> {
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
    return collWithMeta.embeddingModel.split('/')[0]!;
  }

  /** Embeds `text`, searches every collection and merges the results. */
  async #retrieve(
    text: string,
    params: RetrieveParams,
    context: ExecutionContext,
    emit: Emit,
  ): Promise<RetrieveResult> {
    const { providerName, collections, topK, searchMode, hybridAlpha, filters, rrfK } = params;
    // The keyword component gets the text without stop words; the vector
    // component always gets the full text.
    const keyword =
      this.stopWordsApplication === 'query'
        ? this.#stopWords!.keywordQuery(text, params.languages)
        : { text, removed: 0 };

    // ── EMBED ────────────────────────────────────────────────────────────
    emit('rag.embed.start', { query: text });
    const embedStart = Date.now();
    const embResult = await this.#embedding.embed(text, providerName);
    // The query embedding is billed too: record it like the re-ranker's tokens.
    if (embResult.tokensUsed > 0) {
      await this.#tokens.record(context, {
        inputTokens: embResult.tokensUsed,
        outputTokens: 0,
        totalTokens: embResult.tokensUsed,
        provider: providerName,
        model: embResult.model,
        toolName: 'rag.search',
      });
    }
    const embeddingLatencyMs = Date.now() - embedStart;
    emit('rag.embed.end', { latencyMs: embeddingLatencyMs, dimensions: embResult.dimensions });

    // ── SEARCH ───────────────────────────────────────────────────────────
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
          passages = await this.#store.keywordSearch(collection, keyword.text, topK, filters);
          break;
        case 'hybrid':
        default:
          passages = await this.#store.hybridSearch(
            collection,
            embResult.vector,
            keyword.text,
            topK,
            hybridAlpha,
            filters,
            rrfK,
          );
      }
      allPassages.push(...passages);
    }
    const searchLatencyMs = Date.now() - searchStart;
    emit('rag.search.end', { totalFound: allPassages.length, latencyMs: searchLatencyMs });

    return {
      merged: deduplicatePassages(allPassages),
      keywordText: keyword.text,
      stopWordsRemoved: keyword.removed,
      totalFound: allPassages.length,
      embeddingTokens: embResult.tokensUsed,
      embeddingLatencyMs,
      searchLatencyMs,
    };
  }

  /** Re-ranks `candidates` against `query` (or orders them by retrieval score). */
  async #rank(
    query: string,
    candidates: Passage[],
    params: RankParams,
    context: ExecutionContext,
    emit: Emit,
  ): Promise<RankResult> {
    const { finalTopK, rerank, rerankPolicy } = params;
    let rankedAll: Passage[] = [];
    let rerankLatencyMs: number | undefined;
    let rerankTokens: number | undefined;

    if (rerank && this.#reranker !== undefined) {
      emit('rag.rerank.start', { passageCount: candidates.length });
      const rerankStart = Date.now();

      try {
        const estimatedRerankTokens = Math.ceil(
          (query.length + candidates.reduce((sum, passage) => sum + passage.content.length, 0)) / 4,
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

        // Score every candidate, not just the top `finalTopK`: the re-ranker
        // reads them all anyway, and the scores of the ones below the cut are
        // what the trace needs to explain a missing passage.
        const rerankResult = await this.#reranker.rerank(query, candidates, candidates.length);
        rankedAll = rerankResult.passages;
        const finalPassages = rankedAll.slice(0, finalTopK);

        rerankLatencyMs = Date.now() - rerankStart;
        rerankTokens = rerankResult.tokensUsed;

        emit('rag.rerank.end', {
          latencyMs: rerankLatencyMs,
          // Before `minScore`: the count after the cut is in `rag.pipeline.complete`.
          finalCount: finalPassages.length,
          candidateCount: candidates.length,
        });

        // Track reranker token usage if reported.
        if (rerankTokens !== undefined && rerankTokens > 0) {
          await this.#tokens.record(context, {
            inputTokens: rerankTokens,
            outputTokens: 0,
            totalTokens: rerankTokens,
            provider: this.#reranker.billingProvider,
            model: rerankResult.model,
            toolName: 'rag.search',
          });
        }
        return {
          rankedAll,
          finalPassages,
          reranked: true,
          rerankLatencyMs,
          ...(rerankTokens !== undefined && { rerankTokens }),
        };
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
      }
    }
    // No re-ranking requested, no re-ranker configured, or a degraded failure.
    // The policy deliberately does not apply to a missing re-ranker: it governs
    // the failure of one the deployment chose to run. A re-ranker that is
    // configured but unreachable is caught at startup by `validateReranker()`.
    rankedAll = [...candidates].sort((a, b) => b.score - a.score);
    return { rankedAll, finalPassages: rankedAll.slice(0, finalTopK), reranked: false };
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
      sourceLabel = 'title',
      includeScore = false,
      maxCharsPerPassage,
      template,
      separator = '\n---\n',
    } = options;

    const parts = passages.map((p) => {
      const content =
        maxCharsPerPassage !== undefined ? p.content.slice(0, maxCharsPerPassage) : p.content;

      const source =
        sourceLabel === 'source'
          ? (p.metadata.source ?? p.metadata.title ?? p.metadata.documentId)
          : (p.metadata.title ?? p.metadata.source ?? p.metadata.documentId);

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

/** Emits a pipeline event with the request context attached. */
type Emit = (type: string, data: Record<string, unknown>) => void;

/** Parameters of one retrieval pass (embed, search, merge). */
interface RetrieveParams {
  providerName: string;
  collections: string[];
  topK: number;
  searchMode: RAGQuery['searchMode'];
  hybridAlpha: number;
  filters: RAGQuery['filters'];
  rrfK: number;
  languages?: string[];
}

/** Result of one retrieval pass. */
interface RetrieveResult {
  merged: Passage[];
  keywordText: string;
  stopWordsRemoved: number;
  totalFound: number;
  embeddingTokens: number;
  embeddingLatencyMs: number;
  searchLatencyMs: number;
}

/** Parameters of the ranking stage. */
interface RankParams {
  finalTopK: number;
  rerank: boolean;
  rerankPolicy: 'require' | 'degrade';
}

/** Result of the ranking stage. */
interface RankResult {
  rankedAll: Passage[];
  finalPassages: Passage[];
  reranked: boolean;
  rerankLatencyMs?: number;
  rerankTokens?: number;
}

/** When and how the pipeline expands queries (see {@link RAGPipeline}). */
export interface RAGPipelineExpansionOptions {
  /** Default expansion mode; `RAGQuery.expansion` overrides it. Default `'off'`. */
  mode?: QueryExpansionMode;
  /** `fallback` expands when the best re-ranked score is below this. Default: the query's `minScore`. */
  fallbackBelow?: number;
  /** Cap on fused candidates sent to the re-ranker after an expansion. Default 40. */
  maxCandidates?: number;
}

/** Stop words and installation glossary of the pipeline (`rag.lexicon`). */
export interface RAGPipelineLexiconOptions {
  /** Removes stop words from the keyword component of every search. */
  stopWords?: StopWords;
  /** Installation glossary; a search's own `glossary` is merged over it. */
  glossary?: GlossaryEntry[];
  /** Most glossary entries passed to the rewriter and expander per search. Default 20. */
  maxGlossaryEntries?: number;
  /**
   * Whether the rewriter runs on a question without history only because it
   * uses glossary terms. Default `true`.
   */
  glossaryRewrite?: boolean;
  /** Where stop words apply: `'auto'` (default), `'native'` or `'query'`. */
  stopWordsMode?: 'auto' | 'native' | 'query';
  /** Lines of the glossary file that could not be read (reported, not used). */
  glossaryErrors?: GlossaryParseResult['errors'];
}

/** Inputs of {@link buildTrace}. */
interface TraceInput {
  originalQuery: string;
  searchQuery: string;
  rewrite?: { strategy: string; outcome: QueryRewriteOutcome };
  expansion?: RAGTrace['expansion'];
  lexicon?: RAGTrace['lexicon'];
  /** Candidates sent to ranking (after any expansion). */
  candidateCount: number;
  /** Retrieval score of each candidate (normalised, from the first search that found it). */
  retrievalScores: Map<string, number>;
  /** Which searches returned each candidate, when the query was expanded. */
  foundBy?: Map<string, number[]>;
  /** Every candidate in final ranking order (re-ranker scores when re-ranked). */
  rankedAll: Passage[];
  reranked: boolean;
  finalTopK: number;
  minScore: number;
  droppedByMinScore: number;
}

/**
 * Builds the {@link RAGTrace} of one search: identifiers and scores of every
 * candidate, and where each one ended up.
 */
function buildTrace(input: TraceInput): RAGTrace {
  const retrievalScore = input.retrievalScores;
  const candidates: RAGTraceCandidate[] = input.rankedAll.map((p, index) => {
    let stage: RAGTraceCandidate['stage'];
    if (index >= input.finalTopK) stage = 'beyond_final_top_k';
    else if (input.minScore > 0 && p.score < input.minScore) stage = 'below_min_score';
    else stage = 'final';
    return {
      id: p.id,
      documentId: p.metadata.documentId,
      ...(p.metadata.chunkIndex !== undefined && { chunkIndex: p.metadata.chunkIndex }),
      retrievalScore: retrievalScore.get(p.id) ?? p.score,
      ...(input.reranked && { rerankScore: p.score }),
      ...(input.foundBy?.has(p.id) === true && { foundBy: input.foundBy.get(p.id)! }),
      stage,
    };
  });

  let rewrite: RAGTrace['rewrite'];
  if (input.rewrite !== undefined) {
    const { outcome } = input.rewrite;
    rewrite = {
      strategy: input.rewrite.strategy,
      applied: outcome.applied,
      ...(outcome.fallbackReason !== undefined && { fallbackReason: outcome.fallbackReason }),
      ...(outcome.error !== undefined && { error: outcome.error }),
    };
  }

  return {
    originalQuery: input.originalQuery,
    searchQuery: input.searchQuery,
    ...(rewrite !== undefined && { rewrite }),
    ...(input.expansion !== undefined && { expansion: input.expansion }),
    ...(input.lexicon !== undefined && { lexicon: input.lexicon }),
    minScore: input.minScore,
    finalTopK: input.finalTopK,
    candidateCount: input.candidateCount,
    droppedByMinScore: input.droppedByMinScore,
    candidates,
  };
}

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
