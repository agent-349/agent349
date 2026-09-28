import Anthropic, { toFile } from '@anthropic-ai/sdk';
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

/**
 * Pricing rates per 1 000 tokens in USD.
 * `input` is the rate for prompt tokens; `output` for completion tokens.
 */
export interface ClaudeModelPricing {
  /** USD per 1 000 input (prompt) tokens. */
  input: number;
  /** USD per 1 000 output (completion) tokens. */
  output: number;
  /** USD per 1 000 input tokens when the request ran in a batch job. */
  batchInput?: number;
  /** USD per 1 000 output tokens when the request ran in a batch job. */
  batchOutput?: number;
}

/**
 * Configuration accepted by {@link ClaudeProvider}.
 */
export interface ClaudeProviderConfig {
  /**
   * Instance identity used as the provider `name` (router key, and the value
   * reported in `LLMResponse.provider` / `ProviderError`). Defaults to
   * `'claude'` for backward compatibility.
   */
  name?: string;
  /** Anthropic API key. Use `${ANTHROPIC_API_KEY}` in JSON config. */
  apiKey: string;
  /** Default model identifier. Used when no model is specified in the request. */
  defaultModel?: string;
  /**
   * Extra HTTP headers sent on every request (e.g. gateway auth or beta flags).
   * Maps to the Anthropic SDK's `defaultHeaders`.
   */
  defaultHeaders?: Record<string, string>;
  /** Maximum number of automatic retries on transient errors. Default: 2. */
  maxRetries?: number;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /**
   * Per-model pricing table (USD / 1 000 tokens), merged on top of
   * {@link DEFAULT_PRICING} — entries here override the built-in default for
   * the same key, and any model not listed here still falls back to the
   * built-in table. Keys are model identifiers or prefixes (e.g.
   * `'claude-opus-5'`). Use this to add or correct a rate (e.g. a
   * new model release) via `config.llm.providers.claude.pricing` without
   * needing an SDK update.
   */
  pricing?: Record<string, ClaudeModelPricing>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in Claude pricing (USD / 1 000 tokens), from Anthropic's published
 * rates as of September 2026; batch rates are 50 %. Keys match by longest
 * prefix, so an alias such as `claude-haiku-4-5` also prices its dated
 * snapshot. Rates change: override them with `pricing` instead of waiting
 * for an SDK release.
 */
const DEFAULT_PRICING: Record<string, ClaudeModelPricing> = {
  'claude-fable-5-1': { input: 0.01, output: 0.05, batchInput: 0.005, batchOutput: 0.025 },
  'claude-opus-5': { input: 0.005, output: 0.025, batchInput: 0.0025, batchOutput: 0.0125 },
  'claude-sonnet-5': { input: 0.002, output: 0.01, batchInput: 0.001, batchOutput: 0.005 },
  'claude-haiku-4-5': { input: 0.001, output: 0.005, batchInput: 0.0005, batchOutput: 0.0025 },
  // Previous generation (deprecated), kept so existing deployments stay priced.
  'claude-sonnet-4-20250514': {
    input: 0.003,
    output: 0.015,
    batchInput: 0.0015,
    batchOutput: 0.0075,
  },
  'claude-opus-4-20250514': {
    input: 0.015,
    output: 0.075,
    batchInput: 0.0075,
    batchOutput: 0.0375,
  },
};

/**
 * Anthropic's documented per-request payload ceiling. Content above this must
 * travel through the Files API instead of inline — see `fileHandling`.
 */
const INLINE_LIMIT_BYTES = 32 * 1024 * 1024;

/** Media types Anthropic accepts in an `image` block. */
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Models available via the API (used by `listModels()` when the API is unreachable). */
const KNOWN_MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

/** Timing markers captured while consuming one streamed Claude message. */
interface ClaudeStreamTimings {
  /** Time from request start until the stream was opened. */
  streamOpenMs: number;
  /** Time from request start until the first visible text delta. */
  timeToFirstTokenMs?: number;
  /** Time from the first visible text delta until the stream completed. */
  generationMs?: number;
}

/** Accumulator for one streamed content block whose fields arrive across events. */
interface StreamedBlock {
  type: string;
  id?: string;
  name?: string;
  text: string;
  partialJson: string;
}

/** Reconstructed message plus its stream timing markers. */
interface ClaudeStreamResult {
  message: Anthropic.Message;
  timings: ClaudeStreamTimings;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM provider implementation for Anthropic Claude.
 *
 * Handles the bidirectional translation between the SDK's normalised
 * {@link LLMRequest}/{@link LLMResponse} types and the Anthropic Messages API:
 *
 * - **Tools**: `ToolDescriptor.inputSchema` → `input_schema` (Claude format).
 * - **Messages**: SDK `role:'tool'` → Claude `role:'user'` with `tool_result`
 *   blocks; SDK `ContentBlock[]` assistant turns → Claude `tool_use` blocks.
 * - **Responses**: Claude `content[]` → SDK `content` text + `toolCalls` array
 *   + `contentBlocks` (preserved for round-trip accuracy in multi-turn loops).
 * - **Stop reason**: `end_turn` → `'end'`; other values mapped directly.
 * - **Cost**: estimated from the configurable pricing table.
 *
 * @example
 * ```typescript
 * const claude = new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * const response = await claude.call({ model: 'claude-opus-5', ... });
 * ```
 */
export class ClaudeProvider
  extends LLMProvider
  implements FileCapableProvider, BatchCapableProvider
{
  override readonly name: string;
  override readonly providerType = 'claude';

  readonly #client: Anthropic;
  readonly #pricing: Record<string, ClaudeModelPricing>;

  /**
   * @param config - Provider configuration (API key, retries, timeout, pricing).
   * @param client - Optional pre-constructed Anthropic client. Primarily used
   *                 for testing (dependency injection) — omit in production.
   */
  constructor(config: ClaudeProviderConfig, client?: Anthropic) {
    super();
    this.name = config.name ?? 'claude';
    this.#client =
      client ??
      new Anthropic({
        apiKey: config.apiKey,
        maxRetries: config.maxRetries ?? 2,
        timeout: config.timeoutMs ?? 30_000,
        ...(config.defaultHeaders !== undefined && { defaultHeaders: config.defaultHeaders }),
      });
    // Merge (not replace): an override for one model shouldn't require
    // re-listing every other model that already has a correct built-in price.
    this.#pricing = { ...DEFAULT_PRICING, ...config.pricing };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls the Anthropic Messages API and returns a normalised {@link LLMResponse}.
   *
   * When `request.onToken` is provided the call is streamed: text deltas are
   * forwarded as they arrive (following Anthropic's `message_start` →
   * `content_block_delta` → `message_delta` event sequence) while the fully
   * assembled response is still returned when the stream completes. Tool-call
   * arguments are accumulated internally and are **not** emitted as text tokens.
   * `request.signal` cancels an in-flight request (streaming or not).
   *
   * @throws {@link ProviderError} on API errors (auth, rate-limit, server errors).
   */
  override async call(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();
    assertResponseFormatSupported(this.name, this.capabilities(request.model), request);

    const resolver = this.#createResolver(request.model);
    const baseParams = await this.#buildBaseParams(request, resolver);

    try {
      if (typeof request.onToken === 'function') {
        const { message, timings } = await this.#streamMessage(
          baseParams,
          request.onToken,
          request.signal,
          startMs,
        );
        return this.#fromClaudeResponse(message, Date.now() - startMs, request, resolver, timings);
      }

      const raw = await this.#client.messages.create(
        { ...baseParams, stream: false } as Anthropic.MessageCreateParamsNonStreaming,
        request.signal !== undefined ? { signal: request.signal } : undefined,
      );
      return this.#fromClaudeResponse(raw, Date.now() - startMs, request, resolver);
    } catch (err: unknown) {
      throw this.#wrapError(err, request.model);
    }
  }

