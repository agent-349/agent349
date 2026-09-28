// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Cost per 1 000 tokens for a single model, split by direction. */
export interface ModelPricing {
  /** USD per 1 000 input (prompt) tokens. */
  input: number;
  /** USD per 1 000 output (completion) tokens. */
  output: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PricingTable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the estimated USD cost of an LLM call from a per-model price list.
 *
 * Prices are expressed per 1 000 tokens (the convention used in
 * `config.tokens.pricing`). Unknown models cost `0` — the caller decides whether
 * that is acceptable or whether a provider-reported `usage.cost` should win.
 *
 * @example
 * ```typescript
 * const pricing = new PricingTable({
 *   'gpt-6-sol': { input: 0.002, output: 0.01 },
 * });
 * pricing.cost('gpt-6-sol', 1000, 500); // 0.002 + 0.005 = 0.007
 * ```
 */
export class PricingTable {
  readonly #prices: Record<string, ModelPricing>;

  /**
   * @param prices - Map of model identifier → {@link ModelPricing}. Defaults to
   *                 an empty table (every model costs 0).
   */
  constructor(prices: Record<string, ModelPricing> = {}) {
    this.#prices = prices;
  }

  /**
   * Returns the estimated cost in USD for a call, or `0` when the model has no
   * configured price.
   *
   * @param model        - Model identifier (must match a key in the price list).
   * @param inputTokens  - Prompt tokens consumed.
   * @param outputTokens - Completion tokens generated.
   */
  cost(model: string, inputTokens: number, outputTokens: number): number {
    const price = this.#prices[model];
    if (price === undefined) return 0;
    return (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
  }

  /** Whether a price is configured for the given model. */
  has(model: string): boolean {
    return this.#prices[model] !== undefined;
  }
}
