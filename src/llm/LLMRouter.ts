import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../types/index.js';
import { LLMProvider } from './LLMProvider.js';
import { ProviderError } from '../errors/index.js';
import { isMediaBlock } from '../content/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Circuit breaker configuration for {@link LLMRouter}.
 *
 * When a provider accumulates `failureThreshold` consecutive failures its circuit
 * opens and all subsequent calls to that provider are short-circuited (redirected
 * to the fallback) until `recoveryTimeMs` milliseconds have elapsed.
 */
export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures required to open the circuit.
   * @default 3
   */
  failureThreshold: number;
  /**
   * Milliseconds the circuit stays open before a recovery trial is allowed.
   * @default 60000
   */
  recoveryTimeMs: number;
}

/** Snapshot of a provider's circuit breaker state. */
export interface CircuitSnapshot {
  /** Whether the circuit is currently open (provider is being skipped). */
  isOpen: boolean;
  /** Number of consecutive failures recorded for this provider. */
  failures: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  /** Unix timestamp (ms) at which the circuit may close again; `null` = closed. */
  openUntil: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMRouter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Multi-provider LLM router with automatic fallback and per-provider circuit breaking.
 *
 * ## Routing logic
 *
 * 1. Check primary provider's circuit state.
 *    - **Open** (tripped): skip primary, jump directly to fallback.
 *    - **Closed / half-open**: attempt primary.
 *      - Success → record success (resets failure counter) and return.
 *      - Failure → record failure (may open circuit), then try fallback if configured.
 *
 * 2. Fallback path:
 *    - Uses `fallbackProvider` with the original request model, unless `fallbackModel`
 *      is specified, in which case the request model is overridden.
 *    - The fallback provider has its own independent circuit state.
 *
 * ## Circuit breaker states
 *
 * | State      | Condition                                     | Behaviour        |
 * |------------|-----------------------------------------------|------------------|
 * | Closed     | failures < threshold, openUntil = null        | Normal operation |
 * | Open       | failures >= threshold, now < openUntil        | Fail fast        |
 * | Half-open  | openUntil elapsed, waiting for first trial    | Allow one call   |
 *
 * @example
 * ```typescript
 * const router = new LLMRouter(
 *   new Map([['claude', claudeProvider], ['openai', openaiProvider]]),
 *   { failureThreshold: 3, recoveryTimeMs: 60_000 },
 * );
 *
 * const response = await router.call(request, 'claude', 'openai', 'gpt-6-luna');
 * ```
 */
export class LLMRouter {
  readonly #providers: Map<string, LLMProvider>;
  readonly #cbConfig: CircuitBreakerConfig;
  readonly #circuits: Map<string, CircuitState> = new Map();
  readonly #now: () => number;

  /**
   * @param providers      - Initial provider map keyed by provider name.
   * @param circuitBreaker - Circuit breaker tuning. Defaults are 3 failures / 60 s.
   * @param _now           - Clock function; defaults to `Date.now`. Inject in tests.
   */
  constructor(
    providers: Map<string, LLMProvider> = new Map(),
    circuitBreaker: Partial<CircuitBreakerConfig> = {},
    _now: () => number = Date.now,
  ) {
    this.#providers = new Map(providers);
    this.#cbConfig = {
      failureThreshold: circuitBreaker.failureThreshold ?? 3,
      recoveryTimeMs: circuitBreaker.recoveryTimeMs ?? 60_000,
    };
    this.#now = _now;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a provider (or replaces an existing registration with the same name).
   *
   * @param provider - The provider instance to register.
   */
  registerProvider(provider: LLMProvider): void {
    this.#providers.set(provider.name, provider);
  }

  /**
   * Sends an LLM request through the primary provider, falling back to the
   * fallback provider on failure or when the primary circuit is open.
   *
   * @param request          - The normalised LLM request.
   * @param primaryProvider  - Name of the preferred provider.
   * @param fallbackProvider - Name of the fallback provider (optional).
   * @param fallbackModel    - Model override for the fallback request (optional).
   *                          When omitted, the fallback uses `request.model`.
   *
   * @returns The normalised {@link LLMResponse} from whichever provider answered.
   *
   * @throws {@link ProviderError} when:
   *   - The primary circuit is open and no fallback is configured.
   *   - The primary fails (and no fallback is configured).
   *   - The fallback also fails.
   *   - A requested provider name is not registered.
   */
  async call(
    request: LLMRequest,
    primaryProvider: string,
    fallbackProvider?: string,
    fallbackModel?: string,
  ): Promise<LLMResponse> {
    // ── Primary path ──────────────────────────────────────────────────────
    let primaryError: unknown;
    if (!this.#isCircuitOpen(primaryProvider)) {
      try {
        const response = await this.#getProvider(primaryProvider).call(request);
        this.#recordSuccess(primaryProvider);
        return response;
      } catch (err) {
        this.#recordFailure(primaryProvider);
        if (fallbackProvider === undefined) throw err;
        primaryError = err;
        // Fall through to fallback.
      }
    } else if (fallbackProvider === undefined) {
      throw new ProviderError(
        primaryProvider,
        `Circuit breaker is open for provider '${primaryProvider}'`,
        request.model,
      );
    }

    // ── Fallback path ─────────────────────────────────────────────────────
    const fallbackReq: LLMRequest =
      fallbackModel !== undefined ? { ...request, model: fallbackModel } : request;

    // A fallback that cannot serve the request would answer with a truncated
    // prompt or an opaque provider error. Skip it and surface the real failure.
    // Capabilities are only consulted when the request actually needs something
    // beyond plain text, so ordinary routing costs nothing extra.
    const missing = LLMRouter.#requiresCapabilities(fallbackReq)
      ? LLMRouter.#missingCapability(
          this.#getProvider(fallbackProvider).capabilities(fallbackReq.model),
          fallbackReq,
        )
      : undefined;
    if (missing !== undefined) {
      // Surface the primary's own failure when there was one: it is the real
      // cause, and the fallback never ran.
      if (primaryError !== undefined) throw primaryError as Error;
      throw new ProviderError(
        fallbackProvider,
        `fallback cannot serve this request: missing '${missing}'`,
        fallbackReq.model,
      );
    }

