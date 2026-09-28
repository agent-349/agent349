import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { GoogleGenAI } from '@google/genai';
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
  ModalityUsage,
  ProviderCapabilities,
  ProviderFileRef,
  ProviderProbe,
  ToolCall,
} from '../../types/index.js';
import { ProviderError, UnsupportedCapabilityError } from '../../errors/index.js';
import type { BatchCapableProvider, FileCapableProvider } from '../LLMProvider.js';
import { LLMProvider } from '../LLMProvider.js';
import { ContentResolver } from '../ContentResolver.js';
import { mimeTypeFromPath, readFileBytes } from '../../content/index.js';
import { assertResponseFormatSupported, buildStructuredOutput } from '../structured.js';
import { toGenerateContentRequest } from './generateContentMapper.js';
import { THOUGHT_SIGNATURE_KEY, toInteractionBody } from './interactionsMapper.js';
import {
  DEFAULT_GEMINI_PRICING,
  KNOWN_GEMINI_MODELS,
  longestPrefixMatch,
  type GeminiModelPricing,
} from './models.js';
import type {
  GenerateContentResponseBody,
  GenerateContentUsage,
  InteractionBlock,
  InteractionResponse,
  InteractionStreamEvent,
  InteractionUsage,
} from './wire.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration accepted by {@link GeminiProvider}. */
export interface GeminiProviderConfig {
  /**
   * Instance identity used as the provider `name` (router key, and the value
   * reported in `LLMResponse.provider` / `ProviderError`). Defaults to
   * `'gemini'`.
   */
  name?: string;
  /** Google AI API key. Use `${GEMINI_API_KEY}` in JSON config. */
  apiKey: string;
  /**
   * Default model identifier for this instance. No Gemini generation is
   * hard-wired into the SDK: pick a current stable model (e.g.
   * `gemini-3.8-flash`). Moving aliases such as `gemini-flash-latest` may point
   * to preview or experimental releases, which Google advises against in
   * production.
   */
  defaultModel?: string;
  /** Request timeout in milliseconds. Default: 60 000. */
  timeoutMs?: number;
  /**
   * Per-model pricing table (USD / 1 000 tokens), merged on top of the built-in
   * defaults — only models that are new or whose rate changed need an entry.
   * Batch rates are declared per model, never assumed as a blanket discount.
   */
  pricing?: Record<string, GeminiModelPricing>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal client surface
// ─────────────────────────────────────────────────────────────────────────────

/** A file resource as returned by the Files API. */
interface GeminiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  sizeBytes?: string | number;
  expirationTime?: string;
  displayName?: string;
}

/** A batch job resource as returned by the Batches API. */
interface GeminiBatchJobResource {
  name?: string;
  model?: string;
  state?: string;
  createTime?: string;
  updateTime?: string;
  endTime?: string;
  error?: { message?: string };
  dest?: { fileName?: string };
}

/**
 * The subset of `@google/genai` the provider uses.
 *
 * Declared structurally so tests can inject a fake without constructing a real
 * client, matching the pattern the other providers already follow.
 */
