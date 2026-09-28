/**
 * Structural types for the two Gemini wire formats the provider speaks.
 *
 * `@google/genai` keeps most Interactions types unexported, so the provider
 * declares the shapes it actually uses and casts once at the SDK boundary.
 * Everything here mirrors the public REST contract, not SDK internals.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Interactions API (synchronous calls)
// ─────────────────────────────────────────────────────────────────────────────

/** A text input block. */
export interface InteractionTextContent {
  type: 'text';
  text: string;
}

/** An image, document, audio or video input block. */
export interface InteractionMediaContent {
  type: 'image' | 'document' | 'audio' | 'video';
  /** Base64 payload for inline content. */
  data?: string;
  /** File API URI or a URL the provider fetches. */
  uri?: string;
  mime_type?: string;
  /** Image-only rendering hint. */
  resolution?: string;
}

/** A tool call predicted by the model. */
export interface InteractionFunctionCall {
  type: 'function_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The outcome of a tool call, fed back on the next turn. */
export interface InteractionFunctionResult {
  type: 'function_result';
  call_id: string;
  name?: string;
  is_error?: boolean;
  result: InteractionTextContent[] | string;
}

/**
 * A thinking step. Its `signature` must be echoed back verbatim on later turns
 * of a stateless conversation, or the model rejects the history.
 */
export interface InteractionThought {
  type: 'thought';
  signature?: string;
  summary?: unknown[];
}

/** The model's answer for one turn. */
export interface InteractionModelOutput {
  type: 'model_output';
  content?: Array<InteractionTextContent | InteractionMediaContent>;
  error?: { message?: string; code?: number };
}

/** A previous user turn replayed as part of a stateless history. */
export interface InteractionUserInput {
  type: 'user_input';
  content?: Array<InteractionTextContent | InteractionMediaContent>;
}

/** Anything that can appear in `input` or in a response's `steps`. */
export type InteractionBlock =
  | InteractionTextContent
  | InteractionMediaContent
  | InteractionFunctionCall
  | InteractionFunctionResult
  | InteractionThought
  | InteractionModelOutput
  | InteractionUserInput;

/** A function tool declaration. */
export interface InteractionFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** Structured-output configuration. */
export interface InteractionResponseFormat {
  type: 'text';
  mime_type: string;
  schema?: Record<string, unknown>;
}

/** Body of a `POST /v1beta/interactions` request. */
export interface InteractionCreateBody {
  model: string;
  input: InteractionBlock[];
  system_instruction?: string;
  tools?: InteractionFunctionTool[];
  response_format?: InteractionResponseFormat;
  generation_config?: Record<string, unknown>;
  safety_settings?: Array<{ category: string; threshold: string }>;
  service_tier?: string;
  labels?: Record<string, string>;
  /**
   * Always `false` in this SDK: Agent349 owns conversation state, so nothing
   * is stored on Google's side.
   */
  store: false;
  stream?: boolean;
}

/** Token accounting reported by the Interactions API. */
export interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
  total_tokens?: number;
  input_tokens_by_modality?: Array<{ modality: string; tokens: number }>;
  output_tokens_by_modality?: Array<{ modality: string; tokens: number }>;
}

/** A completed (or failed) interaction. */
export interface InteractionResponse {
  id?: string;
  model?: string;
  status?: string;
  steps?: InteractionBlock[];
  usage?: InteractionUsage;
  error?: { message?: string; code?: string };
}

/** One server-sent event from a streamed interaction. */
export interface InteractionStreamEvent {
  event_type?: string;
  interaction?: InteractionResponse;
  index?: number;
  step?: { type?: string };
  delta?: { type?: string; text?: string; signature?: string; arguments?: unknown };
  usage?: InteractionUsage;
}

/** The subset of `ai.interactions` the provider uses. */
export interface InteractionsClient {
  create(
    params: InteractionCreateBody,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionResponse | AsyncIterable<InteractionStreamEvent>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateContent API (batch jobs)
// ─────────────────────────────────────────────────────────────────────────────

/** One part of a `generateContent` message. */
export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType?: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

/** One `generateContent` message. */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** A `GenerateContentRequest`, as accepted by the Batch API. */
export interface GenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: InteractionFunctionTool[] }>;
  generationConfig?: Record<string, unknown>;
  safetySettings?: Array<{ category: string; threshold: string }>;
}

/** Token accounting reported by `generateContent`. */
export interface GenerateContentUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** A `generateContent` response. */
export interface GenerateContentResponseBody {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  modelVersion?: string;
  usageMetadata?: GenerateContentUsage;
}
