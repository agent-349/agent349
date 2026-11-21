import type { LLMRequest, LLMResponse } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import type { VisionRecognizer } from './OcrService.js';

const SYSTEM_PROMPT = `You transcribe the text of a scanned document page exactly as written.

Rules:
- Output only the text of the page: no comments, no descriptions of images, no Markdown fences.
- Keep the reading order, headings, numbering and paragraph breaks. Write tables row by row, cells separated by " | ".
- Do not translate, summarise, correct or complete anything. Write illegible fragments as [illegible].
- If the page has no text, output nothing.`;

/** Options of {@link createVisionRecognizer}. */
export interface VisionRecognizerOptions {
  /** Max completion tokens per page. Default: 4096. */
  maxTokens?: number;
  /** Reasoning effort, for reasoning models. Default: `'minimal'`. `null` sends none. */
  reasoningEffort?: LLMRequest['reasoningEffort'] | null;
  /** Receives the token usage of every page (to record consumption). */
  onUsage?: (usage: LLMResponse['usage'], model: string) => void | Promise<void>;
}

/**
 * A {@link VisionRecognizer} that transcribes a page image with a vision model
 * through the LLM router (OpenAI, Claude, Gemini or a local Ollama model).
 * Used by `OcrService` to re-read pages Tesseract recognised with low
 * confidence.
 *
 * @param router   - LLM router.
 * @param provider - Provider instance with a vision-capable model.
 * @param model    - Model identifier.
 */
export function createVisionRecognizer(
  router: LLMRouter,
  provider: string,
  model: string,
  options: VisionRecognizerOptions = {},
): VisionRecognizer {
  const effort = options.reasoningEffort === undefined ? 'minimal' : options.reasoningEffort;
  return async (png, languages) => {
    const response = await router.call(
      {
        model,
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Transcribe this page.${languages.length > 0 ? ` Expected language(s) (Tesseract codes): ${languages.join(', ')}.` : ''}`,
              },
              {
                type: 'image',
                source: { kind: 'bytes', bytes: png, mimeType: 'image/png' },
                options: { detail: 'high' },
              },
            ],
          },
        ],
        temperature: 0,
        maxTokens: options.maxTokens ?? 4096,
        ...(effort !== null && { reasoningEffort: effort }),
      },
      provider,
    );
    if (options.onUsage !== undefined) await options.onUsage(response.usage, model);
    return { text: typeof response.content === 'string' ? response.content : '' };
  };
}