export interface GeminiClient {
  interactions: {
    create(
      body: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<InteractionResponse | AsyncIterable<InteractionStreamEvent>>;
  };
  files: {
    upload(params: { file: unknown; config?: Record<string, unknown> }): Promise<GeminiFile>;
    get(params: { name: string }): Promise<GeminiFile>;
    delete(params: { name: string }): Promise<unknown>;
    download(params: { file: string; downloadPath: string }): Promise<void>;
  };
  batches: {
    create(params: {
      model?: string;
      src: unknown;
      config?: Record<string, unknown>;
    }): Promise<GeminiBatchJobResource>;
    get(params: { name: string }): Promise<GeminiBatchJobResource>;
    cancel(params: { name: string }): Promise<unknown>;
  };
  models: {
    list(params?: unknown): Promise<AsyncIterable<{ name?: string }>>;
  };
}

/**
 * Gemini's documented inline ceiling for batch payloads and a safe bound for a
 * single interaction. Content above it must go through the Files API.
 */
const INLINE_LIMIT_BYTES = 18 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// GeminiProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM provider implementation for Google Gemini.
 *
 * The provider speaks **two Google surfaces**, chosen per capability, and hides
 * the split entirely from callers:
 *
 * | Capability | Surface | Why |
 * |---|---|---|
 * | Synchronous calls (text, media, tools, structured output, streaming) | **Interactions API** | Google's current, generally-available surface: typed content blocks per modality, `response_format` combinable with tools, and per-modality token accounting. |
 * | File storage | **Files API** | Shared by both surfaces. |
 * | Batch jobs | **`generateContent`** | Gemini's Batch API accepts `GenerateContentRequest` objects only. |
 *
 * `store` is hard-wired to `false` on every interaction: conversation state,
 * memory and governance stay inside Agent349 rather than being retained on
 * Google's servers.
 *
 * Usage is normalised so cost comparisons hold across providers — thinking
 * tokens count as output, the way OpenAI already bills its reasoning tokens.
 *
 * @example
 * ```typescript
 * const gemini = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! });
 * const response = await gemini.call({
 *   systemPrompt: 'You extract structured data.',
 *   messages: [{ role: 'user', content: [documentFromPath('/tmp/invoice.pdf')] }],
 *   model: 'gemini-3.8-flash',
 *   responseFormat: { type: 'json_schema', schema: invoiceSchema },
 * });
 * ```
 */
export class GeminiProvider
  extends LLMProvider
  implements FileCapableProvider, BatchCapableProvider
{
  override readonly name: string;
  override readonly providerType = 'gemini';

  readonly #client: GeminiClient;
  readonly #pricing: Record<string, GeminiModelPricing>;
  readonly #defaultModel: string | undefined;

  /**
   * @param config - Provider configuration (API key, default model, pricing).
   * @param client - Optional pre-constructed client. Used for testing
   *                 (dependency injection) — omit in production.
   */
  constructor(config: GeminiProviderConfig, client?: GeminiClient) {
    super();
    this.name = config.name ?? 'gemini';
    this.#defaultModel = config.defaultModel;
    this.#pricing = { ...DEFAULT_GEMINI_PRICING, ...config.pricing };
    this.#client =
      client ??
      (new GoogleGenAI({
        apiKey: config.apiKey,
        ...(config.timeoutMs !== undefined && {
          httpOptions: { timeout: config.timeoutMs },
        }),
      }) as unknown as GeminiClient);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls the Interactions API and returns a normalised {@link LLMResponse}.
   *
   * Streams when `request.onToken` is provided, forwarding text deltas as they
   * arrive while still returning the fully-assembled response. `request.signal`
   * cancels an in-flight call.
   *
   * @throws {@link ProviderError} on API errors (auth, rate-limit, server errors).
   * @throws {@link UnsupportedCapabilityError} when the request needs something
   *         the model cannot do.
   */
  override async call(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();
    const model = request.model !== '' ? request.model : (this.#defaultModel ?? '');
    if (model === '') {
      throw new UnsupportedCapabilityError(
        this.name,
        'model',
        'no model was given and this instance has no defaultModel configured',
      );
    }

    const effective: LLMRequest = { ...request, model };
    assertResponseFormatSupported(this.name, this.capabilities(model), effective);

    const resolver = this.#createResolver(model);
    const body = await toInteractionBody(effective, resolver);

    try {
      if (typeof request.onToken === 'function') {
        const streamed = await this.#client.interactions.create(
          { ...body, stream: true },
          request.signal !== undefined ? { signal: request.signal } : undefined,
        );
        const interaction = await GeminiProvider.#consumeStream(
          streamed as AsyncIterable<InteractionStreamEvent>,
          request.onToken,
        );
        return this.#fromInteraction(interaction, effective, resolver, Date.now() - startMs);
      }

      const interaction = (await this.#client.interactions.create(
        body,
        request.signal !== undefined ? { signal: request.signal } : undefined,
      )) as InteractionResponse;
      return this.#fromInteraction(interaction, effective, resolver, Date.now() - startMs);
    } catch (err: unknown) {
      throw this.#wrapError(err, model);
    }
  }

