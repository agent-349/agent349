/**
 * Pricing rates per 1 000 tokens in USD for a Gemini model.
 *
 * Batch rates are declared **per model**, not derived from a blanket discount:
 * what a provider charges for asynchronous processing is a pricing fact that
 * changes independently of the SDK.
 */
export interface GeminiModelPricing {
  /** USD per 1 000 input (prompt) tokens. */
  input: number;
  /** USD per 1 000 output tokens, including thinking tokens. */
  output: number;
  /** USD per 1 000 input tokens when the request ran in a batch job. */
  batchInput?: number;
  /** USD per 1 000 output tokens when the request ran in a batch job. */
  batchOutput?: number;
}

/**
 * Approximate Gemini pricing (USD / 1 000 tokens).
 *
 * A reasonable baseline, not a live source of truth: Google's price list moves
 * independently of this package. Verify against the current pricing page before
 * relying on it for billing, and override drifting rates through
 * `llm.providers.<name>.pricing` (merged on top of this table) rather than
 * waiting for an SDK release.
 *
 * Keys are matched exactly first, then by longest prefix, so a dated snapshot
 * such as `gemini-3.6-flash-preview-01-2026` inherits its family's rate.
 */
export const DEFAULT_GEMINI_PRICING: Record<string, GeminiModelPricing> = {
  // Google's published paid-tier rates as of September 2026. Gemini 3.8 and
  // 3.6 Flash double on 2027-01-01 (to $1.50 / $7.50 per 1M tokens): override
  // them through `pricing` from that date.
  'gemini-3.8-flash': {
    input: 0.00075,
    output: 0.00375,
    batchInput: 0.000375,
    batchOutput: 0.001875,
  },
  'gemini-3.7-flash': { input: 0.0003, output: 0.0025, batchInput: 0.00015, batchOutput: 0.00125 },
  'gemini-3.6-flash': {
    input: 0.00075,
    output: 0.00375,
    batchInput: 0.000375,
    batchOutput: 0.001875,
  },
  'gemini-3.5-flash': { input: 0.0003, output: 0.0025, batchInput: 0.00015, batchOutput: 0.00125 },
  'gemini-3.5-flash-lite': {
    input: 0.0003,
    output: 0.0025,
    batchInput: 0.00015,
    batchOutput: 0.00125,
  },
  'gemini-3.1-flash-lite': {
    input: 0.0001,
    output: 0.0004,
    batchInput: 0.00005,
    batchOutput: 0.0002,
  },
  'gemini-3.1-pro': { input: 0.00125, output: 0.01, batchInput: 0.000625, batchOutput: 0.005 },
  'gemini-3-flash': { input: 0.0003, output: 0.0025, batchInput: 0.00015, batchOutput: 0.00125 },
  'gemini-flash-latest': {
    input: 0.0003,
    output: 0.0025,
    batchInput: 0.00015,
    batchOutput: 0.00125,
  },
  'gemini-flash-lite-latest': {
    input: 0.0001,
    output: 0.0004,
    batchInput: 0.00005,
    batchOutput: 0.0002,
  },
  'gemini-pro-latest': { input: 0.00125, output: 0.01, batchInput: 0.000625, batchOutput: 0.005 },
};

/**
 * Fallback model list used by `listModels()` when the API is unreachable.
 *
 * Deliberately built from moving aliases plus current families: no part of the
 * SDK's design depends on a particular Gemini generation, and the default model
 * always comes from configuration.
 */
export const KNOWN_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

/**
 * Finds the pricing entry whose key is the **longest** matching prefix of
 * `model`.
 *
 * Longest-prefix rather than first-match: with both `gemini-3.5-flash` and
 * `gemini-3.5-flash-lite` in the table, a dated `gemini-3.5-flash-lite-01-2026`
 * matches both, and picking whichever key iterated first would silently bill a
 * lite call at the full model's rate.
 *
 * @param pricing - Pricing table to search.
 * @param model   - Model identifier.
 */
export function longestPrefixMatch(
  pricing: Record<string, GeminiModelPricing>,
  model: string,
): GeminiModelPricing | undefined {
  let bestKey: string | undefined;
  let bestValue: GeminiModelPricing | undefined;
  for (const [key, value] of Object.entries(pricing)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
      bestValue = value;
    }
  }
  return bestValue;
}
