import OpenAI, { AzureOpenAI, toFile } from 'openai';
import type {
  BatchJob,
  BatchRequestItem,
  BatchResultItem,
  BatchSubmitOptions,
  ContentBlock,
  ExecutionMode,
  FileUploadInput,
  LLMRequest,
  LLMResponse,
  MediaBlock,
  ProviderCapabilities,
  ProviderFileRef,
  ToolCall,
  ToolDescriptor,
  ProviderProbe,
} from '../types/index.js';
import type { BatchCapableProvider, FileCapableProvider } from './LLMProvider.js';
import { LLMProvider } from './LLMProvider.js';
import { ContentResolver } from './ContentResolver.js';
import type { ResolvedContent } from './ContentResolver.js';
import {
  describeOmitted,
  isMediaBlock,
  readFileBytes,
  mimeTypeFromPath,
} from '../content/index.js';
import { assertResponseFormatSupported, buildStructuredOutput } from './structured.js';
import { ProviderError, UnsupportedCapabilityError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Pricing rates per 1 000 tokens in USD for an OpenAI model. */
export interface OpenAIModelPricing {
  /** USD per 1 000 prompt tokens. */
  input: number;
  /** USD per 1 000 completion tokens. */
  output: number;
  /** USD per 1 000 prompt tokens when the request ran in a batch job. */
  batchInput?: number;
  /** USD per 1 000 completion tokens when the request ran in a batch job. */
  batchOutput?: number;
}

/**
 * Configuration accepted by {@link OpenAIProvider}.
 *
 * When `apiVersion` is supplied the provider automatically switches to the
 * **Azure OpenAI** client (`AzureOpenAI`) and treats `baseURL` as the Azure
 * resource endpoint (e.g. `https://my-resource.openai.azure.com`).
 */
export interface OpenAIProviderConfig {
  /**
   * Instance identity used as the provider `name` (router key, and the value
   * reported in `LLMResponse.provider` / `ProviderError`). Defaults to
   * `'openai'`. Set a distinct name per instance when running several
   * OpenAI/OpenAI-compatible endpoints simultaneously.
   */
  name?: string;
  /**
   * Adapter type reported as `providerType`. Defaults to `'openai'`; the
   * wiring passes `'openai-compatible'` for third-party endpoints so file
   * references issued by one are never replayed against the other.
   */
  providerType?: string;
  /**
   * Overrides for the declared {@link ProviderCapabilities}.
   *
   * Official OpenAI defaults to full support. An `openai-compatible` endpoint
   * defaults to a deliberately conservative set (images yes, documents no,
   * JSON mode without schema, no files, no batch) because the SDK cannot know
   * what a third-party server implements — declare what yours actually does
   * via `llm.providers.<name>.capabilities`.
   */
  capabilities?: Partial<ProviderCapabilities>;
  /** API key — OpenAI secret key or Azure API key. */
  apiKey: string;
  /**
   * Base URL override.
   * - Standard OpenAI: a proxy or alternative host (e.g. `https://my-proxy/v1`).
   * - Azure OpenAI: the resource endpoint (e.g. `https://my-resource.openai.azure.com`).
   */
  baseURL?: string;
  /**
   * Extra HTTP headers sent on every request (e.g. gateway auth or tenant
   * routing). Maps to the OpenAI SDK's `defaultHeaders`. A header
   * `Authorization` set here overrides the `apiKey`-derived bearer.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * When `true`, the built-in OpenAI pricing table is not applied — cost is
   * reported only for models explicitly listed in `pricing`. Set for
   * OpenAI-compatible endpoints whose model ids should not inherit OpenAI rates.
   */
  disableDefaultPricing?: boolean;
  /**
   * Azure API version (e.g. `'2024-02-01'`).
   * When present, the provider uses `AzureOpenAI` automatically.
   */
  apiVersion?: string;
  /** OpenAI organisation ID (ignored for Azure). */
  organization?: string;
  /** Maximum number of automatic retries on transient errors. Default: 2. */
  maxRetries?: number;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /**
   * Per-model pricing table (USD / 1 000 tokens), merged on top of
   * {@link DEFAULT_PRICING} — entries here override the built-in default for
   * the same key, and any model not listed here still falls back to the
   * built-in table. This means overrides only need to name the models that
   * are new or whose price changed, not the full table. Pass an entry with
   * the current model to keep pricing correct as OpenAI's price list changes
   * without needing an SDK update — see `config.llm.providers.openai.pricing`
   * in the application's runtime config.
   */
  pricing?: Record<string, OpenAIModelPricing>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approximate OpenAI pricing (USD / 1 000 tokens). Updated periodically —
 * treat as a reasonable baseline, not a live source of truth. Verify against
 * OpenAI's current pricing page before relying on this for billing, and
 * prefer overriding via `OpenAIProviderConfig.pricing` (merged on top of this
 * table) when a rate drifts rather than waiting on an SDK update.
 */
const DEFAULT_PRICING: Record<string, OpenAIModelPricing> = {
  // Current generation, from OpenAI's published rates as of September 2026.
  'gpt-6-astra': { input: 0.01, output: 0.05, batchInput: 0.005, batchOutput: 0.025 },
  'gpt-6-sol': { input: 0.002, output: 0.01, batchInput: 0.001, batchOutput: 0.005 },
  'gpt-6-luna': { input: 0.0001, output: 0.0005, batchInput: 0.00005, batchOutput: 0.00025 },
  // Earlier models, kept so existing deployments stay priced.
  'gpt-5': { input: 0.00125, output: 0.01, batchInput: 0.000625, batchOutput: 0.005 },
  'gpt-5-mini': { input: 0.00025, output: 0.002, batchInput: 0.000125, batchOutput: 0.001 },
  'gpt-5-nano': { input: 0.00005, output: 0.0004, batchInput: 0.000025, batchOutput: 0.0002 },
  'gpt-4o': { input: 0.005, output: 0.015, batchInput: 0.0025, batchOutput: 0.0075 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006, batchInput: 0.000075, batchOutput: 0.0003 },
  'gpt-4-turbo': { input: 0.01, output: 0.03, batchInput: 0.005, batchOutput: 0.015 },
  'gpt-4': { input: 0.03, output: 0.06, batchInput: 0.015, batchOutput: 0.03 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015, batchInput: 0.00025, batchOutput: 0.00075 },
};

/** OpenAI's documented per-request file payload ceiling. */
const INLINE_LIMIT_BYTES = 50 * 1024 * 1024;

const KNOWN_MODELS = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
];

/**
 * Per-model request-shape adjustments discovered at runtime — see
 * {@link OpenAIProvider.call} and `#relaxUnsupportedParam`. Internal only.
 *
 * `max_completion_tokens` is the parameter OpenAI now accepts across every
 * current Chat Completions model (o-series, GPT-5, and the older GPT-4/3.5
 * family alike), so it's the default first attempt. `max_tokens` is kept
 * only as a fallback for non-official OpenAI-compatible endpoints (self-hosted
 * proxies, or an Azure deployment pinned to an `apiVersion` that predates the
 * newer parameter) that haven't implemented it yet.
 */
interface ModelQuirks {
  /** Fall back to the legacy `max_tokens` (endpoint rejected `max_completion_tokens`). */
  useLegacyMaxTokens?: boolean;
  /** Omit `temperature` (some models only accept the default value). */
  omitTemperature?: boolean;
  /**
   * Omit `reasoning_effort` (model/endpoint doesn't support it). Common on
   * OpenAI-compatible servers that don't implement the parameter.
   */
  omitReasoningEffort?: boolean;
}

/** Accumulator for one function call whose fields arrive across stream chunks. */
interface StreamedToolCall {
  id?: string;
  name: string;
  arguments: string;
}

/** Timing markers captured while consuming one streamed completion. */
interface StreamTimings {
  streamOpenMs: number;
  timeToFirstChunkMs?: number;
  timeToFirstTokenMs?: number;
  generationMs?: number;
}

/** Reconstructed completion plus its stream timing markers. */
interface StreamCompletionResult {
  completion: OpenAI.ChatCompletion;
  timings: StreamTimings;
}

/**
 * Upper bound on how many distinct parameters {@link OpenAIProvider} will
 * relax in a single call before giving up and surfacing the error. Currently
 * `max_tokens`, `temperature` and `reasoning_effort` are recoverable, so 3 is
 * sufficient headroom without risking a retry loop on an unrelated 400.
 */
const MAX_QUIRK_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM provider implementation for OpenAI and Azure OpenAI.
 *
 * Handles the bidirectional translation between the SDK's normalised types and
 * the OpenAI Chat Completions API:
 *
 * - **Tools**: `ToolDescriptor.inputSchema` → `function.parameters` (OpenAI format).
 * - **Messages**: SDK `role:'tool'` → OpenAI `role:'tool'` with `tool_call_id`;
 *   SDK `ContentBlock[]` assistant turns → OpenAI `tool_calls` array.
 *   Unlike Claude, OpenAI keeps each tool result as its own message (no grouping).
 * - **Responses**: `choices[0].message` → `content` string + `toolCalls` array +
 *   `contentBlocks` for round-trip accuracy.
 * - **Finish reason**: `stop` → `'end'`; `tool_calls` → `'tool_use'`;
 *   `length` → `'max_tokens'`.
 * - **Azure**: when `apiVersion` is set, uses `AzureOpenAI` automatically.
 *
 * @example
 * ```typescript
 * // Standard OpenAI
 * const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
 *
 * // Azure OpenAI
 * const azure = new OpenAIProvider({
 *   apiKey: process.env.AZURE_OPENAI_KEY!,
 *   baseURL: 'https://my-resource.openai.azure.com',
 *   apiVersion: '2024-02-01',
 * });
 * ```
 */
export class OpenAIProvider
  extends LLMProvider
  implements FileCapableProvider, BatchCapableProvider
{
  override readonly name: string;
  override readonly providerType: string;

  readonly #client: OpenAI;
  readonly #pricing: Record<string, OpenAIModelPricing>;
  readonly #capabilities: ProviderCapabilities;
  /**
   * Per-model quirks discovered on a previous call (e.g. "this model needs
   * `max_completion_tokens`"), so subsequent calls for the same model skip
   * straight to the working request shape instead of failing once first.
   */
  readonly #modelQuirks = new Map<string, ModelQuirks>();

  /**
   * @param config - Provider configuration.
   * @param client - Optional pre-constructed OpenAI/AzureOpenAI client.
   *                 Primarily used for testing — omit in production.
   */
  constructor(config: OpenAIProviderConfig, client?: OpenAI) {
    super();
    this.name = config.name ?? 'openai';
    this.providerType = config.providerType ?? 'openai';
    this.#capabilities = {
      ...OpenAIProvider.#defaultCapabilities(this.providerType),
      ...config.capabilities,
    };
    this.#client = client ?? OpenAIProvider.#createClient(config);
    // Merge (not replace): an override for one model shouldn't require
    // re-listing every other model that already has a correct built-in price.
    // OpenAI-compatible endpoints can opt out of the built-in table so their
    // model ids don't inadvertently inherit OpenAI's rates.
    this.#pricing = config.disableDefaultPricing
      ? { ...config.pricing }
      : { ...DEFAULT_PRICING, ...config.pricing };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls the OpenAI Chat Completions API and returns a normalised
   * {@link LLMResponse}.
   *
   * @throws {@link ProviderError} on API errors (auth, rate-limit, server errors).
   */
  override async call(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();
    assertResponseFormatSupported(this.name, this.#capabilities, request);
    const resolver = this.#createResolver(request.model);
    let raw: OpenAI.ChatCompletion;
    let streamTimings: StreamTimings | undefined;

    // OpenAI requires tool names to match /^[a-zA-Z0-9_-]+$/ — dots are invalid.
    // Build a bidirectional map: sanitized_name ↔ original_name for this request.
    const nameMap = new Map<string, string>(); // sanitized → original
    const sanitize = (name: string): string => {
      const s = name.replace(/\./g, '_');
      nameMap.set(s, name);
      return s;
    };

    const tools =
      request.tools && request.tools.length > 0
        ? this.#toOpenAITools(request.tools, sanitize)
        : undefined;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.systemPrompt },
      ...(await this.#toOpenAIMessages(request, sanitize, resolver)),
    ];
    const options = request.providerOptions?.openai;

    // Builds the request body for a given set of relaxations (see
    // `#relaxUnsupportedParam`) — kept as a closure so `#createChatCompletion`
    // can rebuild it cheaply on each retry attempt without recomputing
    // `messages`/`tools`.
    const buildParams = (quirks: ModelQuirks): OpenAI.ChatCompletionCreateParamsNonStreaming =>
      ({
        model: request.model,
        messages,
        ...(tools !== undefined && { tools, tool_choice: 'auto' }),
        ...(request.temperature !== undefined &&
          !quirks.omitTemperature && {
            temperature: request.temperature,
          }),
        ...(request.maxTokens !== undefined &&
          (quirks.useLegacyMaxTokens
            ? { max_tokens: request.maxTokens }
            : { max_completion_tokens: request.maxTokens })),
        ...(request.reasoningEffort !== undefined &&
          !quirks.omitReasoningEffort && {
            reasoning_effort: request.reasoningEffort,
          }),
        ...(request.responseFormat !== undefined && {
          response_format: OpenAIProvider.#toResponseFormat(request.responseFormat),
        }),
        ...(options?.stop !== undefined && { stop: options.stop }),
        ...(options?.topP !== undefined && { top_p: options.topP }),
        ...(options?.seed !== undefined && { seed: options.seed }),
        ...(options?.serviceTier !== undefined && { service_tier: options.serviceTier }),
        ...(options?.presencePenalty !== undefined && {
          presence_penalty: options.presencePenalty,
        }),
        ...(options?.frequencyPenalty !== undefined && {
          frequency_penalty: options.frequencyPenalty,
        }),
        // Escape hatch, merged last so it can reach parameters the SDK has not
        // modelled yet. Deliberately unvalidated.
        ...(options?.raw ?? {}),
      }) as OpenAI.ChatCompletionCreateParamsNonStreaming;

    try {
      if (typeof request.onToken === 'function') {
        const buildStreamingParams = (
          quirks: ModelQuirks,
        ): OpenAI.ChatCompletionCreateParamsStreaming =>
          ({
            ...buildParams(quirks),
            stream: true,
            stream_options: { include_usage: true },
          }) as OpenAI.ChatCompletionCreateParamsStreaming;

        const streamed = await this.#createStreamingChatCompletion(
          buildStreamingParams,
          request.model,
          request.onToken,
          request.signal,
          startMs,
        );
        raw = streamed.completion;
        streamTimings = streamed.timings;
      } else {
        raw = await this.#createChatCompletion(buildParams, request.model);
      }
    } catch (err: unknown) {
      throw this.#wrapError(err, request.model);
    }

    const desanitize = (s: string): string => nameMap.get(s) ?? s;
    return this.#fromOpenAIResponse(
      raw,
      Date.now() - startMs,
      desanitize,
      request,
      resolver,
      streamTimings,
    );
  }

  /**
   * Declares this instance's capabilities.
   *
   * Official OpenAI accepts images and PDFs, enforces JSON Schema natively and
   * can combine it with tool calling. An `openai-compatible` endpoint starts
   * from a conservative set that the operator refines via config.
   */
  override capabilities(_model?: string): ProviderCapabilities {
    return this.#capabilities;
  }

  /** Default capabilities per adapter type. */
  static #defaultCapabilities(providerType: string): ProviderCapabilities {
    if (providerType === 'openai') {
      return {
        streaming: true,
        toolCalling: true,
        input: { text: true, image: true, document: true, audio: false, video: false },
        sources: { url: true, providerFile: true },
        structuredOutput: 'jsonSchema',
        structuredOutputWithTools: true,
        files: true,
        batch: true,
      };
    }
    // Third-party OpenAI-compatible server: assume only what is near-universal.
    return {
      streaming: true,
      toolCalling: true,
      input: { text: true, image: true, document: false, audio: false, video: false },
      sources: { url: true, providerFile: false },
      structuredOutput: 'jsonMode',
      structuredOutputWithTools: true,
      files: false,
      batch: false,
    };
  }

  /** Builds a per-request content resolver bound to this provider. */
  #createResolver(model: string): ContentResolver {
    return new ContentResolver({
      provider: this.name,
      providerType: this.providerType,
      capabilities: this.#capabilities,
      model,
      inlineLimitBytes: INLINE_LIMIT_BYTES,
      ...(this.#capabilities.files && { upload: (input) => this.uploadFile(input) }),
    });
  }

  /** Maps the SDK's {@link ResponseFormat} onto OpenAI's `response_format`. */
  static #toResponseFormat(
    format: NonNullable<LLMRequest['responseFormat']>,
  ): OpenAI.ResponseFormatJSONObject | OpenAI.ResponseFormatJSONSchema {
    if (format.type === 'json_object' || format.schema === undefined) {
      return { type: 'json_object' };
    }
    return {
      type: 'json_schema',
      json_schema: {
        // OpenAI requires a schema name; the rest of the providers ignore it.
        name: format.name ?? 'response',
        schema: format.schema,
        ...(format.strict !== undefined && { strict: format.strict }),
      },
    };
  }

  /**
   * Calls the Chat Completions API, automatically relaxing request
   * parameters that the target model/endpoint rejects.
   *
   * The first attempt always uses `max_completion_tokens` — the parameter
   * OpenAI's official API accepts across every current model (o-series,
   * GPT-5, and the older GPT-4/3.5 family alike), so this is a single
   * round-trip for essentially all real traffic. Only a non-official
   * OpenAI-compatible endpoint that hasn't implemented that parameter yet
   * (a self-hosted proxy, or an Azure deployment pinned to an old
   * `apiVersion`) would reject it — that 400 is read directly from the
   * API's own error response and triggers a single fallback retry with the
   * legacy `max_tokens`, remembered per model (`#modelQuirks`) so later
   * calls for that model/endpoint go straight to the working shape.
   *
   * The same mechanism also recovers from `temperature` being rejected
   * (reasoning-family models often only accept their default value).
   * Rather than hardcoding a model-name allowlist that inevitably goes
   * stale, both cases are detected from the API's structured error.
   */
  async #createChatCompletion(
    buildParams: (quirks: ModelQuirks) => OpenAI.ChatCompletionCreateParamsNonStreaming,
    model: string,
    quirks: ModelQuirks = this.#modelQuirks.get(model) ?? {},
    attempt = 0,
  ): Promise<OpenAI.ChatCompletion> {
    try {
      const raw = await this.#client.chat.completions.create(buildParams(quirks));
      if (attempt > 0) this.#modelQuirks.set(model, quirks);
      return raw;
    } catch (err: unknown) {
      const relaxed =
        attempt < MAX_QUIRK_ATTEMPTS
          ? OpenAIProvider.#relaxUnsupportedParam(err, quirks)
          : undefined;
      if (relaxed === undefined) throw err;
      return this.#createChatCompletion(buildParams, model, relaxed, attempt + 1);
    }
  }

  /**
   * Starts and consumes a streamed Chat Completion. Parameter relaxation is
   * applied only while opening the stream; once a token has been delivered the
   * request is never retried, avoiding duplicated output at the caller.
   */
  async #createStreamingChatCompletion(
    buildParams: (quirks: ModelQuirks) => OpenAI.ChatCompletionCreateParamsStreaming,
    model: string,
    onToken: (delta: string) => void,
    signal?: AbortSignal,
    requestStartMs = Date.now(),
    quirks: ModelQuirks = this.#modelQuirks.get(model) ?? {},
    attempt = 0,
  ): Promise<StreamCompletionResult> {
    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.#client.chat.completions.create(
        buildParams(quirks),
        signal === undefined ? undefined : { signal },
      );
    } catch (err: unknown) {
      const relaxed =
        attempt < MAX_QUIRK_ATTEMPTS
          ? OpenAIProvider.#relaxUnsupportedParam(err, quirks)
          : undefined;
      if (relaxed === undefined) throw err;
      return this.#createStreamingChatCompletion(
        buildParams,
        model,
        onToken,
        signal,
        requestStartMs,
        relaxed,
        attempt + 1,
      );
    }

    if (attempt > 0) this.#modelQuirks.set(model, quirks);
    return this.#consumeChatCompletionStream(stream, model, onToken, requestStartMs, Date.now());
  }

  /**
   * Reconstructs the final ChatCompletion while forwarding text deltas
   * immediately. Function-call deltas are accumulated by index and deliberately
   * not exposed as text tokens.
   */
  async #consumeChatCompletionStream(
    stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
    requestedModel: string,
    onToken: (delta: string) => void,
    requestStartMs: number,
    streamOpenedAtMs: number,
  ): Promise<StreamCompletionResult> {
    let id = '';
    let created = Math.floor(Date.now() / 1_000);
    let model = requestedModel;
    let content = '';
    let finishReason: OpenAI.ChatCompletionChunk.Choice['finish_reason'] = null;
    let usage: OpenAI.ChatCompletion['usage'];
    let firstChunkAtMs: number | undefined;
    let firstTokenAtMs: number | undefined;
    const streamedToolCalls = new Map<number, StreamedToolCall>();

    for await (const chunk of stream) {
      if (firstChunkAtMs === undefined) firstChunkAtMs = Date.now();
      if (chunk.id) id = chunk.id;
      if (chunk.created) created = chunk.created;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices.find((candidate) => candidate.index === 0);
      if (!choice) continue;
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta.content) {
        if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
        content += delta.content;
        onToken(delta.content);
      }

      for (const toolDelta of delta.tool_calls ?? []) {
        const current = streamedToolCalls.get(toolDelta.index) ?? {
          name: '',
          arguments: '',
        };
        if (toolDelta.id) current.id = toolDelta.id;
        if (toolDelta.function?.name) current.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) {
          current.arguments += toolDelta.function.arguments;
        }
        streamedToolCalls.set(toolDelta.index, current);
      }
    }

    const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [
      ...streamedToolCalls.entries(),
    ]
      .sort(([left], [right]) => left - right)
      .map(([index, toolCall]) => ({
        id: toolCall.id ?? `tool_call_${index}`,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));

    const completedAtMs = Date.now();
    const completion: OpenAI.ChatCompletion = {
      id: id || `chatcmpl-stream-${created}`,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            refusal: null,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          },
          finish_reason: finishReason as OpenAI.ChatCompletion.Choice['finish_reason'],
          logprobs: null,
        },
      ],
      ...(usage !== undefined && { usage }),
    };
    return {
      completion,
      timings: {
        streamOpenMs: streamOpenedAtMs - requestStartMs,
        ...(firstChunkAtMs !== undefined && {
          timeToFirstChunkMs: firstChunkAtMs - requestStartMs,
        }),
        ...(firstTokenAtMs !== undefined && {
          timeToFirstTokenMs: firstTokenAtMs - requestStartMs,
          generationMs: completedAtMs - firstTokenAtMs,
        }),
      },
    };
  }

  /**
   * Inspects a failed request for the "unsupported parameter/value" shape
   * OpenAI (or an OpenAI-compatible endpoint) uses to reject a parameter,
   * and returns the relaxed quirks to retry with. Returns `undefined` when
   * the error isn't one we know how to recover from, so the original error
   * propagates unchanged.
   */
  static #relaxUnsupportedParam(err: unknown, quirks: ModelQuirks): ModelQuirks | undefined {
    if (!(err instanceof OpenAI.APIError) || err.status !== 400) return undefined;

    const param = err.param ?? OpenAIProvider.#paramFromMessage(err.message);

    // Endpoint doesn't recognize the modern parameter — fall back to the
    // legacy one (only ever expected on non-official/self-hosted endpoints;
    // the official API accepts max_completion_tokens on every current model).
    if (param === 'max_completion_tokens' && !quirks.useLegacyMaxTokens) {
      return { ...quirks, useLegacyMaxTokens: true };
    }
    // Reasoning-family model rejects a non-default temperature.
    if (param === 'temperature' && !quirks.omitTemperature) {
      return { ...quirks, omitTemperature: true };
    }
    // Endpoint/model doesn't support reasoning effort (common on
    // OpenAI-compatible servers) — drop it and retry.
    if (param === 'reasoning_effort' && !quirks.omitReasoningEffort) {
      return { ...quirks, omitReasoningEffort: true };
    }
    return undefined;
  }

  /**
   * Best-effort extraction of the offending parameter name from the error
   * message, for OpenAI-compatible endpoints (proxies, gateways) that mirror
   * OpenAI's error text but don't populate the structured `error.param` field.
   */
  static #paramFromMessage(message: string): string | undefined {
    return /'([\w.]+)'\s+(?:is not supported|does not support)/i.exec(message)?.[1];
  }

  /**
   * Verifies the API key and connectivity by listing available models.
   * Reports the failure reason instead of throwing.
   */
  override async validate(): Promise<ProviderProbe> {
    try {
      await this.#client.models.list();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Returns available model identifiers from the OpenAI API.
   * Falls back to a static known-models list on failure.
   */
  override async listModels(): Promise<string[]> {
    try {
      const list = await this.#client.models.list();
      return list.data.map((m) => m.id);
    } catch {
      return [...KNOWN_MODELS];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: SDK → OpenAI
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts SDK {@link ToolDescriptor}s to the OpenAI function-calling format.
   *
   * OpenAI uses `function.parameters` where the SDK uses `inputSchema`.
   */
  #toOpenAITools(
    tools: ToolDescriptor[],
    sanitize: (name: string) => string,
  ): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: sanitize(tool.name),
        description: tool.description,
        // Cast: JSONSchema (Record<string,unknown>) satisfies OpenAI's FunctionParameters.
        parameters: tool.inputSchema as OpenAI.FunctionParameters,
      },
    }));
  }

  /**
   * Converts SDK {@link LLMMessage}s to OpenAI `ChatCompletionMessageParam`s.
   *
   * Role mapping differs from Claude:
   * - `'system'` messages are skipped here (handled via the top-level `messages[0]`).
   * - `'tool'` → `role:'tool'` with `tool_call_id` (OpenAI keeps each result separate).
   * - `'assistant'` with `ContentBlock[]` → `role:'assistant'` with `tool_calls[]`.
   * - `'user'` with `ContentBlock[]` → text, `image_url` and `file` content parts.
   */
  async #toOpenAIMessages(
    request: LLMRequest,
    sanitize: (name: string) => string,
    resolver: ContentResolver,
  ): Promise<OpenAI.ChatCompletionMessageParam[]> {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of request.messages) {
      // System role is passed as the first message externally — skip here.
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId!,
        });
        continue;
      }

      if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          // ContentBlock[] from a prior tool-calling round — reconstruct tool_calls.
          const blocks = msg.content;
          const textContent = blocks
            .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
            .map((b) => b.text)
            .join('');
          const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');

          result.push({
            role: 'assistant',
            content: textContent || null,
            ...(toolUseBlocks.length > 0 && {
              tool_calls: toolUseBlocks.map((b) => ({
                id: b.toolUseId,
                type: 'function' as const,
                function: {
                  name: sanitize(b.toolName),
                  // OpenAI expects arguments as a JSON string.
                  arguments: JSON.stringify(b.input ?? {}),
                },
              })),
            }),
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }

      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          result.push({
            role: 'user',
            content: await this.#toUserParts(msg.content, request, resolver),
          });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      }
    }

    return result;
  }

  /** Translates one user turn's blocks into OpenAI content parts. */
  async #toUserParts(
    blocks: ContentBlock[],
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<OpenAI.ChatCompletionContentPart[]> {
    const parts: OpenAI.ChatCompletionContentPart[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'media_omitted') {
        parts.push({ type: 'text', text: describeOmitted(block) });
        continue;
      }
      if (!isMediaBlock(block)) continue;

      const resolved = await resolver.resolve(block, request.fileHandling ?? 'inline');
      parts.push(this.#toContentPart(block, resolved, request.model));
    }

    return parts;
  }

  /** Builds an `image_url` or `file` content part from resolved content. */
  #toContentPart(
    block: MediaBlock,
    resolved: ResolvedContent,
    model: string,
  ): OpenAI.ChatCompletionContentPart {
    if (block.type === 'image') {
      const url =
        resolved.kind === 'url'
          ? resolved.url
          : resolved.kind === 'inline'
            ? `data:${resolved.mimeType};base64,${resolved.base64}`
            : undefined;
      if (url === undefined) {
        throw new UnsupportedCapabilityError(
          this.name,
          'input.image',
          'images must be sent inline or by URL; file references are only ' +
            'supported for documents',
          model,
        );
      }
      return {
        type: 'image_url',
        image_url: {
          url,
          ...(block.options?.detail !== undefined && { detail: block.options.detail }),
        },
      };
    }

    if (block.type === 'document') {
      if (resolved.kind === 'providerFile') {
        return { type: 'file', file: { file_id: resolved.ref.fileId } };
      }
      if (resolved.kind === 'inline') {
        return {
          type: 'file',
          file: {
            filename: resolved.fileName ?? 'document',
            file_data: `data:${resolved.mimeType};base64,${resolved.base64}`,
          },
        };
      }
      throw new UnsupportedCapabilityError(
        this.name,
        'sources.url',
        'Chat Completions does not fetch document URLs; pass bytes or a path, ' +
          'or upload the file first',
        model,
      );
    }

    throw new UnsupportedCapabilityError(
      this.name,
      `input.${block.type}`,
      'this provider accepts image and document input only',
      model,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: OpenAI → SDK
  // ─────────────────────────────────────────────────────────────────────────

  /** Converts an OpenAI `ChatCompletion` to the SDK's normalised `LLMResponse`. */
  #fromOpenAIResponse(
    raw: OpenAI.ChatCompletion,
    latencyMs: number,
    desanitize: (s: string) => string,
    request: LLMRequest,
    resolver: ContentResolver | undefined,
    streamTimings?: StreamTimings,
    executionMode: ExecutionMode = 'sync',
  ): LLMResponse {
    const choice = raw.choices[0]!;
    const msg = choice.message;

    const content = msg.content ?? '';

    // ── Tool calls ────────────────────────────────────────────────────────
    // OpenAI arguments are JSON strings; parse them to objects.
    const toolCalls: ToolCall[] | undefined = msg.tool_calls
      ?.filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        toolName: desanitize(tc.function.name),
        input: OpenAIProvider.#safeParseJson(tc.function.arguments),
      }));

    // ── ContentBlocks for multi-turn round-trip ──────────────────────────
    const contentBlocks: ContentBlock[] = [];
    if (content) contentBlocks.push({ type: 'text', text: content });
    if (toolCalls) {
      for (const tc of toolCalls) {
        contentBlocks.push({
          type: 'tool_use',
          toolUseId: tc.id,
          toolName: tc.toolName,
          input: tc.input,
        });
      }
    }

    // ── Usage & cost ──────────────────────────────────────────────────────
    const inputTokens = raw.usage?.prompt_tokens ?? 0;
    const outputTokens = raw.usage?.completion_tokens ?? 0;
    const reasoningTokens = raw.usage?.completion_tokens_details?.reasoning_tokens;
    const cachedInputTokens = raw.usage?.prompt_tokens_details?.cached_tokens;
    const visibleOutputTokens = Math.max(0, outputTokens - (reasoningTokens ?? 0));
    const visibleTokensPerSecond =
      streamTimings?.generationMs !== undefined && streamTimings.generationMs > 0
        ? visibleOutputTokens / (streamTimings.generationMs / 1_000)
        : undefined;
    const cost = this.#estimateCost(raw.model, inputTokens, outputTokens, executionMode);

    const structured = buildStructuredOutput(
      content,
      request.responseFormat,
      request.responseFormat === undefined
        ? 'none'
        : request.responseFormat.type === 'json_schema'
          ? 'native_schema'
          : 'native_json',
    );
    const uploadedFiles = resolver?.uploadedFiles;

    return {
      content,
      ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
      stopReason: this.#mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cost !== undefined && { cost }),
      },
      model: raw.model,
      provider: this.name,
      providerType: this.providerType,
      executionMode,
      latencyMs,
      ...(structured !== undefined && { structured }),
      ...(uploadedFiles !== undefined && uploadedFiles.length > 0 && { uploadedFiles }),
      ...(request.includeRaw === true && { providerRaw: raw }),
      ...((streamTimings !== undefined ||
        reasoningTokens !== undefined ||
        cachedInputTokens !== undefined) && {
        performance: {
          ...(streamTimings ?? {}),
          visibleOutputTokens,
          ...(visibleTokensPerSecond !== undefined && { visibleTokensPerSecond }),
          ...(reasoningTokens !== undefined && { reasoningTokens }),
          ...(cachedInputTokens !== undefined && { cachedInputTokens }),
        },
      }),
      ...(contentBlocks.length > 0 && { contentBlocks }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Files API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Uploads a file to OpenAI's file store.
   *
   * `purpose` maps to OpenAI's own: `'input'` → `user_data` (referenced from a
   * message), `'batch'` → `batch` (a JSONL job input). Files persist until
   * deleted, so the reference carries no expiry.
   *
   * @param input - File content plus its media type and optional name.
   */
  async uploadFile(input: FileUploadInput): Promise<ProviderFileRef> {
    const { bytes, fileName, mimeType } = await OpenAIProvider.#readUploadInput(input);
    try {
      const uploaded = await this.#client.files.create({
        file: await toFile(Buffer.from(bytes), fileName, { type: mimeType }),
        purpose: input.purpose === 'batch' ? 'batch' : 'user_data',
      });
      return {
        fileId: uploaded.id,
        provider: this.name,
        providerType: this.providerType,
        mimeType,
        fileName: uploaded.filename,
        byteLength: uploaded.bytes,
      };
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  /**
   * Reads the metadata of a stored file.
   *
   * @param fileId - Identifier returned by {@link uploadFile}.
   */
  async getFile(fileId: string): Promise<ProviderFileRef> {
    try {
      const file = await this.#client.files.retrieve(fileId);
      return {
        fileId: file.id,
        provider: this.name,
        providerType: this.providerType,
        fileName: file.filename,
        byteLength: file.bytes,
      };
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  /**
   * Deletes a stored file.
   *
   * @param fileId - Identifier returned by {@link uploadFile}.
   */
  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.#client.files.delete(fileId);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  /** Materialises upload input as bytes plus a name and media type. */
  static async #readUploadInput(
    input: FileUploadInput,
  ): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string }> {
    const bytes =
      input.content.kind === 'bytes'
        ? input.content.bytes
        : await readFileBytes(input.content.path);
    const fromPath = input.content.kind === 'path' ? input.content.path : undefined;
    const fileName =
      input.fileName ?? (fromPath !== undefined ? fromPath.split('/').pop()! : 'upload.bin');
    const mimeType =
      input.mimeType ??
      (fromPath !== undefined ? mimeTypeFromPath(fromPath) : undefined) ??
      'application/octet-stream';
    return { bytes, fileName, mimeType };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Batch API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submits requests as an OpenAI batch job.
   *
   * Unlike Anthropic and Gemini, OpenAI takes batch input only as a JSONL file:
   * the SDK serialises each {@link LLMRequest} into a `/v1/chat/completions`
   * line keyed by `custom_id`, uploads it with `purpose: 'batch'`, and creates
   * the job from the resulting file.
   *
   * @param items   - Requests, each with a stable `customId`.
   * @param options - Optional job name and default model.
   */
  async submitBatch(items: BatchRequestItem[], options?: BatchSubmitOptions): Promise<BatchJob> {
    const lines: string[] = [];

    for (const item of items) {
      const request: LLMRequest =
        options?.model !== undefined && item.request.model === ''
          ? { ...item.request, model: options.model }
          : item.request;
      assertResponseFormatSupported(this.name, this.#capabilities, request);
      const body = await this.#buildBatchBody(request);
      lines.push(
        JSON.stringify({
          custom_id: item.customId,
          method: 'POST',
          url: '/v1/chat/completions',
          body,
        }),
      );
    }

    try {
      const inputFile = await this.#client.files.create({
        file: await toFile(Buffer.from(lines.join('\n')), 'batch.jsonl', {
          type: 'application/jsonl',
        }),
        purpose: 'batch',
      });
      const batch = await this.#client.batches.create({
        input_file_id: inputFile.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        ...(options?.displayName !== undefined && {
          metadata: { display_name: options.displayName },
        }),
      });
      return this.#toBatchJob(batch, options?.model);
    } catch (err: unknown) {
      throw this.#wrapError(err, options?.model ?? 'batch');
    }
  }

  /**
   * Reads the current state of a batch job.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async getBatch(jobId: string): Promise<BatchJob> {
    try {
      return this.#toBatchJob(await this.#client.batches.retrieve(jobId));
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  /**
   * Streams the results of a finished batch, one item at a time.
   *
   * Both the output and error files are read line by line, so a job with tens
   * of thousands of documents never has to be held in memory at once.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async *streamBatchResults(jobId: string): AsyncIterable<BatchResultItem> {
    let batch: OpenAI.Batches.Batch;
    try {
      batch = await this.#client.batches.retrieve(jobId);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }

    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (fileId === undefined || fileId === null) continue;
      for await (const line of this.#streamFileLines(fileId)) {
        const parsed = OpenAIProvider.#safeParseJson(line) as {
          custom_id?: string;
          response?: { status_code?: number; body?: OpenAI.ChatCompletion };
          error?: { message?: string; code?: string };
        };
        if (parsed.custom_id === undefined) continue;
        yield this.#toBatchResult(parsed);
      }
    }
  }

  /**
   * Requests cancellation of a batch that has not finished.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async cancelBatch(jobId: string): Promise<void> {
    try {
      await this.#client.batches.cancel(jobId);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  /** Builds the Chat Completions body for one batched request. */
  async #buildBatchBody(request: LLMRequest): Promise<Record<string, unknown>> {
    const resolver = this.#createResolver(request.model);
    const nameMap = new Map<string, string>();
    const sanitize = (name: string): string => {
      const clean = name.replace(/\./g, '_');
      nameMap.set(clean, name);
      return clean;
    };
    const options = request.providerOptions?.openai;

    return {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        ...(await this.#toOpenAIMessages(request, sanitize, resolver)),
      ],
      ...(request.tools &&
        request.tools.length > 0 && {
          tools: this.#toOpenAITools(request.tools, sanitize),
          tool_choice: 'auto',
        }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { max_completion_tokens: request.maxTokens }),
      ...(request.responseFormat !== undefined && {
        response_format: OpenAIProvider.#toResponseFormat(request.responseFormat),
      }),
      ...(options?.raw ?? {}),
    };
  }

  /** Reads a stored file and yields it line by line. */
  async *#streamFileLines(fileId: string): AsyncIterable<string> {
    const response = await this.#client.files.content(fileId);
    const body = await response.text();
    for (const line of body.split('\n')) {
      if (line.trim() !== '') yield line;
    }
  }

  /** Maps an OpenAI batch onto the normalised {@link BatchJob}. */
  #toBatchJob(batch: OpenAI.Batches.Batch, model?: string): BatchJob {
    const counts = batch.request_counts;
    return {
      jobId: batch.id,
      provider: this.name,
      providerType: this.providerType,
      ...(model !== undefined && { model }),
      status: OpenAIProvider.#mapBatchStatus(batch.status),
      createdAt: new Date(batch.created_at * 1_000),
      ...(batch.completed_at != null && { updatedAt: new Date(batch.completed_at * 1_000) }),
      ...(batch.expires_at != null && { expiresAt: new Date(batch.expires_at * 1_000) }),
      ...(counts !== undefined && {
        counts: {
          total: counts.total,
          succeeded: counts.completed,
          failed: counts.failed,
          cancelled: 0,
          expired: 0,
        },
      }),
      ...(batch.errors?.data?.[0]?.message !== undefined && {
        error: batch.errors.data[0].message,
      }),
    };
  }

  /** Normalises OpenAI's batch status vocabulary. */
  static #mapBatchStatus(status: string): BatchJob['status'] {
    switch (status) {
      case 'validating':
        return 'queued';
      case 'in_progress':
      case 'finalizing':
        return 'running';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'expired':
        return 'expired';
      case 'cancelling':
      case 'cancelled':
        return 'cancelled';
      default:
        return 'running';
    }
  }

  /** Maps one JSONL output line onto the normalised {@link BatchResultItem}. */
  #toBatchResult(entry: {
    custom_id?: string;
    response?: { status_code?: number; body?: OpenAI.ChatCompletion };
    error?: { message?: string; code?: string };
  }): BatchResultItem {
    const customId = entry.custom_id!;
    const body = entry.response?.body;
    const statusCode = entry.response?.status_code;

    if (body !== undefined && (statusCode === undefined || statusCode < 400)) {
      const request: LLMRequest = { systemPrompt: '', messages: [], model: body.model };
      return {
        customId,
        response: this.#fromOpenAIResponse(
          body,
          0,
          (name) => name,
          request,
          undefined,
          undefined,
          'batch',
        ),
      };
    }

    const message = entry.error?.message ?? 'request failed';
    return {
      customId,
      error: { message, ...(entry.error?.code !== undefined && { code: entry.error.code }) },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #mapFinishReason(reason: string | null): LLMResponse['stopReason'] {
    switch (reason) {
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'stop':
        return 'end';
      default:
        return 'end';
    }
  }

  #estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    executionMode: ExecutionMode = 'sync',
  ): number | undefined {
    const pricing =
      this.#pricing[model] ?? OpenAIProvider.#longestPrefixMatch(this.#pricing, model);

    if (pricing === undefined) return undefined;

    // Batch rates are declared per model, never assumed as a blanket discount.
    const inputRate =
      executionMode === 'batch' ? (pricing.batchInput ?? pricing.input) : pricing.input;
    const outputRate =
      executionMode === 'batch' ? (pricing.batchOutput ?? pricing.output) : pricing.output;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000;
  }

  /**
   * Finds the pricing entry whose key is the **longest** matching prefix of
   * `model`. Plain first-match iteration would be order-dependent — e.g.
   * with both `'gpt-5'` and `'gpt-5-mini'` as keys, a dated snapshot like
   * `'gpt-5-mini-2026-03-01'` matches both prefixes, and picking whichever key
   * happens to iterate first would silently price a mini/nano call at the
   * full model's (much higher) rate.
   */
  static #longestPrefixMatch(
    pricing: Record<string, OpenAIModelPricing>,
    model: string,
  ): OpenAIModelPricing | undefined {
    let bestKey: string | undefined;
    let bestValue: OpenAIModelPricing | undefined;
    for (const [key, value] of Object.entries(pricing)) {
      if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
        bestKey = key;
        bestValue = value;
      }
    }
    return bestValue;
  }

  #wrapError(err: unknown, model: string): unknown {
    if (err instanceof OpenAI.APIError) {
      return new ProviderError(this.name, err.message, model, err.status ?? undefined);
    }
    return err;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Static helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates the appropriate OpenAI client based on the provided configuration.
   * When `apiVersion` is present, returns an `AzureOpenAI` client.
   */
  static #createClient(config: OpenAIProviderConfig): OpenAI {
    const shared = {
      apiKey: config.apiKey,
      ...(config.maxRetries !== undefined && { maxRetries: config.maxRetries }),
      ...(config.timeoutMs !== undefined && { timeout: config.timeoutMs }),
      ...(config.defaultHeaders !== undefined && { defaultHeaders: config.defaultHeaders }),
    };

    if (config.apiVersion !== undefined) {
      // Azure OpenAI: baseURL is used as the resource endpoint.
      return new AzureOpenAI({
        ...shared,
        endpoint: config.baseURL,
        apiVersion: config.apiVersion,
      });
    }

    return new OpenAI({
      ...shared,
      ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
      ...(config.organization !== undefined && { organization: config.organization }),
    });
  }

  /** Safely parses a JSON string; falls back to `{}` on invalid input. */
  static #safeParseJson(json: string): unknown {
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }
}