  /**
   * Declares Gemini's capabilities.
   *
   * Gemini accepts every input modality, fetches URIs itself (Files API URIs
   * and public HTTPS URLs alike, so the SDK never has to download anything),
   * enforces JSON Schema natively, and combines structured output with tools.
   */
  override capabilities(_model?: string): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      input: { text: true, image: true, document: true, audio: true, video: true },
      sources: { url: true, providerFile: true },
      structuredOutput: 'jsonSchema',
      structuredOutputWithTools: true,
      files: true,
      batch: true,
    };
  }

  /**
   * Verifies the API key by listing models.
   * Reports the failure reason instead of throwing.
   */
  override async validate(): Promise<ProviderProbe> {
    try {
      await this.listModelsOrThrow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Returns available Gemini model identifiers.
   * Falls back to a static list when the API is unreachable.
   */
  override async listModels(): Promise<string[]> {
    try {
      return await this.listModelsOrThrow();
    } catch {
      return [...KNOWN_GEMINI_MODELS];
    }
  }

  /** Lists models, propagating failures (used by {@link validate}). */
  async listModelsOrThrow(): Promise<string[]> {
    const pager = await this.#client.models.list();
    const names: string[] = [];
    for await (const model of pager) {
      if (model.name !== undefined) names.push(model.name.replace(/^models\//, ''));
    }
    return names;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Files API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Uploads a file to Gemini's file store.
   *
   * Gemini deletes uploaded files after 48 hours, so the returned reference
   * carries an `expiresAt`; the SDK refuses to reuse it once that passes rather
   * than letting the call fail opaquely at the wire level.
   *
   * @param input - File content plus its media type and optional name.
   */
  async uploadFile(input: FileUploadInput): Promise<ProviderFileRef> {
    const bytes =
      input.content.kind === 'bytes'
        ? input.content.bytes
        : await readFileBytes(input.content.path);
    const fromPath = input.content.kind === 'path' ? input.content.path : undefined;
    const mimeType =
      input.mimeType ??
      (fromPath !== undefined ? mimeTypeFromPath(fromPath) : undefined) ??
      'application/octet-stream';

    try {
      const file = await this.#client.files.upload({
        file: new Blob([Buffer.from(bytes)], { type: mimeType }),
        config: {
          mimeType,
          ...(input.fileName !== undefined && { displayName: input.fileName }),
        },
      });
      return this.#toFileRef(file, mimeType, input.fileName);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  /**
   * Reads the current state of a stored file, including its expiry.
   *
   * @param fileId - Reference id returned by {@link uploadFile}.
   */
  async getFile(fileId: string): Promise<ProviderFileRef> {
    try {
      const file = await this.#client.files.get({ name: GeminiProvider.#toFileName(fileId) });
      return this.#toFileRef(file);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  /**
   * Deletes a stored file.
   *
   * @param fileId - Reference id returned by {@link uploadFile}.
   */
  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.#client.files.delete({ name: GeminiProvider.#toFileName(fileId) });
    } catch (err: unknown) {
      throw this.#wrapError(err, 'files');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Batch API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submits requests as a Gemini batch job.
   *
   * Requests are written as a JSONL input file rather than sent inline: the
   * file format carries a per-line `key`, which is what lets a `customId`
   * survive a process restart. An inline submission would only preserve request
   * order, forcing the application to keep its own position map.
   *
   * @param items   - Requests, each with a stable `customId`.
   * @param options - Optional job name and default model.
   */
  async submitBatch(items: BatchRequestItem[], options?: BatchSubmitOptions): Promise<BatchJob> {
    if (items.length === 0) {
      throw new UnsupportedCapabilityError(
        this.name,
        'batch',
        'a batch needs at least one request',
      );
    }

    const lines: string[] = [];
    let model = options?.model ?? this.#defaultModel;

    for (const item of items) {
      const itemModel = item.request.model !== '' ? item.request.model : (model ?? '');
      if (itemModel === '') {
        throw new UnsupportedCapabilityError(
          this.name,
          'model',
          `request '${item.customId}' has no model and no default was given`,
        );
      }
      model ??= itemModel;

      const effective: LLMRequest = { ...item.request, model: itemModel };
      assertResponseFormatSupported(this.name, this.capabilities(itemModel), effective);
      const resolver = this.#createResolver(itemModel);
      const request = await toGenerateContentRequest(effective, this.name, resolver);
      lines.push(JSON.stringify({ key: item.customId, request }));
    }

    try {
      const inputFile = await this.#client.files.upload({
        file: new Blob([lines.join('\n')], { type: 'application/jsonl' }),
        config: { mimeType: 'application/jsonl', displayName: 'agent349-batch-input.jsonl' },
      });
      const job = await this.#client.batches.create({
        ...(model !== undefined && { model }),
        src: inputFile.name ?? '',
        ...(options?.displayName !== undefined && {
          config: { displayName: options.displayName },
        }),
      });
      return this.#toBatchJob(job, model);
    } catch (err: unknown) {
      throw this.#wrapError(err, model ?? 'batch');
    }
  }

  /**
   * Reads the current state of a batch job.
   *
   * The SDK runs no timers and never polls on its own: the application owns the
   * `jobId` and decides how often to ask.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async getBatch(jobId: string): Promise<BatchJob> {
    try {
      return this.#toBatchJob(await this.#client.batches.get({ name: jobId }));
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  /**
   * Streams the results of a finished batch, one item at a time.
   *
   * The result file is downloaded to a temporary path and read line by line, so
   * a job covering tens of thousands of documents never has to be materialised
   * in memory. Each line carries its originating `key`, so results correlate by
   * id rather than by position.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async *streamBatchResults(jobId: string): AsyncIterable<BatchResultItem> {
    let job: GeminiBatchJobResource;
    try {
      job = await this.#client.batches.get({ name: jobId });
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }

    const fileName = job.dest?.fileName;
    if (fileName === undefined || fileName === '') return;

    const dir = await mkdtemp(join(tmpdir(), 'agent349-batch-'));
    const path = join(dir, 'results.jsonl');
    try {
      await this.#client.files.download({ file: fileName, downloadPath: path });
      const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of reader) {
        if (line.trim() === '') continue;
        const item = this.#toBatchResult(line);
        if (item !== undefined) yield item;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Requests cancellation of a batch that has not finished.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async cancelBatch(jobId: string): Promise<void> {
    try {
      await this.#client.batches.cancel({ name: jobId });
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: Gemini → SDK
  // ─────────────────────────────────────────────────────────────────────────

  /** Builds a per-request content resolver bound to this provider. */
  #createResolver(model: string): ContentResolver {
    return new ContentResolver({
      provider: this.name,
      providerType: this.providerType,
      capabilities: this.capabilities(model),
      model,
      inlineLimitBytes: INLINE_LIMIT_BYTES,
      upload: (input) => this.uploadFile(input),
    });
  }

  /** Converts an Interactions response to the normalised {@link LLMResponse}. */
  #fromInteraction(
    interaction: InteractionResponse,
    request: LLMRequest,
    resolver: ContentResolver | undefined,
    latencyMs: number,
  ): LLMResponse {
    if (interaction.error !== undefined) {
      throw new ProviderError(
        this.name,
        interaction.error.message ?? 'interaction failed',
        request.model,
      );
    }

    const { content, toolCalls, contentBlocks } = GeminiProvider.#readSteps(
      interaction.steps ?? [],
    );
    const usage = this.#normaliseInteractionUsage(
      interaction.usage,
      interaction.model ?? request.model,
      'sync',
    );

    const structured = buildStructuredOutput(
      content,
      request.responseFormat,
      GeminiProvider.#structuredMode(request),
    );
    const uploadedFiles = resolver?.uploadedFiles;

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason:
        toolCalls.length > 0
          ? 'tool_use'
          : interaction.status === 'incomplete'
            ? 'max_tokens'
            : 'end',
      usage: usage.usage,
      model: interaction.model ?? request.model,
      provider: this.name,
      providerType: this.providerType,
      executionMode: 'sync',
      latencyMs,
      ...(usage.performance !== undefined && { performance: usage.performance }),
      ...(structured !== undefined && { structured }),
      ...(uploadedFiles !== undefined && uploadedFiles.length > 0 && { uploadedFiles }),
      ...(request.includeRaw === true && { providerRaw: interaction }),
      ...(contentBlocks.length > 0 && { contentBlocks }),
    };
  }

  /**
   * Reads an interaction's steps into text, tool calls and round-trippable
   * blocks.
   *
   * A `thought` step's signature is attached to the block that follows it: the
   * model requires those signatures back on the next stateless turn, and
   * carrying them as opaque `providerData` keeps a Gemini-specific mechanism out
   * of the shared content contract.
   */
  static #readSteps(steps: InteractionBlock[]): {
    content: string;
    toolCalls: ToolCall[];
    contentBlocks: ContentBlock[];
  } {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const contentBlocks: ContentBlock[] = [];
    let pendingSignature: string | undefined;

    for (const step of steps) {
      if (step.type === 'thought') {
        pendingSignature = step.signature;
        continue;
      }

      const providerData =
        pendingSignature !== undefined ? { [THOUGHT_SIGNATURE_KEY]: pendingSignature } : undefined;

      if (step.type === 'model_output') {
        const text = (step.content ?? [])
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');
        textParts.push(text);
        contentBlocks.push({
          type: 'text',
          text,
          ...(providerData !== undefined && { providerData }),
        });
        pendingSignature = undefined;
        continue;
      }

      if (step.type === 'function_call') {
        toolCalls.push({ id: step.id, toolName: step.name, input: step.arguments });
        contentBlocks.push({
          type: 'tool_use',
          toolUseId: step.id,
          toolName: step.name,
          input: step.arguments,
          ...(providerData !== undefined && { providerData }),
        });
        pendingSignature = undefined;
      }
    }

    // A trailing thought with no following step still has to be replayed.
    if (pendingSignature !== undefined) {
      contentBlocks.push({
        type: 'text',
        text: '',
        providerData: { [THOUGHT_SIGNATURE_KEY]: pendingSignature },
      });
    }

    return { content: textParts.join(''), toolCalls, contentBlocks };
  }

  /**
   * Consumes a streamed interaction, forwarding text deltas as they arrive and
   * reconstructing the final interaction.
   *
   * Thought-signature deltas are accumulated but never emitted as tokens: they
   * are provider state, not model output.
   */
  static async #consumeStream(
    stream: AsyncIterable<InteractionStreamEvent>,
    onToken: (delta: string) => void,
  ): Promise<InteractionResponse> {
    const result: InteractionResponse = { steps: [] };
    const stepsByIndex = new Map<number, InteractionBlock>();

    for await (const event of stream) {
      if (event.interaction !== undefined) {
        if (result.id === undefined && event.interaction.id !== undefined) {
          result.id = event.interaction.id;
        }
        if (result.model === undefined && event.interaction.model !== undefined) {
          result.model = event.interaction.model;
        }
        if (event.interaction.status !== undefined) result.status = event.interaction.status;
        if (event.interaction.usage !== undefined) result.usage = event.interaction.usage;
        if (event.interaction.error !== undefined) result.error = event.interaction.error;
      }
      if (event.usage !== undefined) result.usage = event.usage;

      const index = event.index;
      if (index === undefined) continue;

      if (event.event_type === 'step.start' && event.step?.type !== undefined) {
        stepsByIndex.set(index, GeminiProvider.#emptyStep(event.step.type));
        continue;
      }

      if (event.event_type === 'step.delta' && event.delta !== undefined) {
        const step = stepsByIndex.get(index);
        if (step === undefined) continue;

        if (event.delta.type === 'text' && typeof event.delta.text === 'string') {
          if (step.type === 'model_output') {
            const first = step.content?.[0];
            if (first !== undefined && first.type === 'text') {
              first.text += event.delta.text;
            } else {
              step.content = [{ type: 'text', text: event.delta.text }];
            }
          }
          onToken(event.delta.text);
        } else if (
          event.delta.type === 'thought_signature' &&
          typeof event.delta.signature === 'string' &&
          step.type === 'thought'
        ) {
          step.signature = event.delta.signature;
        }
      }
    }

    result.steps = [...stepsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, step]) => step);
    return result;
  }

  /** Creates an empty accumulator for a streamed step of the given type. */
  static #emptyStep(type: string): InteractionBlock {
    if (type === 'thought') return { type: 'thought' };
    if (type === 'function_call') {
      return { type: 'function_call', id: randomUUID(), name: '', arguments: {} };
    }
    return { type: 'model_output', content: [] };
  }

  /** Whether the provider was asked to enforce a schema, plain JSON, or nothing. */
  static #structuredMode(request: LLMRequest): 'native_schema' | 'native_json' | 'none' {
    if (request.responseFormat === undefined) return 'none';
    return request.responseFormat.type === 'json_schema' ? 'native_schema' : 'native_json';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Usage & pricing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Normalises Interactions usage.
   *
   * Thinking tokens are folded into `outputTokens` because Google bills them as
   * output — the same convention OpenAI already applies to its reasoning
   * tokens — so cost comparisons across providers stay meaningful. They remain
   * separately visible in `performance.reasoningTokens`.
   */
  #normaliseInteractionUsage(
    usage: InteractionUsage | undefined,
    model: string,
    executionMode: ExecutionMode,
  ): { usage: LLMResponse['usage']; performance?: LLMResponse['performance'] } {
    const inputTokens = usage?.total_input_tokens ?? 0;
    const visibleOutput = usage?.total_output_tokens ?? 0;
    const thinking = usage?.total_thought_tokens ?? 0;
    const cached = usage?.total_cached_tokens;
    const outputTokens = visibleOutput + thinking;
    const cost = this.#estimateCost(model, inputTokens, outputTokens, executionMode);

    const performance =
      thinking > 0 || (cached !== undefined && cached > 0)
        ? {
            visibleOutputTokens: visibleOutput,
            ...(thinking > 0 && { reasoningTokens: thinking }),
            ...(cached !== undefined && cached > 0 && { cachedInputTokens: cached }),
          }
        : undefined;

    return {
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cost !== undefined && { cost }),
        ...(usage?.input_tokens_by_modality !== undefined && {
          inputByModality: usage.input_tokens_by_modality as ModalityUsage[],
        }),
        ...(usage?.output_tokens_by_modality !== undefined && {
          outputByModality: usage.output_tokens_by_modality as ModalityUsage[],
        }),
      },
      ...(performance !== undefined && { performance }),
    };
  }

  /** Normalises `generateContent` usage (batch results) the same way. */
  #normaliseGenerateContentUsage(
    usage: GenerateContentUsage | undefined,
    model: string,
  ): { usage: LLMResponse['usage']; performance?: LLMResponse['performance'] } {
    const inputTokens = usage?.promptTokenCount ?? 0;
    const visibleOutput = usage?.candidatesTokenCount ?? 0;
    const thinking = usage?.thoughtsTokenCount ?? 0;
    const cached = usage?.cachedContentTokenCount;
    const outputTokens = visibleOutput + thinking;
    const cost = this.#estimateCost(model, inputTokens, outputTokens, 'batch');

    const toModality = (
      details: Array<{ modality?: string; tokenCount?: number }> | undefined,
    ): ModalityUsage[] | undefined =>
      details?.map((d) => ({ modality: d.modality ?? 'unknown', tokens: d.tokenCount ?? 0 }));

    const inputByModality = toModality(usage?.promptTokensDetails);
    const outputByModality = toModality(usage?.candidatesTokensDetails);

    const performance =
      thinking > 0 || (cached !== undefined && cached > 0)
        ? {
            visibleOutputTokens: visibleOutput,
            ...(thinking > 0 && { reasoningTokens: thinking }),
            ...(cached !== undefined && cached > 0 && { cachedInputTokens: cached }),
          }
        : undefined;

    return {
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cost !== undefined && { cost }),
        ...(inputByModality !== undefined && { inputByModality }),
        ...(outputByModality !== undefined && { outputByModality }),
      },
      ...(performance !== undefined && { performance }),
    };
  }

  /**
   * Estimates cost in USD, using the model's batch rates when the work ran in a
   * batch job. A model with no declared batch rate bills at its synchronous
   * one: the SDK never assumes a blanket discount.
   */
  #estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    executionMode: ExecutionMode,
  ): number | undefined {
    const pricing = this.#pricing[model] ?? longestPrefixMatch(this.#pricing, model);
    if (pricing === undefined) return undefined;

    const inputRate =
      executionMode === 'batch' ? (pricing.batchInput ?? pricing.input) : pricing.input;
    const outputRate =
      executionMode === 'batch' ? (pricing.batchOutput ?? pricing.output) : pricing.output;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Builds a provider file reference from a Files API resource. */
  #toFileRef(file: GeminiFile, mimeType?: string, fileName?: string): ProviderFileRef {
    const size = file.sizeBytes;
    const byteLength = typeof size === 'string' ? Number.parseInt(size, 10) : size;
    const resolvedMime = file.mimeType ?? mimeType;
    const resolvedName = file.displayName ?? fileName;

    return {
      // Gemini rejects the bare `files/<id>` form as a content URI and requires
      // the full resource URL, so that is what the reference carries.
      fileId: file.uri ?? file.name ?? '',
      provider: this.name,
      providerType: this.providerType,
      ...(resolvedMime !== undefined && { mimeType: resolvedMime }),
      ...(resolvedName !== undefined && { fileName: resolvedName }),
      ...(byteLength !== undefined && !Number.isNaN(byteLength) && { byteLength }),
      ...(file.expirationTime !== undefined && { expiresAt: new Date(file.expirationTime) }),
    };
  }

  /** Extracts the `files/<id>` resource name from a reference id or URI. */
  static #toFileName(fileId: string): string {
    const match = /files\/[^/?#]+/.exec(fileId);
    return match?.[0] ?? fileId;
  }

  /** Maps a Gemini batch resource onto the normalised {@link BatchJob}. */
  #toBatchJob(job: GeminiBatchJobResource, model?: string): BatchJob {
    return {
      jobId: job.name ?? '',
      provider: this.name,
      providerType: this.providerType,
      ...(job.model !== undefined ? { model: job.model } : model !== undefined ? { model } : {}),
      status: GeminiProvider.#mapJobState(job.state),
      createdAt: job.createTime !== undefined ? new Date(job.createTime) : new Date(),
      ...(job.updateTime !== undefined && { updatedAt: new Date(job.updateTime) }),
      ...(job.error?.message !== undefined && { error: job.error.message }),
    };
  }

  /** Normalises Gemini's `JOB_STATE_*` vocabulary. */
  static #mapJobState(state: string | undefined): BatchJob['status'] {
    switch (state) {
      case 'JOB_STATE_PENDING':
      case 'JOB_STATE_QUEUED':
        return 'queued';
      case 'JOB_STATE_SUCCEEDED':
        return 'completed';
      case 'JOB_STATE_FAILED':
        return 'failed';
      case 'JOB_STATE_CANCELLED':
      case 'JOB_STATE_CANCELLING':
        return 'cancelled';
      case 'JOB_STATE_EXPIRED':
        return 'expired';
      default:
        return 'running';
    }
  }

  /** Parses one JSONL result line into a normalised {@link BatchResultItem}. */
  #toBatchResult(line: string): BatchResultItem | undefined {
    let parsed: {
      key?: string;
      response?: GenerateContentResponseBody;
      error?: { message?: string; code?: string | number };
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return undefined;
    }
    if (parsed.key === undefined) return undefined;

    if (parsed.error !== undefined || parsed.response === undefined) {
      return {
        customId: parsed.key,
        error: {
          message: parsed.error?.message ?? 'request produced no response',
          ...(parsed.error?.code !== undefined && { code: String(parsed.error.code) }),
        },
      };
    }

    return { customId: parsed.key, response: this.#fromGenerateContent(parsed.response) };
  }

  /** Converts a `generateContent` response (batch result) to an {@link LLMResponse}. */
  #fromGenerateContent(raw: GenerateContentResponseBody): LLMResponse {
    const parts = raw.candidates?.[0]?.content?.parts ?? [];
    const content = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text!)
      .join('');

    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall !== undefined)
      .map((p) => ({
        id: p.functionCall!.id ?? randomUUID(),
        toolName: p.functionCall!.name,
        input: p.functionCall!.args,
      }));

    const model = raw.modelVersion ?? '';
    const usage = this.#normaliseGenerateContentUsage(raw.usageMetadata, model);
    const finish = raw.candidates?.[0]?.finishReason;

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason:
        toolCalls.length > 0 ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end',
      usage: usage.usage,
      model,
      provider: this.name,
      providerType: this.providerType,
      executionMode: 'batch',
      latencyMs: 0,
      ...(usage.performance !== undefined && { performance: usage.performance }),
    };
  }

  /**
   * Wraps an API failure into a {@link ProviderError}.
   *
   * Detects the SDK's errors by the presence of a numeric `status`, avoiding a
   * runtime coupling to its private class hierarchy.
   */
  #wrapError(err: unknown, model: string): unknown {
    if (err instanceof UnsupportedCapabilityError || err instanceof ProviderError) return err;
    if (err instanceof Error) {
      const status = (err as Error & { status?: unknown }).status;
      return new ProviderError(
        this.name,
        err.message,
        model,
        typeof status === 'number' ? status : undefined,
        { cause: err },
      );
    }
    return err;
  }
}