  /**
   * Declares Claude's capabilities.
   *
   * Structured output (`output_config.format`) is generally available and can
   * be combined with tool calling; images and PDFs are accepted inline, by URL,
   * or as Files API references.
   */
  override capabilities(_model?: string): ProviderCapabilities {
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

  /**
   * Builds the shared Messages API request body (model, system, messages,
   * tools, temperature). The streaming flag is added by the caller.
   */
  async #buildBaseParams(
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<Anthropic.MessageCreateParams> {
    const options = request.providerOptions?.claude;
    const format = request.responseFormat;

    return {
      model: request.model,
      max_tokens: request.maxTokens ?? 4_096,
      system: request.systemPrompt,
      messages: await this.#toClaudeMessages(request, resolver),
      ...(request.tools &&
        request.tools.length > 0 && {
          tools: this.#toClaudeTools(request.tools),
        }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(format !== undefined && { output_config: ClaudeProvider.#toOutputConfig(format) }),
      ...(options?.stopSequences !== undefined && { stop_sequences: options.stopSequences }),
      ...(options?.topP !== undefined && { top_p: options.topP }),
      ...(options?.topK !== undefined && { top_k: options.topK }),
      ...(options?.thinkingBudgetTokens !== undefined && {
        thinking: { type: 'enabled', budget_tokens: options.thinkingBudgetTokens },
      }),
      // Escape hatch, merged last so it can reach parameters the SDK has not
      // modelled yet. Deliberately unvalidated.
      ...(options?.raw ?? {}),
    } as Anthropic.MessageCreateParams;
  }

  /** Maps the SDK's {@link ResponseFormat} onto Claude's `output_config`. */
  static #toOutputConfig(format: NonNullable<LLMRequest['responseFormat']>): unknown {
    if (format.type === 'json_object' || format.schema === undefined) {
      return { format: { type: 'json_object' } };
    }
    return { format: { type: 'json_schema', schema: format.schema } };
  }

  /**
   * Opens a streamed Messages request and reconstructs the final message while
   * forwarding text deltas immediately.
   *
   * Follows Anthropic's event protocol: `message_start` carries input/cache
   * usage; `content_block_start`/`content_block_delta` build text and tool_use
   * blocks (`input_json_delta` accumulates tool arguments as partial JSON);
   * `message_delta` carries the final `stop_reason` and output token count.
   */
  async #streamMessage(
    baseParams: Anthropic.MessageCreateParams,
    onToken: (delta: string) => void,
    signal: AbortSignal | undefined,
    requestStartMs: number,
  ): Promise<ClaudeStreamResult> {
    const stream = await this.#client.messages.create(
      { ...baseParams, stream: true } as Anthropic.MessageCreateParamsStreaming,
      signal !== undefined ? { signal } : undefined,
    );
    const streamOpenedAtMs = Date.now();

    let messageId = '';
    let model = typeof baseParams.model === 'string' ? baseParams.model : String(baseParams.model);
    let stopReason: Anthropic.Message['stop_reason'] = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens: number | null = null;
    let cacheReadTokens: number | null = null;
    let firstTokenAtMs: number | undefined;

    const blocks = new Map<number, StreamedBlock>();

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          messageId = event.message.id;
          model = event.message.model;
          inputTokens = event.message.usage.input_tokens;
          cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
          cacheReadTokens = event.message.usage.cache_read_input_tokens;
          break;
        }
        case 'content_block_start': {
          const cb = event.content_block;
          if (cb.type === 'text') {
            blocks.set(event.index, { type: 'text', text: cb.text, partialJson: '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(event.index, {
              type: 'tool_use',
              id: cb.id,
              name: cb.name,
              text: '',
              partialJson: '',
            });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          if (block === undefined) break;
          if (event.delta.type === 'text_delta') {
            if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
            block.text += event.delta.text;
            onToken(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            block.partialJson += event.delta.partial_json;
          }
          break;
        }
        case 'message_delta': {
          if (event.delta.stop_reason !== null) stopReason = event.delta.stop_reason;
          outputTokens = event.usage.output_tokens;
          break;
        }
        default:
          // content_block_stop / message_stop and any future event types
          // require no accumulation here.
          break;
      }
    }

    const completedAtMs = Date.now();
    const content = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => ClaudeProvider.#reconstructBlock(block));

    const message: Anthropic.Message = {
      id: messageId || `msg-stream-${String(requestStartMs)}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
      },
    } as Anthropic.Message;

    return {
      message,
      timings: {
        streamOpenMs: streamOpenedAtMs - requestStartMs,
        ...(firstTokenAtMs !== undefined && {
          timeToFirstTokenMs: firstTokenAtMs - requestStartMs,
          generationMs: completedAtMs - firstTokenAtMs,
        }),
      },
    };
  }

  /** Reconstructs a normalised Anthropic content block from a stream accumulator. */
  static #reconstructBlock(block: StreamedBlock): Anthropic.ContentBlock {
    if (block.type === 'tool_use') {
      let input: unknown = {};
      if (block.partialJson !== '') {
        try {
          input = JSON.parse(block.partialJson);
        } catch {
          input = {};
        }
      }
      return {
        type: 'tool_use',
        id: block.id ?? '',
        name: block.name ?? '',
        input,
      } as Anthropic.ContentBlock;
    }
    return { type: 'text', text: block.text, citations: null } as Anthropic.ContentBlock;
  }

  /**
   * Verifies the API key is valid by listing models.
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
   * Returns available Claude model identifiers from the Anthropic API.
   */
  override async listModels(): Promise<string[]> {
    try {
      const list = await this.#client.models.list();
      return (list as { data: Array<{ id: string }> }).data.map((m) => m.id);
    } catch {
      return [...KNOWN_MODELS];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: SDK → Claude
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts SDK {@link ToolDescriptor}s to the Claude API tool format.
   *
   * Claude uses `input_schema` (snake_case) where the SDK uses `inputSchema`.
   */
  #toClaudeTools(tools: ToolDescriptor[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Cast: JSONSchema (Record<string,unknown>) is structurally compatible.
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * Converts SDK {@link LLMMessage}s to the Claude API message format.
   *
   * Role mapping:
   * - `'user'` / `'assistant'` with string content → a single text block.
   * - `'user'` with `ContentBlock[]` → text, `image` and `document` blocks,
   *   each resolved to the transport Claude accepts (inline base64, URL, or a
   *   Files API `file_id`).
   * - `'assistant'` with `ContentBlock[]` → reconstructs `tool_use` blocks
   *   (needed for round-trip accuracy after a tool-calling turn).
   * - `'tool'` → grouped into a single `role:'user'` message with
   *   `tool_result` blocks (Claude requires a single user turn per LLM turn).
   *
   * Media that was dropped when the conversation was persisted arrives as a
   * `media_omitted` block and is rendered as an explicit note, so a restored
   * session never loses a document without the model being told.
   */
  async #toClaudeMessages(
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<Anthropic.MessageParam[]> {
    const messages = request.messages;
    const result: Anthropic.MessageParam[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i]!;

      // ── tool results → Claude user turn with tool_result blocks ─────────
      if (msg.role === 'tool') {
        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

        while (i < messages.length && messages[i]!.role === 'tool') {
          const toolMsg = messages[i]!;
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolMsg.toolCallId!,
            content:
              typeof toolMsg.content === 'string'
                ? toolMsg.content
                : JSON.stringify(toolMsg.content),
          });
          i++;
        }

        result.push({ role: 'user', content: toolResultBlocks });
        continue;
      }

      // ── assistant turn with content blocks (from a prior tool-call round) ─
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const blocks: Anthropic.ContentBlockParam[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            // A block preserved verbatim from a previous response (thinking,
            // redacted_thinking, …) is replayed as-is: Claude needs those back
            // intact, and it rejects empty text blocks, which is what a naive
            // round-trip of an unrecognised block would produce.
            const preserved = block.providerData;
            if (preserved !== undefined) {
              blocks.push(preserved as unknown as Anthropic.ContentBlockParam);
            } else if (block.text !== '') {
              blocks.push({ type: 'text', text: block.text });
            }
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: block.toolUseId,
              name: block.toolName,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              input: (block.input ?? {}) as Record<string, any>,
            });
          }
        }

        result.push({ role: 'assistant', content: blocks });
        i++;
        continue;
      }

      // ── user turn with structured content (text + media) ─────────────────
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        result.push({
          role: 'user',
          content: await this.#toUserBlocks(msg.content, request, resolver),
        });
        i++;
        continue;
      }

      // ── standard user / assistant string messages ────────────────────────
      if (msg.role === 'user' || msg.role === 'assistant') {
        result.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : '',
        });
      }
      // 'system' role is handled via the top-level `system` parameter — skip.

      i++;
    }

    return result;
  }

  /** Translates one user turn's blocks into Claude content blocks. */
  async #toUserBlocks(
    blocks: ContentBlock[],
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<Anthropic.ContentBlockParam[]> {
    const out: Anthropic.ContentBlockParam[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        out.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'media_omitted') {
        out.push({ type: 'text', text: describeOmitted(block) });
        continue;
      }
      if (block.type === 'tool_result') {
        out.push({ type: 'tool_result', tool_use_id: block.toolUseId, content: block.content });
        continue;
      }
      if (!isMediaBlock(block)) continue;

      const resolved = await resolver.resolve(block, request.fileHandling ?? 'inline');
      out.push(this.#toMediaBlockParam(block, resolved, request.model));
    }

    return out;
  }

  /** Builds an `image` or `document` block from resolved content. */
  #toMediaBlockParam(
    block: MediaBlock,
    resolved: ResolvedContent,
    model: string,
  ): Anthropic.ContentBlockParam {
    const source =
      resolved.kind === 'inline'
        ? { type: 'base64', media_type: resolved.mimeType, data: resolved.base64 }
        : resolved.kind === 'url'
          ? { type: 'url', url: resolved.url }
          : { type: 'file', file_id: resolved.ref.fileId };

    if (block.type === 'image') {
      if (resolved.kind === 'inline' && !CLAUDE_IMAGE_TYPES.has(resolved.mimeType)) {
        throw new UnsupportedCapabilityError(
          this.name,
          'input.image',
          `image type '${resolved.mimeType}' is not accepted. Supported types: ` +
            `${[...CLAUDE_IMAGE_TYPES].join(', ')}.`,
          model,
        );
      }
      return { type: 'image', source } as Anthropic.ImageBlockParam;
    }

    if (block.type === 'document') {
      return { type: 'document', source } as Anthropic.DocumentBlockParam;
    }

    throw new UnsupportedCapabilityError(
      this.name,
      `input.${block.type}`,
      'Claude accepts image and document input only',
      model,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: Claude → SDK
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts a raw Anthropic {@link Anthropic.Message} to the SDK's
   * normalised {@link LLMResponse}.
   */
  #fromClaudeResponse(
    raw: Anthropic.Message,
    latencyMs: number,
    request: LLMRequest,
    resolver: ContentResolver | undefined,
    timings?: ClaudeStreamTimings,
    executionMode: ExecutionMode = 'sync',
  ): LLMResponse {
    // ── Text content ────────────────────────────────────────────────────────
    const textParts = raw.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text);
    const content = textParts.join('');

    // ── Tool calls ──────────────────────────────────────────────────────────
    const toolUseBlocks = raw.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const toolCalls: ToolCall[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((b) => ({
            id: b.id,
            toolName: b.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input: b.input as any,
          }))
        : undefined;

    // ── Content blocks for round-trip preservation ──────────────────────────
    // Stored by AgentLoop into the message history so that the next call
    // can reconstruct the tool_use → tool_result correlation.
    const contentBlocks: ContentBlock[] = raw.content.map((b) => {
      if (b.type === 'text') {
        return { type: 'text' as const, text: b.text };
      }
      if (b.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          toolUseId: b.id,
          toolName: b.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: b.input as any,
        };
      }
      // Any other block type (thinking, redacted_thinking, …) is preserved as
      // text carrying the provider's own payload, so nothing is lost silently.
      return {
        type: 'text' as const,
        text: '',
        providerData: b as unknown as Record<string, unknown>,
      };
    });

    // ── Usage & cost ────────────────────────────────────────────────────────
    const inputTokens = raw.usage.input_tokens;
    const outputTokens = raw.usage.output_tokens;
    const cost = this.#estimateCost(raw.model, inputTokens, outputTokens, executionMode);

    // Prompt tokens served from Anthropic's prompt cache. Mapped to the common
    // `performance.cachedInputTokens` (equivalent to OpenAI's cached-tokens).
    // `cache_creation_input_tokens` has no field in the common contract and is
    // intentionally not surfaced here.
    const cacheReadTokens =
      raw.usage.cache_read_input_tokens !== null && raw.usage.cache_read_input_tokens !== undefined
        ? raw.usage.cache_read_input_tokens
        : undefined;

    const generationMs = timings?.generationMs;
    const visibleTokensPerSecond =
      generationMs !== undefined && generationMs > 0
        ? outputTokens / (generationMs / 1_000)
        : undefined;

    const performance =
      timings !== undefined || cacheReadTokens !== undefined
        ? {
            ...(timings ?? {}),
            visibleOutputTokens: outputTokens,
            ...(visibleTokensPerSecond !== undefined && { visibleTokensPerSecond }),
            ...(cacheReadTokens !== undefined && { cachedInputTokens: cacheReadTokens }),
          }
        : undefined;

    // ── Structured output & uploaded files ──────────────────────────────────
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
      ...(toolCalls !== undefined && { toolCalls }),
      stopReason: this.#mapStopReason(raw.stop_reason),
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
      ...(performance !== undefined && { performance }),
      ...(structured !== undefined && { structured }),
      ...(uploadedFiles !== undefined && uploadedFiles.length > 0 && { uploadedFiles }),
      ...(request.includeRaw === true && { providerRaw: raw }),
      ...(contentBlocks.length > 0 && { contentBlocks }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Files API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Uploads a file to Anthropic's file store.
   *
   * Anthropic keeps uploaded files until they are deleted, so the returned
   * reference carries no expiry.
   *
   * @param input - File content plus its media type and optional name.
   * @throws {@link ProviderError} when the upload fails.
   */
  async uploadFile(input: FileUploadInput): Promise<ProviderFileRef> {
    const { bytes, fileName, mimeType } = await ClaudeProvider.#readUploadInput(input);
    try {
      const uploaded = await this.#client.beta.files.upload({
        file: await toFile(Buffer.from(bytes), fileName, { type: mimeType }),
        betas: ['files-api-2025-04-14'],
      });
      return {
        fileId: uploaded.id,
        provider: this.name,
        providerType: this.providerType,
        mimeType: uploaded.mime_type,
        fileName: uploaded.filename,
        byteLength: uploaded.size_bytes,
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
      const meta = await this.#client.beta.files.retrieveMetadata(fileId, {
        betas: ['files-api-2025-04-14'],
      });
      return {
        fileId: meta.id,
        provider: this.name,
        providerType: this.providerType,
        mimeType: meta.mime_type,
        fileName: meta.filename,
        byteLength: meta.size_bytes,
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
      await this.#client.beta.files.delete(fileId, { betas: ['files-api-2025-04-14'] });
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
  // Message Batches API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submits requests as an Anthropic Message Batch.
   *
   * Requests travel inline (Anthropic has no batch input file), so content is
   * resolved exactly as for a synchronous call: `fileHandling: 'upload'` keeps
   * the payload small for large document sets.
   *
   * @param items   - Requests, each with a stable `customId`.
   * @param options - Ignored by Anthropic except for the default model.
   * @throws {@link ProviderError} when the submission fails.
   */
  async submitBatch(items: BatchRequestItem[], options?: BatchSubmitOptions): Promise<BatchJob> {
    const requests = [];
    for (const item of items) {
      const request: LLMRequest = {
        ...item.request,
        ...(options?.model !== undefined && item.request.model === '' && { model: options.model }),
      };
      assertResponseFormatSupported(this.name, this.capabilities(request.model), request);
      const resolver = this.#createResolver(request.model);
      const params = await this.#buildBaseParams(request, resolver);
      requests.push({
        custom_id: item.customId,
        params: params as Anthropic.MessageCreateParamsNonStreaming,
      });
    }

    try {
      const batch = await this.#client.messages.batches.create({ requests });
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
      return this.#toBatchJob(await this.#client.messages.batches.retrieve(jobId));
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  /**
   * Streams the results of a finished batch, one item at a time.
   *
   * Anthropic serves results as a JSONL stream, so memory stays flat regardless
   * of how many documents the job carried.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async *streamBatchResults(jobId: string): AsyncIterable<BatchResultItem> {
    let results;
    try {
      results = await this.#client.messages.batches.results(jobId);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }

    for await (const entry of results) {
      yield this.#toBatchResult(entry);
    }
  }

  /**
   * Requests cancellation of a batch that has not finished.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  async cancelBatch(jobId: string): Promise<void> {
    try {
      await this.#client.messages.batches.cancel(jobId);
    } catch (err: unknown) {
      throw this.#wrapError(err, 'batch');
    }
  }

  /** Maps an Anthropic `MessageBatch` onto the normalised {@link BatchJob}. */
  #toBatchJob(batch: Anthropic.Messages.MessageBatch, model?: string): BatchJob {
    const counts = batch.request_counts;
    const total =
      counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired;

    // Anthropic reports only in_progress / canceling / ended at batch level;
    // individual outcomes live in request_counts.
    const status: BatchJob['status'] =
      batch.processing_status === 'ended'
        ? counts.canceled > 0 && counts.succeeded === 0 && counts.errored === 0
          ? 'cancelled'
          : 'completed'
        : batch.processing_status === 'canceling'
          ? 'cancelled'
          : counts.processing === total
            ? 'queued'
            : 'running';

    return {
      jobId: batch.id,
      provider: this.name,
      providerType: this.providerType,
      ...(model !== undefined && { model }),
      status,
      createdAt: new Date(batch.created_at),
      ...(batch.ended_at !== null && { updatedAt: new Date(batch.ended_at) }),
      expiresAt: new Date(batch.expires_at),
      counts: {
        total,
        succeeded: counts.succeeded,
        failed: counts.errored,
        cancelled: counts.canceled,
        expired: counts.expired,
      },
    };
  }

  /** Maps one JSONL result entry onto the normalised {@link BatchResultItem}. */
  #toBatchResult(entry: Anthropic.Messages.MessageBatchIndividualResponse): BatchResultItem {
    const result = entry.result;
    if (result.type === 'succeeded') {
      const request: LLMRequest = { systemPrompt: '', messages: [], model: result.message.model };
      return {
        customId: entry.custom_id,
        response: this.#fromClaudeResponse(
          result.message,
          0,
          request,
          undefined,
          undefined,
          'batch',
        ),
      };
    }
    const message =
      result.type === 'errored'
        ? (result.error.error.message ?? 'request failed')
        : result.type === 'canceled'
          ? 'request was canceled before it ran'
          : 'request expired before it ran';
    return { customId: entry.custom_id, error: { message, code: result.type } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #mapStopReason(reason: string | null): LLMResponse['stopReason'] {
    switch (reason) {
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'end_turn':
      case 'stop_sequence':
        return 'end';
      default:
        return 'end';
    }
  }

  /**
   * Estimates the cost for a call in USD.
   *
   * Tries an exact model key match first, then the **longest** matching
   * prefix for versioned identifiers (e.g. `'claude-sonnet-4-20250514-preview'`
   * → matches `'claude-sonnet-4-20250514'`). Longest-prefix, not first-match,
   * matters once two configured keys can prefix each other (e.g. a custom
   * `'claude-haiku-4'` alongside `'claude-haiku-4-5-20251001'`) — otherwise a
   * more specific model could silently price at a less specific key's rate
   * depending on object key iteration order.
   */
  #estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    executionMode: ExecutionMode = 'sync',
  ): number | undefined {
    const pricing =
      this.#pricing[model] ?? ClaudeProvider.#longestPrefixMatch(this.#pricing, model);

    if (pricing === undefined) return undefined;

    // Batch rates are per model, not a blanket multiplier: a model without
    // declared batch rates simply bills at its synchronous ones.
    const inputRate =
      executionMode === 'batch' ? (pricing.batchInput ?? pricing.input) : pricing.input;
    const outputRate =
      executionMode === 'batch' ? (pricing.batchOutput ?? pricing.output) : pricing.output;

    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000;
  }

  /** Finds the pricing entry whose key is the longest matching prefix of `model`. */
  static #longestPrefixMatch(
    pricing: Record<string, ClaudeModelPricing>,
    model: string,
  ): ClaudeModelPricing | undefined {
    let bestKey: string | undefined;
    let bestValue: ClaudeModelPricing | undefined;
    for (const [key, value] of Object.entries(pricing)) {
      if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
        bestKey = key;
        bestValue = value;
      }
    }
    return bestValue;
  }

  /**
   * Wraps any API error into a {@link ProviderError}.
   *
   * Detects Anthropic SDK errors by the presence of a numeric `status` property,
   * which avoids coupling to the SDK's private class hierarchy at runtime.
   */
  #wrapError(err: unknown, model: string): unknown {
    if (err instanceof Anthropic.APIError) {
      return new ProviderError(this.name, err.message, model, err.status ?? undefined);
    }
    return err;
  }
}
