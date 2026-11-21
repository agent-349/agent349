import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionMode } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Prices of one model, in USD per 1M tokens (the unit of vendor price pages). */
export interface ModelPrice {
  /** Input (prompt) tokens. */
  input: number;
  /** Output (completion) tokens, reasoning included where the vendor bills it as output. */
  output: number;
  /** Input tokens served from the provider's prompt cache. Defaults to `input`. */
  cachedInput?: number;
  /** Input tokens processed by a batch job. Defaults to `input` (no discount is assumed). */
  batchInput?: number;
  /** Output tokens produced by a batch job. Defaults to `output`. */
  batchOutput?: number;
}

/** Announced retirement of a model. */
export interface ModelDeprecation {
  /** Date the model stops working (`YYYY-MM-DD`). */
  shutdown: string;
  /** Recommended replacement, as `provider/model`. */
  replacement?: string;
  /** Where the retirement was announced. */
  source?: string;
}

/** One catalog entry: prices plus metadata. */
export interface PricingEntry extends ModelPrice {
  /** What the model bills for. */
  mode?: 'chat' | 'embedding';
  /** Announced retirement, when known. */
  deprecation?: ModelDeprecation;
  /** Where the prices come from. */
  source?: string;
  /** Date the prices were last checked by hand (overrides). */
  verifiedAt?: string;
}

/** Shape of `pricing-catalog.json` and `pricing-overrides.json`. */
export interface PricingCatalogData {
  version?: string;
  models: Record<string, PricingEntry>;
}

/** A call to price. */
export interface CostQuery {
  /** Provider instance name or type (`openai`, `claude`, an `openai-compatible` instance …). */
  provider?: string;
  /** Adapter type of the instance, when the caller knows it (`LLMResponse.providerType`). */
  providerType?: string;
  /** Model identifier as reported by the provider (dated snapshots included). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` served from the prompt cache. */
  cachedInputTokens?: number;
  /** `batch` applies batch rates when the model declares them. */
  executionMode?: ExecutionMode;
}

/**
 * Anything that can price a call. Returns `undefined` when the model has no
 * known price — never a guess and never 0, so callers can tell "free" from
 * "unknown".
 */
export interface CostEstimator {
  estimate(query: CostQuery): number | undefined;
}

/** Options of {@link PricingCatalog}. */
export interface PricingCatalogOptions {
  /** Base catalog. Default: the catalog shipped with the SDK. */
  catalog?: PricingCatalogData;
  /** Overrides merged over the catalog, keyed `provider/model` (or a bare model, any provider). */
  overrides?: Record<string, Partial<PricingEntry>>;
  /**
   * Maps provider instance names to catalog providers, e.g. `{ main: 'openai' }`
   * for an instance named `main` of type `openai`. Built-in types and aliases
   * (`claude` → `anthropic`) are resolved without it.
   */
  providerTypes?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

/** Adapter types and aliases → catalog provider. */
const PROVIDER_ALIASES: Record<string, string> = {
  openai: 'openai',
  claude: 'anthropic',
  anthropic: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  cohere: 'cohere',
};

/**
 * Providers that run on the operator's own hardware: their calls cost nothing
 * per token, so they price at 0 instead of "unknown".
 */
const LOCAL_PROVIDERS = new Set(['ollama', 'tei']);

/** Dated snapshot suffixes: `-2026-06-11`, `-20251001`, `@20251001`. */
const SNAPSHOT_SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Reads a JSON file shipped next to the bundle (dist) or the source (tests). */
function readShipped(file: string): PricingCatalogData {
  return JSON.parse(readFileSync(join(__dirname, file), 'utf-8')) as PricingCatalogData;
}

let shipped: { catalog: PricingCatalogData; overrides: PricingCatalogData } | undefined;

/** The catalog and overrides shipped with the SDK, read once. */
function shippedData(): { catalog: PricingCatalogData; overrides: PricingCatalogData } {
  shipped ??= {
    catalog: readShipped('pricing-catalog.json'),
    overrides: readShipped('pricing-overrides.json'),
  };
  return shipped;
}

// ─────────────────────────────────────────────────────────────────────────────
// PricingCatalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model prices and retirement dates, from data rather than code.
 *
 * Three layers, the later winning: the catalog shipped with the SDK
 * (`pricing-catalog.json`, regenerated from LiteLLM's community price list by
 * `scripts/update-pricing.mjs` before each release), the SDK's curated
 * corrections (`pricing-overrides.json`), and per-installation overrides from
 * the config (`llm.pricing`, plus the legacy `tokens.pricing` and
 * `llm.providers.<name>.pricing` tables).
 *
 * Lookups never guess. A model is found by its exact `provider/model` key, or
 * by stripping a dated snapshot suffix (`gpt-6.1-sol-2026-06-11`). Anything
 * else — including a model name that merely starts with a known one
 * (`gpt-5.4-mini` is not `gpt-5`) — is unknown, and {@link estimate} returns
 * `undefined`. A provider outside the catalog (an `openai-compatible` server)
 * never inherits another provider's rates; local providers (`ollama`, `tei`)
 * cost 0.
 *
 * @example
 * ```typescript
 * const catalog = new PricingCatalog();
 * catalog.estimate({ provider: 'openai', model: 'gpt-6.1-sol', inputTokens: 1_000_000, outputTokens: 0 });
 * // 2
 * catalog.deprecation('openai', 'gpt-5'); // { shutdown: '2026-12-11', replacement: 'openai/gpt-6.1-sol', … }
 * ```
 */
export class PricingCatalog implements CostEstimator {
  readonly #models: Map<string, PricingEntry>;
  readonly #bareOverrides: Map<string, Partial<PricingEntry>>;
  readonly #providerTypes: Record<string, string>;
  readonly #version: string | undefined;

