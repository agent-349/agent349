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
  DocumentStatus,
  DocumentRelationType,
  PassageNote,
  ReferenceResolver,
  ContextGuidanceTexts,
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
import type { ReferenceExtractor } from './references/ReferenceExtractor.js';
import { REF_TAG, REL_TAG } from './references/documentTags.js';
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
  readonly #references: Required<Omit<RAGPipelineReferenceOptions, 'extractor'>> & {
    extractor?: ReferenceExtractor;
  };
  readonly #relations: Required<RAGPipelineRelationOptions>;
  readonly #validity: Required<RAGPipelineValidityOptions>;
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
      references?: RAGPipelineReferenceOptions;
      relations?: RAGPipelineRelationOptions;
      validity?: RAGPipelineValidityOptions;
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
    this.#references = {
      mode: options.references?.mode ?? 'off',
      maxTargets: Math.max(1, options.references?.maxTargets ?? 3),
      perTarget: Math.max(1, options.references?.perTarget ?? 3),
      ...(options.references?.extractor !== undefined && {
        extractor: options.references.extractor,
      }),
    };
    this.#relations = {
      mode: options.relations?.mode ?? 'off',
      maxSources: Math.max(1, options.relations?.maxSources ?? 3),
      perSource: Math.max(1, options.relations?.perSource ?? 3),
    };
    this.#validity = {
      mode: options.validity?.mode ?? 'off',
      inactive: options.validity?.inactive ?? 'flag',
      priorityWeight: Math.min(1, Math.max(0, options.validity?.priorityWeight ?? 0.1)),
    };
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

    // ── 4c. VALIDITY AND PRIORITY (optional) ───────────────────────────────
    // Before the final cut, so that an excluded (inactive) passage leaves room
    // for the next one and priority can change what makes the cut.
    const relationMode = ragQuery.relations ?? this.#relations.mode;
    const validityMode = ragQuery.validity ?? this.#validity.mode;
    const statusOn = relationMode === 'on' || validityMode === 'on';
    const statuses = new Map<string, DocumentStatus>();
    const statusParams: RetrieveParams = { ...retrieveParams, filters: securityFilters(filters) };
    const describe = async (passages: Passage[]): Promise<void> => {
      const unknown = [
        ...new Set(passages.map((p) => p.metadata.documentId).filter((d) => !statuses.has(d))),
      ];
      if (unknown.length === 0) return;
      const found =
        ragQuery.describeDocuments !== undefined
          ? await ragQuery.describeDocuments(unknown)
          : await this.#describeFromIndex(
              query,
              passages.filter((p) => unknown.includes(p.metadata.documentId)),
              relationMode === 'on',
              statusParams,
              retrieval.vector,
              context,
              emit,
            );
      for (const id of unknown) statuses.set(id, found[id] ?? {});
    };
    const excluded: NonNullable<RAGTrace['status']>['excluded'] = [];
    const excludedPassages: Passage[] = [];
    let statusLatencyMs = 0;
    if (statusOn && ranking.rankedAll.length > 0) {
      const t0 = Date.now();
      await describe(ranking.rankedAll);
      let rankedAll = ranking.rankedAll;
      if (validityMode === 'on' && this.#validity.inactive === 'exclude') {
        rankedAll = rankedAll.filter((p) => {
          const reason = inactiveReason(statuses.get(p.metadata.documentId));
          if (reason === undefined) return true;
          excluded.push({ id: p.id, documentId: p.metadata.documentId, reason });
          excludedPassages.push(p);
          return false;
        });
      }
      const w = this.#validity.priorityWeight;
      if (validityMode === 'on' && w > 0) {
        const bonus = (p: Passage): number => {
          const prio = statuses.get(p.metadata.documentId)?.priority;
          return prio === 'high' ? w : prio === 'low' ? -w : 0;
        };
        rankedAll = rankedAll
          .map((p, i) => ({ p, i, s: p.score + bonus(p) }))
          .sort((a, b) => b.s - a.s || a.i - b.i)
          .map((x) => x.p);
      }
      if (rankedAll !== ranking.rankedAll) {
        ranking = { ...ranking, rankedAll, finalPassages: rankedAll.slice(0, finalTopK) };
      }
      statusLatencyMs += Date.now() - t0;
    }

    // ── 5. FILTER BY minScore ────────────────────────────────────────────────
    let finalPassages = ranking.finalPassages;
    const beforeMinScore = finalPassages.length;
    if (minScore > 0) {
      finalPassages = finalPassages.filter((p) => p.score >= minScore);
    }
    const droppedByMinScore = beforeMinScore - finalPassages.length;

    // ── 6. REFERENCES (optional) ─────────────────────────────────────────────
    // Documents cited by the context passages ("Anexo XIV") are searched with
    // the same question; what passes the re-ranker and minScore joins the
    // result. Cited documents that are not in the collection are reported.
    let references: RAGTrace['references'];
    let referencesLatencyMs: number | undefined;
    const referenceMode = ragQuery.references ?? this.#references.mode;
    if (
      referenceMode === 'follow' &&
      this.#references.extractor !== undefined &&
      finalPassages.length > 0
    ) {
      const refStart = Date.now();
      // Without a host resolver, the identity tags written at ingestion (`ref:<key>`).
      const resolver =
        ragQuery.resolveReferences ??
        this.#tagResolver(query, statusParams, retrieval.vector, context, emit);
      const followed = await this.#followReferences(
        query,
        finalPassages,
        resolver,
        this.#references.extractor,
        { ...retrieveParams, filters: securityFilters(filters) },
        retrieval.vector,
        { finalTopK, rerank, rerankPolicy, minScore },
        context,
        emit,
      );
      references = followed.trace;
      finalPassages = [...finalPassages, ...followed.added];
      referencesLatencyMs = Date.now() - refStart;
      emit('rag.references.end', {
        latencyMs: referencesLatencyMs,
        followed: references.followed.length,
        added: followed.added.length,
        missing: references.missing.map((m) => m.key),
      });
    }

    // ── 7. RELATIONS AND STATUS NOTES (optional) ─────────────────────────────
    // Documents that repeal, amend or regulate those in the context are
    // searched with the same question; every passage gets its status notes.
    let status: RAGTrace['status'];
    if (statusOn && (finalPassages.length > 0 || excludedPassages.length > 0)) {
      const t0 = Date.now();
      await describe(finalPassages);
      const followedRelations: NonNullable<RAGTrace['status']>['followed'] = [];
      const sourceNotes = new Map<string, PassageNote[]>();
      if (relationMode === 'on') {
        const inContext = new Set(finalPassages.map((p) => p.metadata.documentId));
        const plan: {
          type: DocumentRelationType;
          status: 'proposed' | 'confirmed';
          from: string;
          to: Passage;
        }[] = [];
        const planned = new Set<string>();
        // An excluded (repealed) document still leads to the one that replaces it.
        const excludedDocs = new Map<string, Passage>();
        for (const p of excludedPassages) {
          if (!excludedDocs.has(p.metadata.documentId)) excludedDocs.set(p.metadata.documentId, p);
        }
        for (const p of [...finalPassages, ...excludedDocs.values()]) {
          for (const r of statuses.get(p.metadata.documentId)?.incoming ?? []) {
            if (inContext.has(r.fromDocumentId) || planned.has(r.fromDocumentId)) continue;
            if (planned.size >= this.#relations.maxSources) break;
            planned.add(r.fromDocumentId);
            plan.push({ type: r.type, status: r.status, from: r.fromDocumentId, to: p });
          }
        }
        if (plan.length > 0) {
          const added = await this.#searchDocuments(
            query,
            plan.map((x) => [x.from]),
            this.#relations.perSource,
            statusParams,
            retrieval.vector,
            { finalTopK, rerank, rerankPolicy, minScore },
            new Set(finalPassages.map((p) => p.id)),
            context,
            emit,
          );
          plan.forEach((x, i) => {
            const got = added[i] ?? [];
            followedRelations.push({
              type: x.type,
              status: x.status,
              fromDocumentId: x.from,
              toDocumentId: x.to.metadata.documentId,
              added: got.map(passageRef),
            });
            const label = x.to.metadata.title ?? x.to.metadata.documentId;
            const rel = (statuses.get(x.to.metadata.documentId)?.incoming ?? []).find(
              (r) => r.fromDocumentId === x.from,
            );
            const note: PassageNote = {
              kind: 'relation_source',
              relation: x.type,
              status: x.status,
              documentId: x.to.metadata.documentId,
              label,
              ...(rel?.articles !== undefined && { articles: rel.articles }),
              text: sourceNoteText(x.type, x.status, label, rel?.articles),
            };
            for (const p of got) sourceNotes.set(p.id, [note]);
          });
          finalPassages = [...finalPassages, ...added.flat()];
          await describe(finalPassages);
        }
      }
      const kindsByDoc = new Map<string, Set<PassageNote['kind']>>();
      finalPassages = finalPassages.map((p) => {
        const notes = [
          ...(sourceNotes.get(p.id) ?? []),
          ...notesFor(statuses.get(p.metadata.documentId), validityMode === 'on'),
        ];
        if (notes.length === 0) return p;
        const kinds = kindsByDoc.get(p.metadata.documentId) ?? new Set();
        notes.forEach((n) => kinds.add(n.kind));
        kindsByDoc.set(p.metadata.documentId, kinds);
        return { ...p, notes };
      });
      status = {
        notes: [...kindsByDoc].map(([documentId, kinds]) => ({ documentId, kinds: [...kinds] })),
        excluded,
        followed: followedRelations,
      };
      statusLatencyMs += Date.now() - t0;
      emit('rag.status.end', {
        latencyMs: statusLatencyMs,
        excluded: excluded.length,
        followed: followedRelations.length,
        added: followedRelations.reduce((n, f) => n + f.added.length, 0),
        notes: status.notes.length,
      });
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
      ...(references !== undefined && { references }),
      ...(status !== undefined && { status }),
      candidateCount: candidates.length,
      retrievalScores,
      ...(foundBy !== undefined && { foundBy }),
      rankedAll: ranking.rankedAll,
      reranked: ranking.reranked,
      finalTopK,
      minScore,
      droppedByMinScore,
    });

    const totalLatencyMs = Date.now() - pipelineStart;
    const llmTokens = rerankTokens ?? 0;
    const metrics = {
      embeddingLatencyMs,
      searchLatencyMs,
      totalLatencyMs,
      ...(queryRewriteLatencyMs !== undefined && { queryRewriteLatencyMs }),
      ...(expansionLatencyMs !== undefined && { expansionLatencyMs }),
      ...(referencesLatencyMs !== undefined && { referencesLatencyMs }),
      ...(statusOn && { statusLatencyMs }),
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
    precomputedVector?: number[],
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
    // A follow-up search of the same text reuses the query vector (no new embedding).
    const embResult =
      precomputedVector !== undefined
        ? {
            vector: precomputedVector,
            tokensUsed: 0,
            model: '',
            dimensions: precomputedVector.length,
          }
        : await this.#embedding.embed(text, providerName);
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
      vector: embResult.vector,
      keywordText: keyword.text,
      stopWordsRemoved: keyword.removed,
      totalFound: allPassages.length,
      embeddingTokens: embResult.tokensUsed,
      embeddingLatencyMs,
      searchLatencyMs,
    };
  }

  /**
   * Follows the references of the context passages: resolves their keys with
   * the host's resolver, searches each cited document (not already in the
   * context) with the same question and query vector, re-ranks the new
   * passages and keeps those reaching `minScore`. Reports cited documents
   * that are not in the collection.
   */
  async #followReferences(
    query: string,
    passages: Passage[],
    resolve: NonNullable<RAGQuery['resolveReferences']>,
    extractor: ReferenceExtractor,
    params: RetrieveParams,
    vector: number[],
    rank: RankParams & { minScore: number },
    context: ExecutionContext,
    emit: Emit,
  ): Promise<{ trace: NonNullable<RAGTrace['references']>; added: Passage[] }> {
    // References in order of the passages (best first), first citing passage wins.
    const cited = new Map<string, { label: string; from: Passage }>();
    for (const p of passages) {
      for (const ref of extractor.extract(p.content)) {
        if (!cited.has(ref.key)) cited.set(ref.key, { label: ref.label, from: p });
      }
    }
    const out: NonNullable<RAGTrace['references']> = { followed: [], missing: [] };
    if (cited.size === 0) return { trace: out, added: [] };
    const resolved = await resolve([...cited.keys()]);
    const inContext = new Set(passages.map((p) => p.metadata.documentId));
    const searched = new Set<string>();
    const plan: { key: string; label: string; from: Passage; targets: string[] }[] = [];
    for (const [key, { label, from }] of cited) {
      const docs = resolved[key] ?? [];
      const others = docs.filter((d) => d !== from.metadata.documentId);
      if (docs.length === 0) {
        out.missing.push({
          key,
          label,
          fromPassageId: from.id,
          fromDocumentId: from.metadata.documentId,
        });
        continue;
      }
      // Self-reference ("Anexo XIV" inside the Anexo XIV) or already in context: nothing to add.
      const targets = others.filter((d) => !inContext.has(d) && !searched.has(d));
      if (targets.length === 0 || searched.size >= this.#references.maxTargets) continue;
      const take = targets.slice(0, this.#references.maxTargets - searched.size);
      take.forEach((d) => searched.add(d));
      plan.push({ key, label, from, targets: take });
    }
    if (plan.length === 0) return { trace: out, added: [] };

    // Same question and vector, restricted to each cited document.
    const perItem = await this.#searchDocuments(
      query,
      plan.map((item) => item.targets),
      this.#references.perTarget,
      params,
      vector,
      rank,
      new Set(passages.map((p) => p.id)),
      context,
      emit,
    );
    plan.forEach((item, index) => {
      out.followed.push({
        key: item.key,
        label: item.label,
        fromPassageId: item.from.id,
        fromDocumentId: item.from.metadata.documentId,
        targets: item.targets,
        added: (perItem[index] ?? []).map(passageRef),
      });
    });
    const added = perItem.flat();
    return { trace: out, added };
  }

  /**
   * Searches each group of documents with the same question and vector,
   * re-ranks the new passages together and keeps those reaching `minScore`.
   * Returns the passages kept for each group, best first.
   */
  async #searchDocuments(
    query: string,
    groups: string[][],
    perGroup: number,
    params: RetrieveParams,
    vector: number[],
    rank: RankParams & { minScore: number },
    seen: Set<string>,
    context: ExecutionContext,
    emit: Emit,
  ): Promise<Passage[][]> {
    const found = await Promise.all(
      groups.map((documentIds) =>
        this.#retrieve(
          query,
          { ...params, topK: perGroup, filters: { ...params.filters, documentId: documentIds } },
          context,
          emit,
          vector,
        ),
      ),
    );
    const fresh: { passage: Passage; group: number }[] = [];
    found.forEach((r, group) => {
      for (const p of r.merged) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fresh.push({ passage: p, group });
      }
    });
    if (fresh.length === 0) return groups.map(() => []);
    const ranked = await this.#rank(
      query,
      fresh.map((f) => f.passage),
      { ...rank, finalTopK: fresh.length },
      context,
      emit,
    );
    const groupOf = new Map(fresh.map((f) => [f.passage.id, f.group]));
    const kept = ranked.rankedAll.filter((p) => rank.minScore <= 0 || p.score >= rank.minScore);
    return groups.map((_, g) => kept.filter((p) => groupOf.get(p.id) === g));
  }

  /**
   * Resolver built on the identity tags written at ingestion (`ref:<key>`):
   * one filtered search per key (no embedding), up to `maxTargets` documents each.
   */
  #tagResolver(
    query: string,
    params: RetrieveParams,
    vector: number[],
    context: ExecutionContext,
    emit: Emit,
  ): ReferenceResolver {
    return async (keys) => {
      const take = keys.slice(0, MAX_TAG_LOOKUPS);
      const found = await Promise.all(
        take.map((key) =>
          this.#retrieve(
            query,
            {
              ...params,
              topK: this.#references.maxTargets,
              filters: { ...params.filters, tags: [`${REF_TAG}${key}`] },
            },
            context,
            emit,
            vector,
          ),
        ),
      );
      const out: Record<string, string[]> = {};
      take.forEach((key, i) => {
        out[key] = [...new Set(found[i]!.merged.map((p) => p.metadata.documentId))];
      });
      return out;
    };
  }

  /**
   * Status of documents from the index itself, for hosts without
   * `describeDocuments`: validity from `metadata.custom`, and relations from
   * the tags written at ingestion — documents tagged `rel:<type>:<key>` for a
   * key that identifies one of `passages`' documents. Relations found this way
   * are proposals.
   */
  async #describeFromIndex(
    query: string,
    passages: Passage[],
    withRelations: boolean,
    params: RetrieveParams,
    vector: number[],
    context: ExecutionContext,
    emit: Emit,
  ): Promise<Record<string, DocumentStatus>> {
    const out: Record<string, DocumentStatus> = {};
    const keysByDoc = new Map<string, string[]>();
    for (const p of passages) {
      const id = p.metadata.documentId;
      if (out[id] === undefined) out[id] = statusFromMetadata(p.metadata.custom);
      if (!keysByDoc.has(id)) {
        keysByDoc.set(
          id,
          (p.metadata.tags ?? [])
            .filter((t) => t.startsWith(REF_TAG))
            .map((t) => t.slice(REF_TAG.length)),
        );
      }
    }
    if (!withRelations) return out;
    const tags = [...new Set([...keysByDoc.values()].flat())].flatMap((k) =>
      RELATION_TYPES.map((t) => `${REL_TAG}${t}:${k}`),
    );
    if (tags.length === 0) return out;
    const found = await this.#retrieve(
      query,
      {
        ...params,
        topK: this.#relations.maxSources * this.#relations.perSource * 2,
        filters: { ...params.filters, tags },
      },
      context,
      emit,
      vector,
    );
    for (const [docId, keys] of keysByDoc) {
      const incoming = new Map<string, NonNullable<DocumentStatus['incoming']>[number]>();
      for (const p of found.merged) {
        const from = p.metadata.documentId;
        if (from === docId) continue;
        for (const t of p.metadata.tags ?? []) {
          if (!t.startsWith(REL_TAG)) continue;
          const [type, ...rest] = t.slice(REL_TAG.length).split(':');
          if (!keys.includes(rest.join(':'))) continue;
          const id = `${from}|${type}`;
          if (!incoming.has(id)) {
            incoming.set(id, {
              type: type as DocumentRelationType,
              fromDocumentId: from,
              ...(p.metadata.title !== undefined && { fromLabel: p.metadata.title }),
              status: 'proposed',
            });
          }
        }
      }
      if (incoming.size > 0) out[docId] = { ...out[docId], incoming: [...incoming.values()] };
    }
    return out;
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
      includeNotes = true,
      noteText = (n: PassageNote): string => n.text,
      notesLabel = 'Status',
    } = options;

    const parts = passages.map((p) => {
      const content =
        maxCharsPerPassage !== undefined ? p.content.slice(0, maxCharsPerPassage) : p.content;

      const source =
        sourceLabel === 'source'
          ? (p.metadata.source ?? p.metadata.title ?? p.metadata.documentId)
          : (p.metadata.title ?? p.metadata.source ?? p.metadata.documentId);

      const notes =
        includeNotes && p.notes !== undefined && p.notes.length > 0
          ? p.notes.map(noteText).join(' ')
          : '';

      if (template !== undefined) {
        return template
          .replace('{{content}}', content)
          .replace('{{source}}', source)
          .replace('{{notes}}', notes);
      }

      let text = content;
      if (includeSource) text += `\nSource: ${source}`;
      if (notes !== '') text += `\n${notesLabel}: ${notes}`;
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
  vector: number[];
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

/** Reference following of the pipeline (`rag.references`). */
export interface RAGPipelineReferenceOptions {
  /** Default mode; `RAGQuery.references` overrides it. Default `'off'`. */
  mode?: 'off' | 'follow';
  /** Most cited documents searched per query. Default 3. */
  maxTargets?: number;
  /** Passages searched per cited document. Default 3. */
  perTarget?: number;
  /** Finds the references in the passages. */
  extractor?: ReferenceExtractor;
}

/** Relations between documents in the pipeline (`rag.relations`). */
export interface RAGPipelineRelationOptions {
  /** Default mode; `RAGQuery.relations` overrides it. Default `'off'`. */
  mode?: 'off' | 'on';
  /** Most related documents searched per query. Default 3. */
  maxSources?: number;
  /** Passages searched per related document. Default 3. */
  perSource?: number;
}

/** Validity, version and priority in the pipeline (`rag.validity`). */
export interface RAGPipelineValidityOptions {
  /** Default mode; `RAGQuery.validity` overrides it. Default `'off'`. */
  mode?: 'off' | 'on';
  /** Inactive documents (expired, confirmed total repeal): `'flag'` (default) or `'exclude'`. */
  inactive?: 'flag' | 'exclude';
  /** Score added for high priority and subtracted for low when ranking. Default 0.1. */
  priorityWeight?: number;
}

const RELATION_TYPES: DocumentRelationType[] = ['derogates', 'modifies', 'regulates'];
/** Most reference keys resolved through tags per search. */
const MAX_TAG_LOOKUPS = 12;

/** Reference of a passage in a trace. */
function passageRef(p: Passage): {
  id: string;
  documentId: string;
  chunkIndex?: number;
  score: number;
} {
  return {
    id: p.id,
    documentId: p.metadata.documentId,
    ...(p.metadata.chunkIndex !== undefined && { chunkIndex: p.metadata.chunkIndex }),
    score: p.score,
  };
}

/** ISO date (YYYY-MM-DD) of a date-like value, or undefined. */
function isoDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Validity from chunk metadata (`custom.validFrom|validTo|version|priority`). */
function statusFromMetadata(custom: Record<string, unknown> | undefined): DocumentStatus {
  if (custom === undefined) return {};
  const validFrom = isoDate(custom.validFrom);
  const validTo = isoDate(custom.validTo);
  const prio = custom.priority;
  return {
    ...(validFrom !== undefined && { validFrom }),
    ...(validTo !== undefined && { validTo }),
    ...(typeof custom.version === 'string' && custom.version !== '' && { version: custom.version }),
    ...((prio === 'high' || prio === 'low' || prio === 'normal') && { priority: prio }),
  };
}

/** Why a document is inactive: past its validity, or repealed in full (confirmed). */
export function inactiveReason(
  status: DocumentStatus | undefined,
  now: number = Date.now(),
): 'expired' | 'derogated' | undefined {
  if (status === undefined) return undefined;
  const to = isoDate(status.validTo);
  if (to !== undefined && Date.parse(`${to}T23:59:59.999Z`) < now) return 'expired';
  const repealed = (status.incoming ?? []).some(
    (r) => r.type === 'derogates' && r.status === 'confirmed' && (r.scope ?? 'total') === 'total',
  );
  return repealed ? 'derogated' : undefined;
}

const VERB: Record<DocumentRelationType, [string, string]> = {
  derogates: ['Repealed', 'repeals'],
  modifies: ['Amended', 'amends'],
  regulates: ['Regulated', 'regulates'],
};

function articlesText(articles: string[] | undefined): string {
  return articles !== undefined && articles.length > 0 ? ` (articles ${articles.join(', ')})` : '';
}

/** English note of a passage whose document repeals, amends or regulates `label`. */
function sourceNoteText(
  type: DocumentRelationType,
  status: 'proposed' | 'confirmed',
  label: string,
  articles?: string[],
): string {
  const verb = VERB[type][1];
  return status === 'confirmed'
    ? `This document ${verb} ${label}${articlesText(articles)}.`
    : `This document possibly ${verb} ${label}${articlesText(articles)} (unconfirmed).`;
}

/** Status notes of a document's passages. */
export function notesFor(
  status: DocumentStatus | undefined,
  withValidity: boolean,
  now: number = Date.now(),
): PassageNote[] {
  if (status === undefined) return [];
  const notes: PassageNote[] = [];
  if (withValidity) {
    const to = isoDate(status.validTo);
    const from = isoDate(status.validFrom);
    if (to !== undefined && inactiveReason({ validTo: to }, now) === 'expired') {
      notes.push({ kind: 'expired', date: to, text: `No longer in force since ${to}.` });
    } else if (from !== undefined && Date.parse(from) > now) {
      notes.push({ kind: 'not_yet_valid', date: from, text: `In force from ${from}.` });
    }
    if (status.version !== undefined && status.version !== '') {
      notes.push({ kind: 'version', version: status.version, text: `Version ${status.version}.` });
    }
  }
  for (const r of status.incoming ?? []) {
    const label = r.fromLabel ?? r.fromDocumentId;
    const date = isoDate(r.date);
    const when = date !== undefined ? ` on ${date}` : '';
    const partial = (r.scope ?? (r.type === 'derogates' ? 'total' : 'partial')) === 'partial';
    const kind: PassageNote['kind'] =
      r.type === 'derogates'
        ? partial
          ? 'partially_derogated'
          : 'derogated'
        : r.type === 'modifies'
          ? 'modified'
          : 'regulated';
    const what = kind === 'partially_derogated' ? 'Partially repealed' : VERB[r.type][0];
    const text =
      r.status === 'confirmed'
        ? `${what} by ${label}${when}${articlesText(r.articles)}.`
        : `Possibly ${what.toLowerCase()} by ${label}${articlesText(r.articles)} (unconfirmed; verify).`;
    notes.push({
      kind,
      status: r.status,
      documentId: r.fromDocumentId,
      label,
      ...(r.articles !== undefined && { articles: r.articles }),
      ...(date !== undefined && { date }),
      text,
    });
  }
  return notes;
}

const GUIDANCE: ContextGuidanceTexts = {
  missingHeading: 'Documents cited in the context that are not available:',
  missingInstruction:
    'If the answer depends on any of them, say so explicitly and state that it is not available.',
  statusInstruction:
    'Some passages carry a status line (validity, repeal, amendment). When you rely on such a passage, state its status in the answer (for example, that it was amended or is no longer in force), even if the related document does not change what you answer. Do not present repealed or expired content as current; where a later document amends or repeals a passage, follow the later one and say so; present unconfirmed changes as possible, not established. If passages give different versions or dates of the same rule, point out the discrepancy with its date and source instead of choosing silently.',
};

/**
 * Instructions for the synthesis that go with a search result: the cited
 * documents missing from the collection (`trace.references.missing`) and,
 * when passages carry status notes, how to treat them. Empty when neither
 * applies. Append it after the context.
 *
 * @param result - The search result.
 * @param texts  - Overrides of the English texts (e.g. the host's language).
 */
export function buildContextGuidance(
  result: Pick<RAGResult, 'passages' | 'trace'>,
  texts: Partial<ContextGuidanceTexts> = {},
): string {
  const t = { ...GUIDANCE, ...texts };
  const parts: string[] = [];
  const missing = [...new Set((result.trace?.references?.missing ?? []).map((m) => m.label))];
  if (missing.length > 0) {
    parts.push(`${t.missingHeading} ${missing.slice(0, 8).join('; ')}. ${t.missingInstruction}`);
  }
  if (result.passages.some((p) => (p.notes?.length ?? 0) > 0)) parts.push(t.statusInstruction);
  return parts.join('\n');
}

/** Only the security part of a filter (tenant and roles): reference searches cross the user's scope, never the ACL. */
function securityFilters(filters: RAGQuery['filters']): RAGQuery['filters'] {
  if (filters === undefined) return undefined;
  return {
    ...(filters.tenantId !== undefined && { tenantId: filters.tenantId }),
    ...(filters.accessRoles !== undefined && { accessRoles: filters.accessRoles }),
  };
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
  references?: RAGTrace['references'];
  status?: RAGTrace['status'];
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
    ...(input.references !== undefined && { references: input.references }),
    ...(input.status !== undefined && { status: input.status }),
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
