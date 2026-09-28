import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ToolCall,
  ToolDescriptor,
  ProviderProbe,
} from '../types/index.js';
import { LLMProvider } from './LLMProvider.js';
import { ContentResolver } from './ContentResolver.js';
import { describeOmitted, isMediaBlock } from '../content/index.js';
import { assertResponseFormatSupported, buildStructuredOutput } from './structured.js';
import { ProviderError, UnsupportedCapabilityError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration accepted by {@link OllamaProvider}.
 *
 * Named `OllamaClientConfig` to distinguish it from the JSON-config-level
 * `OllamaClientConfig` exported by `ConfigLoader`.
 */
export interface OllamaClientConfig {
  /**
   * Instance identity used as the provider `name` (router key, and the value
   * reported in `LLMResponse.provider` / `ProviderError`). Defaults to
   * `'ollama'` for backward compatibility. Set a distinct name per instance
   * when running several Ollama endpoints simultaneously.
   */
  name?: string;
  /**
   * Base URL of the Ollama server.
   * @default 'http://localhost:11434'
   */
  baseUrl?: string;
  /**
   * Request timeout in milliseconds.
   * @default 60000
   */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal wire types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal fetch-compatible interface used internally. Matches `globalThis.fetch`. */
type OllamaFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}>;

interface OllamaToolCall {
  /** Tool call ID for matching with tool result messages. Optional in Ollama responses. */
  id?: string;
  /** Always `'function'` — required by the OpenAI-compatible format. */
  type?: 'function';
  function: {
    name: string;
    /** Ollama passes arguments as a plain object — not a JSON string. */
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessageOut {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Base64 image payloads. Ollama carries images out of band, per message. */
  images?: string[];
}

interface OllamaToolResultMessage {
  role: 'tool';
  content: string;
  tool_call_id?: string;
}

type OllamaWireMessage = OllamaMessageOut | OllamaToolResultMessage;

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  /** Prompt token count (may be absent on older Ollama versions). */
  prompt_eval_count?: number;
  /** Completion token count. */
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OllamaProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM provider implementation for locally-hosted Ollama models.
 *
 * Communicates with the Ollama HTTP API (`/api/chat`) without any external SDK.
 * Tool calling uses the OpenAI-compatible format that Ollama exposes:
 *
 * - **Tools**: `ToolDescriptor.inputSchema` → `function.parameters` (same as OpenAI).
 * - **Tool calls in response**: `message.tool_calls[].function.arguments` is a plain
 *   **object** (not a JSON string), unlike OpenAI which sends a JSON string.
 * - **Tool call IDs**: Ollama does not return IDs; they are generated with `randomUUID()`.
 * - **Usage**: maps `prompt_eval_count` / `eval_count` to `inputTokens` / `outputTokens`.
 *   Cost estimation is not supported (Ollama is local; no billing).
 *
 * @example
 * ```typescript
 * const ollama = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
 * const response = await ollama.call({ model: 'llama3', ... });
 * ```
 */
export class OllamaProvider extends LLMProvider {
  override readonly name: string;
  override readonly providerType = 'ollama';

  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: OllamaFetch;

  /**
   * @param config   - Provider configuration.
   * @param _fetch   - Optional fetch implementation; defaults to `globalThis.fetch`.
   *                   Primarily used for testing — omit in production.
   */
  constructor(
    config: OllamaClientConfig = {},
    _fetch: OllamaFetch = globalThis.fetch as unknown as OllamaFetch,
  ) {
    super();
    this.name = config.name ?? 'ollama';
    this.#baseUrl = (config.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.#timeoutMs = config.timeoutMs ?? 60_000;
    this.#fetch = _fetch;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calls the Ollama `/api/chat` endpoint and returns a normalised
   * {@link LLMResponse}.
   *
   * @throws {@link ProviderError} on connection errors or non-OK HTTP responses.
   */
  override async call(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();
    assertResponseFormatSupported(this.name, this.capabilities(request.model), request);
    const resolver = this.#createResolver(request.model);

    const tools =
      request.tools && request.tools.length > 0 ? this.#toOllamaTools(request.tools) : undefined;

    // Stream only when the caller asked for token deltas via onToken.
    const streaming = typeof request.onToken === 'function';

    const options = request.providerOptions?.ollama;
    const modelOptions = {
      ...(request.maxTokens !== undefined && { num_predict: request.maxTokens }),
      ...options?.modelOptions,
    };

    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        ...(await this.#toOllamaMessages(request, resolver)),
      ],
      stream: streaming,
      ...(tools !== undefined && { tools }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(Object.keys(modelOptions).length > 0 && { options: modelOptions }),
      ...(request.responseFormat !== undefined && {
        // Ollama takes either the literal 'json' or a JSON Schema in `format`.
        format:
          request.responseFormat.type === 'json_schema' &&
          request.responseFormat.schema !== undefined
            ? request.responseFormat.schema
            : 'json',
      }),
      ...(options?.keepAlive !== undefined && { keep_alive: options.keepAlive }),
      // Escape hatch, merged last. Deliberately unvalidated.
      ...(options?.raw ?? {}),
    };

    let raw: OllamaChatResponse;
    try {
      raw = streaming
        ? await this.#postStream('/api/chat', body, request.onToken!, request.signal)
        : ((await this.#post('/api/chat', body, request.signal)) as OllamaChatResponse);
    } catch (err) {
      throw new ProviderError(
        this.name,
        err instanceof Error ? err.message : 'Unknown error',
        request.model,
      );
    }

    return this.#fromOllamaResponse(raw, Date.now() - startMs, request);
  }

  /**
   * Checks that the Ollama server is reachable by calling `/api/tags`.
   * Reports the failure reason instead of throwing.
   */
  /**
   * Declares Ollama's capabilities.
   *
   * Vision models accept images, but Ollama has no document understanding, no
   * file store and no batch API. Structured output support (`format`) depends
   * on the server version, so it is declared as JSON-schema capable but *not*
   * combinable with tools — Ollama's behaviour there varies by model and a
   * silent mismatch would be worse than an explicit error.
   */
  override capabilities(_model?: string): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      input: { text: true, image: true, document: false, audio: false, video: false },
      sources: { url: false, providerFile: false },
      structuredOutput: 'jsonSchema',
      structuredOutputWithTools: false,
      files: false,
      batch: false,
    };
  }

  /** Builds a per-request content resolver bound to this provider. */
  #createResolver(model: string): ContentResolver {
    return new ContentResolver({
      provider: this.name,
      providerType: this.providerType,
      capabilities: this.capabilities(model),
      model,
    });
  }

  override async validate(): Promise<ProviderProbe> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/api/tags`, {
        method: 'GET',
        headers: {},
        body: '',
      });
      return res.ok
        ? { ok: true }
        : { ok: false, error: `GET ${this.#baseUrl}/api/tags returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Returns the list of locally available model names from `/api/tags`.
   * Returns an empty array on failure.
   */
  override async listModels(): Promise<string[]> {
    try {
      const data = (await this.#get('/api/tags')) as OllamaTagsResponse;
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: SDK → Ollama
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Converts SDK {@link ToolDescriptor}s to the Ollama function-calling format.
   *
   * Ollama follows the OpenAI format: `{ type: 'function', function: { name, description, parameters } }`.
   */
  #toOllamaTools(tools: ToolDescriptor[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * Converts SDK {@link LLMMessage}s to Ollama wire messages.
   *
   * - `'system'` messages are handled via the top-level `messages[0]` — skipped here.
   * - `'tool'` messages → `{ role: 'tool', content, tool_call_id }`.
   * - `'assistant'` with `ContentBlock[]` → reconstructs `tool_calls[]`.
   *   Ollama's `arguments` field is a **plain object** (not a JSON string).
   * - Unlike Claude, Ollama keeps each tool result as its own message (no grouping).
   */
  async #toOllamaMessages(
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<OllamaWireMessage[]> {
    const result: OllamaWireMessage[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.toolCallId,
        });
        continue;
      }

      if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const blocks = msg.content;
          const textContent = blocks
            .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
            .map((b) => b.text)
            .join('');
          const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');

          result.push({
            role: 'assistant',
            content: textContent,
            ...(toolUseBlocks.length > 0 && {
              tool_calls: toolUseBlocks.map((b) => ({
                // Include id so Ollama can match with subsequent tool result messages.
                id: b.toolUseId,
                type: 'function' as const,
                function: {
                  name: b.toolName,
                  // Ollama expects arguments as a plain object.
                  arguments: (b.input ?? {}) as Record<string, unknown>,
                },
              })),
            }),
          });
        } else {
          result.push({ role: 'assistant', content: msg.content ?? '' });
        }
        continue;
      }

      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          result.push(await this.#toUserMessage(msg.content, request, resolver));
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      }
    }

    return result;
  }

  /**
   * Builds one Ollama user message from content blocks.
   *
   * Ollama carries images out of band, in a per-message `images` array of
   * base64 payloads, rather than as content parts.
   */
  async #toUserMessage(
    blocks: ContentBlock[],
    request: LLMRequest,
    resolver: ContentResolver,
  ): Promise<OllamaWireMessage> {
    const textParts: string[] = [];
    const images: string[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
        continue;
      }
      if (block.type === 'media_omitted') {
        textParts.push(describeOmitted(block));
        continue;
      }
      if (!isMediaBlock(block)) continue;

      const resolved = await resolver.resolve(block, request.fileHandling ?? 'inline');
      if (resolved.kind !== 'inline') {
        throw new UnsupportedCapabilityError(
          this.name,
          'sources',
          'Ollama only accepts inline image content',
          request.model,
        );
      }
      images.push(resolved.base64);
    }

    return {
      role: 'user',
      content: textParts.join('\n'),
      ...(images.length > 0 && { images }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation: Ollama → SDK
  // ─────────────────────────────────────────────────────────────────────────

  /** Converts an Ollama chat response to the SDK's normalised `LLMResponse`. */
  #fromOllamaResponse(
    raw: OllamaChatResponse,
    latencyMs: number,
    request: LLMRequest,
  ): LLMResponse {
    const msg = raw.message;
    const content = msg.content ?? '';

    // ── Tool calls ────────────────────────────────────────────────────────
    // Ollama does not supply IDs; generate stable UUIDs for round-trip.
    // Arguments are plain objects (not JSON strings).
    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: randomUUID(),
      toolName: tc.function.name,
      input: tc.function.arguments,
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

    // ── Stop reason ───────────────────────────────────────────────────────
    // Ollama reports "stop" even when tool_calls are present in some versions.
    // Detect tool calls from the message itself rather than relying on done_reason.
    const stopReason = this.#mapStopReason(raw.done_reason, toolCalls);

    // ── Usage ─────────────────────────────────────────────────────────────
    const inputTokens = raw.prompt_eval_count ?? 0;
    const outputTokens = raw.eval_count ?? 0;

    const structured = buildStructuredOutput(
      content,
      request.responseFormat,
      request.responseFormat === undefined
        ? 'none'
        : request.responseFormat.type === 'json_schema'
          ? 'native_schema'
          : 'native_json',
    );

    return {
      content,
      ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        // No cost estimation for local models.
      },
      model: raw.model,
      provider: this.name,
      providerType: this.providerType,
      executionMode: 'sync',
      latencyMs,
      ...(structured !== undefined && { structured }),
      ...(request.includeRaw === true && { providerRaw: raw }),
      ...(contentBlocks.length > 0 && { contentBlocks }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #mapStopReason(
    doneReason: string | undefined,
    toolCalls: ToolCall[] | undefined,
  ): LLMResponse['stopReason'] {
    // Prioritise actual content: if there are tool calls, it's tool_use regardless
    // of what done_reason says (Ollama sometimes reports "stop" with tool calls).
    if (toolCalls && toolCalls.length > 0) return 'tool_use';
    switch (doneReason) {
      case 'length':
        return 'max_tokens';
      case 'stop':
      default:
        return 'end';
    }
  }

  async #post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = this.#timeoutMs;
    const fetchPromise = this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Ollama API responded with HTTP ${res.status}`);
      }
      return res.json();
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Ollama request timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  /**
   * POSTs to Ollama with `stream:true` and consumes the NDJSON response,
   * invoking `onToken` for each assistant text delta. Tool-call deltas are
   * accumulated but NOT forwarded as tokens. Returns a synthesised
   * {@link OllamaChatResponse} identical in shape to the non-streaming path, so
   * the rest of the pipeline is unaffected.
   *
   * The inactivity timeout resets on every received chunk (a long generation is
   * not a stalled request), so `timeoutMs` bounds the gap between tokens.
   */
  async #postStream(
    path: string,
    body: Record<string, unknown>,
    onToken: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<OllamaChatResponse> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    });
    if (!res.ok) {
      throw new Error(`Ollama API responded with HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new Error('Ollama streaming response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let model = (body.model as string) ?? '';
    let content = '';
    let toolCalls: OllamaToolCall[] | undefined;
    let doneReason: string | undefined;
    let promptEval: number | undefined;
    let evalCount: number | undefined;
    let buffer = '';

    // Per-chunk inactivity timeout: rejects if no data arrives within timeoutMs.
    const readChunk = (): ReturnType<typeof reader.read> => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Ollama stream stalled after ${this.#timeoutMs} ms`)),
          this.#timeoutMs,
        );
      });
      return Promise.race([reader.read(), timeoutPromise]);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let obj: OllamaChatResponse;
      try {
        obj = JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        return; // ignore malformed partial line (should not happen with NDJSON)
      }
      if (obj.model) model = obj.model;
      const msg = obj.message;
      if (msg) {
        if (msg.content) {
          content += msg.content;
          onToken(msg.content);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          toolCalls = [...(toolCalls ?? []), ...msg.tool_calls];
        }
      }
      if (obj.done_reason) doneReason = obj.done_reason;
      if (obj.prompt_eval_count !== undefined) promptEval = obj.prompt_eval_count;
      if (obj.eval_count !== undefined) evalCount = obj.eval_count;
    };

    try {
      for (;;) {
        const { done, value } = await readChunk();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer.length > 0) handleLine(buffer);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    return {
      model,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls !== undefined && { tool_calls: toolCalls }),
      },
      done: true,
      ...(doneReason !== undefined && { done_reason: doneReason }),
      ...(promptEval !== undefined && { prompt_eval_count: promptEval }),
      ...(evalCount !== undefined && { eval_count: evalCount }),
    };
  }

  async #get(path: string): Promise<unknown> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: {},
      body: '',
    });
    if (!res.ok) {
      throw new Error(`Ollama API responded with HTTP ${res.status}`);
    }
    return res.json();
  }
}