  /**
   * @param options - Base catalog, overrides and provider-instance mapping.
   */
  constructor(options: PricingCatalogOptions = {}) {
    const base = options.catalog ?? shippedData().catalog;
    const curated = options.catalog === undefined ? shippedData().overrides.models : {};
    this.#version = base.version;
    this.#providerTypes = options.providerTypes ?? {};
    this.#models = new Map(Object.entries(base.models));
    this.#bareOverrides = new Map();
    for (const layer of [curated, options.overrides ?? {}]) {
      for (const [key, entry] of Object.entries(layer)) {
        if (key.includes('/')) {
          const previous = this.#models.get(key);
          this.#models.set(key, { ...previous, ...entry } as PricingEntry);
        } else {
          this.#bareOverrides.set(key, { ...this.#bareOverrides.get(key), ...entry });
        }
      }
    }
  }

  /** Version (date) of the base catalog. */
  get version(): string | undefined {
    return this.#version;
  }

  /** Number of priced models. */
  get size(): number {
    return this.#models.size;
  }

  /**
   * The entry for a model, or `undefined` when it is unknown.
   *
   * @param provider - Provider instance name, type or alias; omit for a bare-model lookup.
   * @param model    - Model identifier.
   */
  resolve(
    provider: string | undefined,
    model: string,
    providerType?: string,
  ): PricingEntry | undefined {
    const bare = this.#bareOverrides.get(model) ?? this.#bareOverrides.get(stripSnapshot(model));
    let entry: PricingEntry | undefined;
    // An override keyed by the instance name (`azure/gpt-6.1-sol`) wins over the type's prices.
    if (provider !== undefined) entry = this.#lookup(provider.toLowerCase(), model);
    const catalogProvider = this.#catalogProvider(provider, providerType);
    if (entry === undefined && catalogProvider !== undefined) {
      entry = this.#lookup(catalogProvider, model);
    }
    if (bare === undefined) return entry;
    if (entry === undefined && !isCompleteEntry(bare)) return undefined;
    return { ...entry, ...bare } as PricingEntry;
  }

  /**
   * Estimated cost of a call in USD, or `undefined` when the model has no
   * known price. Cached input tokens use `cachedInput`, batch calls the batch
   * rates, each only when the model declares them.
   *
   * @param query - The call to price.
   * @returns Cost in USD, `0` for local providers, `undefined` when unknown.
   */
  estimate(query: CostQuery): number | undefined {
    const providerKey = query.provider?.toLowerCase();
    const type =
      (providerKey !== undefined ? this.#providerTypes[providerKey] : undefined) ??
      query.providerType?.toLowerCase() ??
      providerKey;
    if (type !== undefined && LOCAL_PROVIDERS.has(type)) return 0;
    const entry = this.resolve(query.provider, query.model, query.providerType);
    if (entry === undefined) return undefined;

    const batch = query.executionMode === 'batch';
    const inputRate = batch ? (entry.batchInput ?? entry.input) : entry.input;
    const outputRate = batch ? (entry.batchOutput ?? entry.output) : entry.output;
    const cached = Math.min(Math.max(query.cachedInputTokens ?? 0, 0), query.inputTokens);
    const cachedRate = batch ? inputRate : (entry.cachedInput ?? inputRate);
    const usd =
      (query.inputTokens - cached) * inputRate +
      cached * cachedRate +
      query.outputTokens * outputRate;
    return usd / 1_000_000;
  }

  /**
   * Announced retirement of a model, when the catalog knows one.
   *
   * @param provider - Provider instance name, type or alias.
   * @param model    - Model identifier.
   */
  deprecation(provider: string | undefined, model: string): ModelDeprecation | undefined {
    return this.resolve(provider, model)?.deprecation;
  }

  /** Exact or snapshot-stripped entry under `provider/`. */
  #lookup(provider: string, model: string): PricingEntry | undefined {
    return (
      this.#models.get(`${provider}/${model}`) ??
      this.#models.get(`${provider}/${stripSnapshot(model)}`)
    );
  }

  /** Catalog provider for an instance name, adapter type or alias. */
  #catalogProvider(provider: string | undefined, providerType?: string): string | undefined {
    const key = provider?.toLowerCase();
    const type =
      (key !== undefined ? this.#providerTypes[key] : undefined) ??
      providerType?.toLowerCase() ??
      key;
    return type !== undefined ? PROVIDER_ALIASES[type] : undefined;
  }
}

/** The model id without a dated snapshot suffix. */
function stripSnapshot(model: string): string {
  return model.replace(SNAPSHOT_SUFFIX, '');
}

/** Whether a bare-model override carries enough to price on its own. */
function isCompleteEntry(entry: Partial<PricingEntry>): entry is PricingEntry {
  return typeof entry.input === 'number' && typeof entry.output === 'number';
}
