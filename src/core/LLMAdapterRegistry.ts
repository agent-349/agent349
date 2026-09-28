import type { LLMProvider } from '../llm/LLMProvider.js';
import { OpenAIProvider } from '../llm/OpenAIProvider.js';
import { ClaudeProvider } from '../llm/ClaudeProvider.js';
import { OllamaProvider } from '../llm/OllamaProvider.js';
import { GeminiProvider } from '../llm/gemini/GeminiProvider.js';
import type { LLMProviderConfig, LLMProviderType } from '../config/ConfigLoader.js';
import { ConfigError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// LLMAdapterRegistry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a concrete {@link LLMProvider} for a single named instance from its
 * public {@link LLMProviderConfig}.
 *
 * Returning `undefined` means the instance is intentionally **not registrable**
 * with the given config (e.g. a cloud adapter whose API key is absent) — the
 * wiring skips it silently, preserving the historical behaviour where
 * `openai`/`claude` register only when a key is present. Missing configuration
 * that is a genuine error (e.g. a required base URL) is rejected at config load
 * time, so factories may assume validated input.
 *
 * @param name - Instance name (the key under `llm.providers`), used as the
 *               provider's identity for routing, metrics, audit and errors.
 * @param cfg  - Public instance configuration.
 */
export type LLMAdapterFactory = (name: string, cfg: LLMProviderConfig) => LLMProvider | undefined;

/**
 * Resolves the API key an OpenAI-compatible endpoint should use, honouring the
 * auth-precedence rule: an explicit `Authorization` header wins over `apiKey`.
 *
 * The OpenAI SDK requires a non-empty key string even when the real auth is
 * carried by `defaultHeaders.Authorization` (a gateway) or the endpoint needs
 * no auth at all — a documented placeholder is used in those cases, and the
 * header (when present) overrides the placeholder-derived bearer on the wire.
 */
function resolveCompatibleApiKey(cfg: LLMProviderConfig): string {
  const hasAuthHeader = cfg.headers?.['Authorization'] !== undefined;
  if (hasAuthHeader) return 'HEADER_AUTH';
  if (cfg.apiKey !== undefined && cfg.apiKey !== '') return cfg.apiKey;
  return 'EMPTY';
}

/** Built-in adapter factories keyed by {@link LLMProviderType}. */
const BUILTIN_FACTORIES: Readonly<Record<LLMProviderType, LLMAdapterFactory>> = {
  openai: (name, cfg) => {
    // Preserve historical skip: no key ⇒ not registered.
    if (cfg.apiKey === undefined || cfg.apiKey === '') return undefined;
    return new OpenAIProvider({
      name,
      apiKey: cfg.apiKey,
      ...(cfg.capabilities !== undefined && { capabilities: cfg.capabilities }),
      ...(cfg.baseUrl !== undefined && { baseURL: cfg.baseUrl }),
      ...(cfg.apiVersion !== undefined && { apiVersion: cfg.apiVersion }),
      ...(cfg.organization !== undefined && { organization: cfg.organization }),
      ...(cfg.headers !== undefined && { defaultHeaders: cfg.headers }),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      ...(cfg.pricing !== undefined && { pricing: cfg.pricing }),
    });
  },

  'openai-compatible': (name, cfg) =>
    new OpenAIProvider({
      name,
      providerType: 'openai-compatible',
      ...(cfg.capabilities !== undefined && { capabilities: cfg.capabilities }),
      apiKey: resolveCompatibleApiKey(cfg),
      // `baseUrl` is required for this type (validated at config load).
      ...(cfg.baseUrl !== undefined && { baseURL: cfg.baseUrl }),
      ...(cfg.headers !== undefined && { defaultHeaders: cfg.headers }),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      // No built-in OpenAI pricing table: compatible model ids should not
      // inherit OpenAI rates. Cost is reported only for models in `pricing`.
      disableDefaultPricing: true,
      ...(cfg.pricing !== undefined && { pricing: cfg.pricing }),
    }),

  gemini: (name, cfg) => {
    // Preserve the historical skip for cloud adapters: no key ⇒ not registered.
    if (cfg.apiKey === undefined || cfg.apiKey === '') return undefined;
    return new GeminiProvider({
      name,
      apiKey: cfg.apiKey,
      ...(cfg.defaultModel !== undefined && { defaultModel: cfg.defaultModel }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      ...(cfg.pricing !== undefined && { pricing: cfg.pricing }),
    });
  },

  claude: (name, cfg) => {
    if (cfg.apiKey === undefined || cfg.apiKey === '') return undefined;
    return new ClaudeProvider({
      name,
      apiKey: cfg.apiKey,
      ...(cfg.defaultModel !== undefined && { defaultModel: cfg.defaultModel }),
      ...(cfg.headers !== undefined && { defaultHeaders: cfg.headers }),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      ...(cfg.pricing !== undefined && { pricing: cfg.pricing }),
    });
  },

  ollama: (name, cfg) =>
    new OllamaProvider({
      name,
      // `baseUrl` is required for this type (validated at config load).
      ...(cfg.baseUrl !== undefined && { baseUrl: cfg.baseUrl }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
    }),
};

/**
 * Maps LLM provider **types** to adapter factories, so the Orchestrator can
 * instantiate any number of named instances of any type — including types added
 * at runtime — without hard-coded per-provider wiring.
 *
 * Built-in types: `openai`, `openai-compatible`, `claude`, `gemini`, `ollama`.
 * Additional types are supplied via {@link OrchestratorOverrides.llmAdapters}.
 */
export class LLMAdapterRegistry {
  readonly #factories = new Map<string, LLMAdapterFactory>();

  /**
   * @param extra - Extra factories keyed by type name, merged on top of (and
   *                able to override) the built-in factories.
   */
  constructor(extra?: Record<string, LLMAdapterFactory>) {
    for (const [type, factory] of Object.entries(BUILTIN_FACTORIES)) {
      this.#factories.set(type, factory);
    }
    if (extra !== undefined) {
      for (const [type, factory] of Object.entries(extra)) {
        this.#factories.set(type, factory);
      }
    }
  }

  /** Registers or replaces the factory for a provider type. */
  register(type: string, factory: LLMAdapterFactory): void {
    this.#factories.set(type, factory);
  }

  /**
   * Builds the provider for one instance.
   *
   * @param type - Resolved adapter type.
   * @param name - Instance name.
   * @param cfg  - Instance configuration.
   * @returns The provider, or `undefined` when the instance is not registrable
   *          with the given config.
   * @throws {@link ConfigError} when no factory is registered for `type`.
   */
  create(type: string, name: string, cfg: LLMProviderConfig): LLMProvider | undefined {
    const factory = this.#factories.get(type);
    if (factory === undefined) {
      throw new ConfigError(
        `No LLM adapter factory registered for type '${type}' (instance '${name}'). ` +
          `Register one via overrides.llmAdapters.`,
        `llm.providers.${name}.type`,
      );
    }
    return factory(name, cfg);
  }
}
