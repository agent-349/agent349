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
