import type { JSONSchema, LLMRequest, LLMResponse, ProviderProbe } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import type { GlossaryEntry } from '../lexicon/Lexicon.js';
import { formatGlossary } from '../lexicon/Lexicon.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options of {@link QueryExpander}. */
export interface QueryExpanderOptions {
  /** Alternative queries to generate (1–5). Default: 3. */
  variants?: number;
  /**
   * Reasoning effort of the expansion call. Default `'minimal'`: the task is
   * short and a reasoning model would spend its budget thinking. `null` sends
   * none. Rejected values are substituted by the provider where it can.
   */
  reasoningEffort?: LLMRequest['reasoningEffort'] | null;
  /**
   * What the collection is about, in one or two sentences (e.g. "internal
   * policies and procedures of a company"). Steers the formal terminology
   * of the variants; never shown to end users.
   */
  context?: string;
}

/** Result of one expansion. */
export interface QueryExpansionOutcome {
  /** Alternative queries, distinct from the original and from each other. */
  variants: string[];
  /** Provider error or parse failure; `variants` is then empty. */
  error?: string;
  /** Tokens consumed by the call (input + output), when reported. */
  inputTokens?: number;
  outputTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You rewrite a search query into alternative queries for retrieving passages from a document collection. You never answer the query.

Write the alternatives in the same language as the query, covering in this order:
1. The same question using the formal or technical terminology that a regulation, manual or policy on the subject would use.
2. The question with spelling corrected and abbreviations, slang or colloquial expressions spelled out.
3. A short keyword query with only the essential terms.
Further alternatives, when asked for more, use other plausible terminology for the same need.

Keep the meaning exactly: do not add facts, assumptions, names, figures or details the query does not contain. Every alternative must differ from the original query and from the others.`;

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    queries: { type: 'array', items: { type: 'string' } },
  },
  required: ['queries'],
  additionalProperties: false,
};

const MAX_VARIANT_CHARS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// QueryExpander
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expands a query into alternative formulations for multi-query retrieval.
 *
 * Users phrase questions colloquially, misspell them or use other terms than
 * the documents ("fake dollars" for "counterfeit banknotes"). Searching with a
 * few rewordings and fusing the results recovers passages a single literal
 * search misses. The variants only widen retrieval: the re-ranker and the
 * answer still use the original question, so a poor variant can add an
 * irrelevant candidate but cannot change what is answered.
 *
 * The pipeline decides when to expand (`rag.queryExpansion.mode`); this class
 * only produces the variants. It never throws: a failed call returns no
 * variants and the error, and the search goes on with the original query.
 */
export class QueryExpander {
  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #variants: number;
  readonly #reasoningEffort: LLMRequest['reasoningEffort'] | null;
  readonly #context: string | undefined;

  /**
   * @param router   - LLM router instance.
   * @param provider - Provider instance name registered in the router.
   * @param model    - Model identifier (a small, fast model is enough).
   * @param options  - Number of variants, reasoning effort, collection context.
   */
  constructor(
    router: LLMRouter,
    provider: string,
    model: string,
    options: QueryExpanderOptions = {},
  ) {
    this.#router = router;
    this.#provider = provider;
    this.#model = model;
    this.#variants = Math.min(5, Math.max(1, Math.floor(options.variants ?? 3)));
    this.#reasoningEffort =
      options.reasoningEffort === undefined ? 'minimal' : options.reasoningEffort;
    this.#context = options.context?.trim() || undefined;
  }

  /** LLM provider instance used for the expansion. */
  get provider(): string {
    return this.#provider;
  }

  /** Model used for the expansion. */
  get model(): string {
    return this.#model;
  }

  /** Number of variants requested per expansion. */
  get variants(): number {
    return this.#variants;
  }

  /**
   * Generates alternative formulations of `query`.
   *
   * @param query   - The (self-contained) user question.
   * @param options - Glossary entries whose terms occur in the question.
   * @returns The variants, or none and the error. Never throws.
   */
  async expand(
    query: string,
    options: { glossary?: GlossaryEntry[] } = {},
  ): Promise<QueryExpansionOutcome> {
    let response: LLMResponse;
    try {
      response = await this.#router.call(this.#request(query, options.glossary), this.#provider);
    } catch (err) {
      return { variants: [], error: err instanceof Error ? err.message : String(err) };
    }
    const usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
    const raw = QueryExpander.#parse(response);
    if (raw === undefined) {
      return {
        variants: [],
        error:
          `model '${this.#model}' did not return a list of queries` +
          (response.stopReason === 'max_tokens' ? ' (the reply hit the token limit)' : ''),
        ...usage,
      };
    }
    const seen = new Set([normalise(query)]);
    const variants: string[] = [];
    for (const candidate of raw) {
      const text = candidate.trim().slice(0, MAX_VARIANT_CHARS);
      const key = normalise(text);
      if (text.length === 0 || seen.has(key)) continue;
      seen.add(key);
      variants.push(text);
      if (variants.length === this.#variants) break;
    }
    return { variants, ...usage };
  }

  /**
   * Expands a probe query with the request {@link expand} sends and succeeds
   * only when at least one variant comes back. For startup checks.
   *
   * @returns The probe outcome. Never throws.
   */
  async validate(): Promise<ProviderProbe> {
    const outcome = await this.expand('how much does the pro plan cost per user');
    if (outcome.variants.length > 0) return { ok: true };
    return { ok: false, error: outcome.error ?? `model '${this.#model}' returned no variants` };
  }

  /** The expansion request: structured output where the provider supports it. */
  #request(query: string, glossary?: GlossaryEntry[]): LLMRequest {
    const structured = this.#useStructuredOutput();
    const context =
      (this.#context !== undefined ? `\n\nAbout the collection: ${this.#context}` : '') +
      (glossary !== undefined && glossary.length > 0
        ? `\n\nDomain glossary (use these terms and meanings in the alternatives where the query uses them):\n${formatGlossary(glossary)}`
        : '');
    return {
      model: this.#model,
      systemPrompt: SYSTEM_PROMPT + context,
      messages: [
        {
          role: 'user',
          content:
            `Query: ${query}\n\nWrite ${this.#variants} alternative quer${this.#variants === 1 ? 'y' : 'ies'}.` +
            (structured ? '' : ' Reply with ONLY a JSON array of strings.'),
        },
      ],
      temperature: 0,
      maxTokens:
        this.#variants * 80 +
        (this.#reasoningEffort === 'minimal' || this.#reasoningEffort === 'none' ? 256 : 2048),
      ...(this.#reasoningEffort !== null &&
        this.#reasoningEffort !== undefined && { reasoningEffort: this.#reasoningEffort }),
      ...(structured && {
        responseFormat: {
          type: 'json_schema' as const,
          name: 'query_variants',
          schema: SCHEMA,
          strict: true,
        },
      }),
    };
  }

  /** Whether the provider enforces JSON Schema natively for this model. */
  #useStructuredOutput(): boolean {
    try {
      return (
        this.#router.getProvider(this.#provider)?.capabilities(this.#model).structuredOutput ===
        'jsonSchema'
      );
    } catch {
      return false;
    }
  }

  /** The queries in a response: `{ queries: [...] }` or a bare JSON array. */
  static #parse(response: LLMResponse): string[] | undefined {
    let value: unknown =
      response.structured?.parsed === true ? response.structured.value : undefined;
    if (value === undefined) {
      const text = response.content.trim();
      const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match === null) return undefined;
      try {
        value = JSON.parse(match[0]);
      } catch {
        return undefined;
      }
    }
    const list = Array.isArray(value) ? value : (value as { queries?: unknown } | null)?.queries;
    if (!Array.isArray(list)) return undefined;
    return list.filter((q): q is string => typeof q === 'string');
  }
}

/** Case- and space-insensitive comparison key. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