    try {
      const response = await this.#getProvider(fallbackProvider).call(fallbackReq);
      this.#recordSuccess(fallbackProvider);
      return response;
    } catch (err) {
      this.#recordFailure(fallbackProvider);
      throw err;
    }
  }

  /**
   * Returns a registered provider by name, or `undefined` when unknown.
   *
   * Used by callers that need to inspect a provider's declared capabilities
   * before building a request.
   *
   * @param name - Provider instance name.
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.#providers.get(name);
  }

  /**
   * Returns a snapshot of the circuit breaker state for the given provider.
   * Useful for health checks and monitoring dashboards.
   *
   * @param providerName - The provider to inspect.
   */
  getCircuitState(providerName: string): CircuitSnapshot {
    return {
      isOpen: this.#isCircuitOpen(providerName),
      failures: this.#circuits.get(providerName)?.failures ?? 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether the request needs anything beyond plain text generation.
   *
   * Checked first so a text-only call never has to ask a provider what it
   * supports — the common path stays a straight delegation.
   */
  static #requiresCapabilities(request: LLMRequest): boolean {
    if (request.responseFormat !== undefined) return true;
    return request.messages.some(
      (message) => typeof message.content !== 'string' && message.content.some(isMediaBlock),
    );
  }

  /**
   * Returns the first capability the request needs and the provider lacks, or
   * `undefined` when the provider can serve it.
   *
   * Only checks what would make the answer wrong or impossible: input
   * modalities and structured output. Optional niceties (streaming, cost
   * reporting) degrade acceptably and are not grounds for skipping a fallback.
   */
  static #missingCapability(
    capabilities: ProviderCapabilities,
    request: LLMRequest,
  ): string | undefined {
    for (const message of request.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (isMediaBlock(block) && !capabilities.input[block.type]) {
          return `input.${block.type}`;
        }
      }
    }

    const format = request.responseFormat;
    if (format !== undefined) {
      if (capabilities.structuredOutput === 'none') return 'structuredOutput';
      if (format.type === 'json_schema' && capabilities.structuredOutput !== 'jsonSchema') {
        return 'structuredOutput.json_schema';
      }
      const hasTools = request.tools !== undefined && request.tools.length > 0;
      if (hasTools && !capabilities.structuredOutputWithTools) {
        return 'structuredOutputWithTools';
      }
    }

    return undefined;
  }

  #getProvider(name: string): LLMProvider {
    const provider = this.#providers.get(name);
    if (provider === undefined) {
      throw new ProviderError(name, `Provider '${name}' is not registered`);
    }
    return provider;
  }

  /**
   * Returns `true` when the circuit is open (provider should be skipped).
   *
   * If the recovery window has elapsed, the circuit transitions to half-open
   * (openUntil reset to null) and returns `false`, allowing a single trial call.
   */
  #isCircuitOpen(providerName: string): boolean {
    const state = this.#circuits.get(providerName);
    if (state === undefined || state.openUntil === null) return false;

    if (this.#now() >= state.openUntil) {
      // Recovery time elapsed — transition to half-open by clearing openUntil.
      state.openUntil = null;
      return false;
    }

    return true;
  }

  /** Resets the failure counter and closes the circuit for a provider. */
  #recordSuccess(providerName: string): void {
    this.#circuits.set(providerName, { failures: 0, openUntil: null });
  }

  /**
   * Increments the consecutive failure counter.
   * Opens the circuit when the configured threshold is reached.
   */
  #recordFailure(providerName: string): void {
    const current = this.#circuits.get(providerName) ?? { failures: 0, openUntil: null };
    const failures = current.failures + 1;
    const openUntil =
      failures >= this.#cbConfig.failureThreshold
        ? this.#now() + this.#cbConfig.recoveryTimeMs
        : current.openUntil;

    this.#circuits.set(providerName, { failures, openUntil });
  }
}
