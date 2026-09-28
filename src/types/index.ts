/**
 * Shared types and interfaces for the Agent Orchestration SDK.
 *
 * These types are the canonical contracts used across all modules.
 * No classes, no enums — only interfaces and union types.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVE / UTILITY TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A JSON Schema object used to describe tool input/output shapes.
 * Kept as a loose record to accommodate any valid JSON Schema version.
 */
export type JSONSchema = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: CONTEXT & IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Universal execution context that flows through every operation in the SDK.
 * Created once per request and passed immutably to all components.
 */
export interface ExecutionContext {
  /** Identifier of the tenant that owns this execution. */
  tenantId: string;
  /** Identifier of the end user (opaque string; managed externally). */
  userId: string;
  /** Roles assigned to the user (strings; ACL policies match against these). */
  roles: string[];
  /** Active session identifier. */
  sessionId: string;
  /** Identifier of the agent executing this request. */
  agentId: string;
  /** UUID unique per request — used for full-stack tracing and audit correlation. */
  requestId: string;
  /** Arbitrary additional data that flows with the context (e.g. department, IP). */
  metadata?: Record<string, unknown>;
}

/**
 * Enriched user profile injected into the agent at runtime.
 * Provides personalisation data that is not part of the security context.
 */
export interface UserContext {
  /** Identifier of the user. */
  userId: string;
  /** Roles assigned to the user. */
  roles: string[];
  /** Tenant the user belongs to. */
  tenantId: string;
  /** User preferences (e.g. language, response style). */
  preferences?: Record<string, unknown>;
  /** Persistent facts about the user stored in long-term memory. */
  longTermFacts?: string[];
  /** Any extra fields required by the host application. */
  customFields?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: TOOLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declarative description of a tool that the LLM uses to decide when to call it.
 */
export interface ToolDescriptor {
  /** Unique tool name, typically namespaced (e.g. 'finance.getBalance'). */
  name: string;
  /** Human-readable description sent to the LLM as part of the tool spec. */
  description: string;
  /** JSON Schema describing the expected input object. */
  inputSchema: JSONSchema;
  /** JSON Schema describing the output (optional; used for validation). */
  outputSchema?: JSONSchema;
  /** Tags used for filtering and ACL policy matching. */
  tags?: string[];
  /** When true, execution requires explicit human approval (HITL). */
  requiresApproval?: boolean;
  /**
   * When true, the tool acts outside the SDK in a way that is not undone by
   * failing — sending mail, issuing a mutating HTTP request, writing to a
   * system of record.
   *
   * Declarative only: nothing is blocked because of it. It lets the
   * {@link import('../security/UntrustedTracker.js').UntrustedTracker} report
   * an outlet running in a turn that already took in untrusted content.
   */
  sideEffects?: boolean;
  /** Per-tool execution timeout in milliseconds (overrides the global default). */
  timeout?: number;
  /** Retry policy applied on transient failures. */
  retryPolicy?: RetryPolicy;
}

/**
 * An executable tool: a {@link ToolDescriptor} paired with its implementation.
 * Register instances via `ToolRegistry.register()`.
 */
export interface Tool extends ToolDescriptor {
  /**
   * Runs the tool synchronously or asynchronously.
   *
   * @param input   - Arbitrary input object (should conform to `inputSchema`).
   * @param context - Execution context for tenant isolation, tracing, and ACL.
   * @returns A {@link ToolResult} indicating success or failure.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(input: any, context: ExecutionContext): Promise<ToolResult>;
}

/**
 * Result returned by every tool execution, successful or not.
 */
export interface ToolResult {
  /** Whether the execution completed without errors. */
  success: boolean;
  /**
   * The result payload on success.
   * Typed as `any` because tool outputs are defined by the host application.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  /** Human-readable error message when `success` is false. */
  error?: string;
  /** Runtime metrics attached to the result. */
  metadata?: {
    /** Wall-clock execution time in milliseconds. */
    durationMs: number;
    /** Tokens consumed by the tool (e.g. when the tool calls an LLM internally). */
    tokensUsed?: number;
    /** Whether the result was served from cache. */
    cached?: boolean;
  };
  /**
   * Raw retrieved passages populated by RAG tools.
   * Not serialised into LLM conversation messages — only available to event subscribers
   * and other server-side callers that need the full provenance data (e.g. document IDs).
   */
  passages?: Passage[];
  /**
   * `true` when `data` carries material from a source the integrator does not
   * control (e.g. an arbitrary web page), which may contain text aimed at the
   * model rather than at the user.
   *
   * Purely informative: the SDK never changes its behaviour because of this
   * flag. It propagates it and emits `security.untrusted.inflow`, plus
   * `security.untrusted.mutating` when a side-effecting tool runs later in the
   * same turn, so the exposure is observable. Enforcement, if wanted, is the
   * host's to build on those events.
   */
  untrusted?: boolean;
}

/**
 * A tool invocation requested by the LLM within a single agent loop iteration.
 */
export interface ToolCall {
  /** Unique identifier for this call (matches the LLM's tool_use id). */
  id: string;
  /** Name of the tool to execute. */
  toolName: string;
  /**
   * Input arguments parsed from the LLM response.
   * Typed as `any` because the shape is defined by the tool's `inputSchema`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
}

/**
 * Retry policy applied by the ToolExecutor on transient failures.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts after the first failure. Default: 2. */
  maxRetries: number;
  /** Base backoff delay in milliseconds before the first retry. Default: 1000. */
  backoffMs: number;
  /** Multiplier applied to backoff on each subsequent retry (exponential). Default: 2. */
  backoffMultiplier: number;
  /** Error message substrings that qualify for a retry (all others are fatal). */
  retryableErrors?: string[];
}

/**
 * Filter used when querying the ToolRegistry for a subset of tools.
 */
export interface ToolFilter {
  /** Return only tools with these exact names. */
  names?: string[];
  /** Return only tools that carry ALL of these tags. */
  tags?: string[];
  /** Return only tools registered under this skill. */
  skillName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: LLM CONTENT MODEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed roles in a conversation message.
 * - `system`    — instructions injected before the conversation starts
 * - `user`      — the end user's input
 * - `assistant` — the LLM's response
 * - `tool`      — the result of a tool execution fed back to the LLM
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Non-text modalities a message can carry. */
export type MediaKind = 'image' | 'document' | 'audio' | 'video';

/**
 * Reference to a file previously uploaded to a provider's file store.
 *
 * References are **provider-scoped**: an id issued by one provider is
 * meaningless to another, and several providers expire them (Gemini deletes
 * uploaded files after 48 h). Always carry `provider` alongside the id so the
 * SDK can reject a cross-provider reuse instead of failing at the wire level.
 */
export interface ProviderFileRef {
  /** Provider-issued identifier (or URI) used to reference the file. */
  fileId: string;
  /** Instance name of the provider that owns the reference. */
  provider: string;
  /** Adapter type that issued the reference (`'gemini'`, `'claude'`, …). */
  providerType: string;
  /** IANA media type of the stored file, when known. */
  mimeType?: string;
  /** Original file name, when known. */
  fileName?: string;
  /** Size of the stored file in bytes, when reported. */
  byteLength?: number;
  /** Moment the reference stops being usable, when the provider expires files. */
  expiresAt?: Date;
}

/**
 * Origin of a non-text content block.
 *
 * Each variant carries exactly the fields it needs, so invalid combinations
 * (bytes without a media type, a provider reference as a bare string) are not
 * representable. The SDK — not the calling application — decides how each
 * source reaches the wire: see {@link LLMRequest.fileHandling}.
 *
 * - `path`         — a file on disk; read (once) and typed from its extension.
 * - `bytes`        — in-memory binary content.
 * - `url`          — a URL the **provider** fetches. The SDK never downloads it.
 * - `providerFile` — a file already uploaded to that provider.
 * - `base64`       — pre-encoded content, for interop with callers that already
 *                    hold base64 (an HTTP upload, a queue payload). Not the
 *                    preferred representation.
 */
export type ContentSource =
  | { kind: 'path'; path: string; mimeType?: string; fileName?: string }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; fileName?: string }
  | { kind: 'url'; url: string; mimeType?: string; fileName?: string }
  | { kind: 'providerFile'; ref: ProviderFileRef }
  | { kind: 'base64'; data: string; mimeType: string; fileName?: string };

/** Per-block rendering hints. Providers ignore what they do not support. */
export interface MediaBlockOptions {
  /** OpenAI image `detail` level. */
  detail?: 'auto' | 'low' | 'high';
  /** Gemini media resolution for this block. */
  mediaResolution?: 'low' | 'medium' | 'high';
}

/** Plain text content. */
export interface TextBlock {
  type: 'text';
  /** Text content. */
  text: string;
  /**
   * Opaque provider state attached to this block that must be echoed back on
   * the next turn (e.g. Gemini's thought signature). Never inspected by the
   * SDK, never logged.
   */
  providerData?: Readonly<Record<string, unknown>>;
}

/** Non-text content (image, document, audio, video). */
export interface MediaBlock {
  type: MediaKind;
  /** Where the content comes from. A media block always has an origin. */
  source: ContentSource;
  /** Optional per-block provider hints. */
  options?: MediaBlockOptions;
}

/**
 * Explicit placeholder left behind when media could not be kept.
 *
 * Produced when a conversation is persisted under
 * `memory.session.mediaPersistence: 'omit'` (inline binaries are not written to
 * the session store) or when a {@link ProviderFileRef} has expired. The block
 * stays in the history — the content is never silently dropped — and providers
 * render it to the model as an explicit note.
 */
export interface MediaOmittedBlock {
  type: 'media_omitted';
  /** Modality of the content that is no longer available. */
  mediaType: MediaKind;
  /** Media type of the original content. */
  mimeType: string;
  /** Original file name, when it was known. */
  fileName?: string;
  /** Size of the original content in bytes, when it was known. */
  byteLength?: number;
  /** Why the content is gone. */
  reason: 'not_persisted' | 'expired';
}

/** A tool invocation requested by the model. */
export interface ToolUseBlock {
  type: 'tool_use';
  /** Identifier correlating this call with its result. */
  toolUseId: string;
  /** Name of the tool being invoked. */
  toolName: string;
  /**
   * Tool input payload.
   * Typed as `any` because the shape is defined by the tool's `inputSchema`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  /**
   * Opaque provider state that must be echoed back with this block on the next
   * turn (e.g. Gemini's thought signature). Never inspected by the SDK.
   */
  providerData?: Readonly<Record<string, unknown>>;
}

/** The outcome of a tool execution, fed back to the model. */
export interface ToolResultBlock {
  type: 'tool_result';
  /** Identifier of the {@link ToolUseBlock} this result answers. */
  toolUseId: string;
  /** Serialised result payload. */
  content: string;
  /** Whether the tool failed. */
  isError?: boolean;
}

/**
 * A single structured content block within a message.
 *
 * Discriminated on `type`: each variant declares exactly the fields it needs,
 * so states such as a text block with a media source, or a document block
 * without an origin, cannot be constructed.
 *
 * Build blocks with the helpers in `src/llm/content.ts` (`text()`,
 * `imageFromPath()`, `documentFromBytes()`, …) rather than by hand.
 */
export type ContentBlock =
  | TextBlock
  | MediaBlock
  | MediaOmittedBlock
  | ToolUseBlock
  | ToolResultBlock;

/** Message body: plain text or a list of structured content blocks. */
export type MessageContent = string | ContentBlock[];

/**
 * A single message in the conversation history sent to an LLM provider.
 */
export interface LLMMessage {
  /** Role of the message sender. */
  role: MessageRole;
  /** Message body — plain text or a list of structured content blocks. */
  content: MessageContent;
  /** Used for tool result messages to match the original tool_use invocation. */
  toolCallId?: string;
  /** Name of the tool (used in tool result messages). */
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: STRUCTURED OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests a structured (JSON) response from the model, using each provider's
 * native mechanism when available.
 *
 * @example
 * ```typescript
 * const request: LLMRequest = {
 *   // …
 *   responseFormat: {
 *     type: 'json_schema',
 *     name: 'invoice',
 *     schema: { type: 'object', properties: { total: { type: 'number' } } },
 *     validate: true,
 *   },
 * };
 * ```
 */
export interface ResponseFormat {
  /**
   * - `json_schema` — constrain the answer to a JSON Schema (native support
   *   required; see {@link ProviderCapabilities.structuredOutput}).
   * - `json_object` — ask for syntactically valid JSON without a schema.
   */
  type: 'json_schema' | 'json_object';
  /** Schema name. Required by OpenAI; ignored by the other providers. */
  name?: string;
  /** The JSON Schema the answer must comply with (for `json_schema`). */
  schema?: JSONSchema;
  /** Strict schema adherence, where the provider distinguishes it (OpenAI). */
  strict?: boolean;
  /**
   * Validate the parsed answer against `schema` with AJV.
   * Off by default: parsing and validating are reported separately in
   * {@link StructuredOutput} and are never conflated.
   */
  validate?: boolean;
}

/**
 * Outcome of a structured-output request, keeping three distinct facts apart:
 * what the **provider** did, whether the SDK could **parse** the answer, and
 * whether the SDK **validated** it against the schema.
 */
export interface StructuredOutput {
  /**
   * What the provider was asked to do:
   * - `native_schema` — the provider enforced the JSON Schema natively;
   * - `native_json`   — the provider enforced valid JSON without a schema;
   * - `none`          — no native mechanism was applied.
   */
  mode: 'native_schema' | 'native_json' | 'none';
  /** Whether the answer parsed as JSON. */
  parsed: boolean;
  /** The parsed value. Present only when `parsed` is `true`. */
  value?: unknown;
  /** Schema validation result. `skipped` when `validate` was not requested. */
  validation: 'skipped' | 'valid' | 'invalid';
  /** Validation error messages when `validation` is `invalid`. */
  validationErrors?: string[];
  /** Raw text as returned by the model, present when `parsed` is `false`. */
  rawText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: PROVIDER CAPABILITIES & OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a provider (optionally narrowed to one model) can actually do.
 *
 * Declared by every provider via `LLMProvider.capabilities()`. The SDK uses it
 * to fail fast with {@link UnsupportedCapabilityError} instead of silently
 * dropping content, and to avoid routing a request to a fallback provider that
 * cannot serve it.
 */
export interface ProviderCapabilities {
  /** Token streaming via `LLMRequest.onToken`. */
  streaming: boolean;
  /** Function/tool calling. */
  toolCalling: boolean;
  /** Accepted input modalities. Text is always supported. */
  input: {
    text: true;
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  /** Content sources the provider accepts directly, without conversion. */
  sources: {
    /** The provider fetches a URL itself. */
    url: boolean;
    /** The provider accepts references to its own uploaded files. */
    providerFile: boolean;
  };
  /** Native structured-output support. */
  structuredOutput: 'none' | 'jsonMode' | 'jsonSchema';
  /** Whether structured output can be combined with tool calling. */
  structuredOutputWithTools: boolean;
  /** Whether the provider implements {@link FileCapableProvider}. */
  files: boolean;
  /** Whether the provider implements {@link BatchCapableProvider}. */
  batch: boolean;
}

/** Gemini-specific request options (typed tier). */
export interface GeminiRequestOptions {
  /** Thinking budget for reasoning-capable models. */
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
  /** Default media resolution for this request's media blocks. */
  mediaResolution?: 'low' | 'medium' | 'high';
  /** Safety settings forwarded verbatim to the API. */
  safetySettings?: Array<{ category: string; threshold: string }>;
  /** Service tier for the request. */
  serviceTier?: string;
  /** User-defined labels attached to the request. */
  labels?: Record<string, string>;
  /**
   * Escape hatch: merged into the provider's native request body without
   * validation. For options the SDK does not model yet.
   */
  raw?: Record<string, unknown>;
}

/** Anthropic-specific request options (typed tier). */
export interface ClaudeRequestOptions {
  /** Stop sequences. */
  stopSequences?: string[];
  /** Nucleus sampling parameter. */
  topP?: number;
  /** Top-k sampling parameter. */
  topK?: number;
  /** Extended thinking budget in tokens. */
  thinkingBudgetTokens?: number;
  /** Escape hatch: merged into the native request body without validation. */
  raw?: Record<string, unknown>;
}

/** OpenAI-specific request options (typed tier). */
export interface OpenAIRequestOptions {
  /** Stop sequences. */
  stop?: string[];
  /** Nucleus sampling parameter. */
  topP?: number;
  /** Deterministic sampling seed. */
  seed?: number;
  /** Service tier for the request. */
  serviceTier?: string;
  /** Presence/frequency penalties. */
  presencePenalty?: number;
  /** Frequency penalty. */
  frequencyPenalty?: number;
  /** Escape hatch: merged into the native request body without validation. */
  raw?: Record<string, unknown>;
}

/** Ollama-specific request options (typed tier). */
export interface OllamaRequestOptions {
  /** Keep-alive duration for the loaded model (e.g. `'5m'`). */
  keepAlive?: string;
  /** Native `options` block (num_ctx, top_k, repeat_penalty, …). */
  modelOptions?: Record<string, unknown>;
  /** Escape hatch: merged into the native request body without validation. */
  raw?: Record<string, unknown>;
}

/**
 * Provider-specific request options, keyed by **adapter type** (not instance
 * name), so two instances of the same adapter share one entry.
 *
 * Three tiers, deliberately visible in the type:
 * 1. portable capabilities live on {@link LLMRequest} itself;
 * 2. known provider-specific options are typed here;
 * 3. anything the SDK does not model yet goes in each provider's `raw`
 *    (or in `custom` for third-party adapters).
 */
export interface ProviderOptionsMap {
  /** Options for `gemini` adapters. */
  gemini?: GeminiRequestOptions;
  /** Options for `claude` adapters. */
  claude?: ClaudeRequestOptions;
  /** Options for `openai` / `openai-compatible` adapters. */
  openai?: OpenAIRequestOptions;
  /** Options for `ollama` adapters. */
  ollama?: OllamaRequestOptions;
  /** Options for adapters not built into the SDK, keyed by provider type. */
  custom?: Record<string, Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: LLM REQUESTS & RESPONSES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How binary content reaches the provider.
 *
 * - `inline` (default) — send the bytes with the request. Predictable and
 *   side-effect free; fails with an explicit error when the payload exceeds the
 *   provider's inline limit.
 * - `upload` — always upload through the provider's file API and reference the
 *   file by id.
 * - `auto` — inline while it fits, upload when it does not. Not hidden magic:
 *   every upload emits `llm.file.uploaded` and the created references are
 *   returned in {@link LLMResponse.uploadedFiles} so the caller can reuse or
 *   delete them.
 */
export type FileHandling = 'inline' | 'upload' | 'auto';

/** Whether usage/cost belongs to a synchronous call or to a batch job. */
export type ExecutionMode = 'sync' | 'batch';

/**
 * Request payload sent to an LLM provider.
 */
export interface LLMRequest {
  /** System-level instructions prepended to the conversation. */
  systemPrompt: string;
  /** Full conversation history including the latest user message. */
  messages: LLMMessage[];
  /** Tool descriptors made available to the LLM in this call. */
  tools?: ToolDescriptor[];
  /** Sampling temperature (0 = deterministic). Default: 0.1. */
  temperature?: number;
  /** Maximum number of tokens the model may generate. Default: 4096. */
  maxTokens?: number;
  /** Identifier of the model to use (e.g. 'claude-opus-5'). */
  model: string;
  /**
   * Provider reasoning budget. Providers that support reasoning effort map this
   * value to their native request parameter; other providers ignore it.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Requests a structured (JSON) answer using the provider's native mechanism.
   *
   * @throws {@link UnsupportedCapabilityError} when the provider declares no
   * native support, or when it is combined with `tools` on a provider that
   * cannot serve both at once.
   */
  responseFormat?: ResponseFormat;
  /** How binary content is transported. Default: `'inline'`. */
  fileHandling?: FileHandling;
  /** Provider-specific options, keyed by adapter type. */
  providerOptions?: ProviderOptionsMap;
  /**
   * When `true`, the provider's raw response is returned in
   * {@link LLMResponse.providerRaw}. Opt-in: raw payloads are never persisted
   * to memory or audit by default.
   */
  includeRaw?: boolean;
  /**
   * Optional token-streaming callback. When provided, providers that support
   * streaming emit each text delta as it is generated, while still returning the
   * fully-assembled {@link LLMResponse} when the call resolves. Tool-call deltas
   * are NOT streamed — only assistant text content.
   */
  onToken?: (delta: string) => void;
  /**
   * Optional abort signal. When the signal fires, a streaming provider stops
   * reading the response and rejects. Used to cancel generation when the client
   * disconnects.
   */
  signal?: AbortSignal;
}

/** Token counts broken down by input/output modality, when reported. */
export interface ModalityUsage {
  /** Modality name as reported by the provider (`text`, `image`, `audio`, …). */
  modality: string;
  /** Tokens attributed to that modality. */
  tokens: number;
}

/**
 * Normalised response returned by any LLM provider.
 */
export interface LLMResponse {
  /** The assistant's text reply (may be empty if the model only called tools). */
  content: string;
  /** Tool calls requested by the model in this response (if any). */
  toolCalls?: ToolCall[];
  /** Reason the model stopped generating. */
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
  /** Token consumption for this call. */
  usage: {
    /** Tokens in the prompt (input). */
    inputTokens: number;
    /**
     * Tokens generated by the model, **including** hidden reasoning tokens
     * where the provider bills them as output (OpenAI, Gemini).
     */
    outputTokens: number;
    /** Sum of input and output tokens. */
    totalTokens: number;
    /** Estimated cost in USD for this call (if pricing is configured). */
    cost?: number;
    /** Input tokens per modality, when the provider reports the breakdown. */
    inputByModality?: ModalityUsage[];
    /** Output tokens per modality, when the provider reports the breakdown. */
    outputByModality?: ModalityUsage[];
  };
  /** Model identifier used for this call. */
  model: string;
  /** Provider instance name (e.g. 'claude', 'openai'). */
  provider: string;
  /** Adapter type that served the call (e.g. 'gemini'). */
  providerType?: string;
  /** Whether this response came from a synchronous call or a batch job. */
  executionMode?: ExecutionMode;
  /** Total wall-clock latency from request start until completion. */
  latencyMs: number;
  /** Detailed latency and token-breakdown metrics when reported by the provider. */
  performance?: {
    /** Time from request start until the streaming response was opened. */
    streamOpenMs?: number;
    /** Time from request start until the first stream chunk (which may be empty). */
    timeToFirstChunkMs?: number;
    /** Time from request start until the first visible text delta. */
    timeToFirstTokenMs?: number;
    /** Time from the first visible text delta until the stream completed. */
    generationMs?: number;
    /** Output tokens visible to the user, excluding hidden reasoning tokens. */
    visibleOutputTokens?: number;
    /** Visible output throughput after the first token. */
    visibleTokensPerSecond?: number;
    /** Hidden reasoning tokens included in the provider's output-token count. */
    reasoningTokens?: number;
    /** Input tokens served from the provider's prompt cache. */
    cachedInputTokens?: number;
  };
  /**
   * Outcome of a {@link LLMRequest.responseFormat} request: what the provider
   * enforced, whether the SDK parsed the answer, and whether it validated it.
   */
  structured?: StructuredOutput;
  /**
   * Files uploaded by the SDK while serving this request (`fileHandling` of
   * `'upload'` or `'auto'`). Reuse them on later requests or delete them.
   */
  uploadedFiles?: ProviderFileRef[];
  /** Raw provider response. Present only when `LLMRequest.includeRaw` is set. */
  providerRaw?: unknown;
  /**
   * Full content blocks from the provider's raw response.
   *
   * Stored by the {@link AgentLoop} in the conversation history so the provider
   * can reconstruct a valid multi-turn context on the next call — without
   * losing `tool_use` / `tool_result` correlation ids or provider state such as
   * Gemini's thought signatures.
   */
  contentBlocks?: ContentBlock[];
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: FILES
// ─────────────────────────────────────────────────────────────────────────────

/** Input accepted by `FileCapableProvider.uploadFile()`. */
export interface FileUploadInput {
  /** File content: a path on disk or in-memory bytes. */
  content: { kind: 'path'; path: string } | { kind: 'bytes'; bytes: Uint8Array };
  /** IANA media type. Inferred from the extension when `content` is a path. */
  mimeType?: string;
  /** Display name stored with the file. */
  fileName?: string;
  /** What the file is for. Providers that distinguish it map this natively. */
  purpose?: 'input' | 'batch';
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: BATCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalised lifecycle state of a batch job.
 *
 * Providers use different vocabularies (Gemini `JOB_STATE_*`, OpenAI
 * `validating`/`in_progress`/…, Anthropic `in_progress`/`ended`); each adapter
 * maps its own onto these six values.
 */
export type BatchJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** One request within a batch, tagged with a stable correlation id. */
export interface BatchRequestItem {
  /**
   * Caller-defined correlation id, echoed back on the matching result.
   * Results may arrive in any order, so this — not position — is what ties a
   * response back to its source document.
   */
  customId: string;
  /** The request to run. Same shape as a synchronous call. */
  request: LLMRequest;
}

/** Options accepted when submitting a batch. */
export interface BatchSubmitOptions {
  /** Human-readable name for the job, where the provider supports one. */
  displayName?: string;
  /** Model applied to items that do not set one. */
  model?: string;
}

/** State of a submitted batch job. */
export interface BatchJob {
  /** Provider-issued job identifier. Persist this to poll across restarts. */
  jobId: string;
  /** Provider instance that owns the job. */
  provider: string;
  /** Adapter type that owns the job. */
  providerType: string;
  /** Model the job runs on, when the provider reports it. */
  model?: string;
  /** Normalised lifecycle state. */
  status: BatchJobStatus;
  /** When the job was created. */
  createdAt: Date;
  /** When the job was last updated, when reported. */
  updatedAt?: Date;
  /** When the job (or its results) expire, when reported. */
  expiresAt?: Date;
  /** Per-item outcome counters, when reported. */
  counts?: {
    /** Total requests in the job. */
    total: number;
    /** Requests that produced a response. */
    succeeded: number;
    /** Requests that failed. */
    failed: number;
    /** Requests cancelled before running. */
    cancelled: number;
    /** Requests that expired before running. */
    expired: number;
  };
  /** Job-level error message when `status` is `'failed'`. */
  error?: string;
}

/**
 * Result of one request within a batch.
 *
 * Exactly one of `response` / `error` is set: individual failures coexist with
 * a globally `completed` job, so only the failed documents need reprocessing.
 */
export interface BatchResultItem {
  /** The `customId` of the originating request. */
  customId: string;
  /** The normalised response, when the request succeeded. */
  response?: LLMResponse;
  /** The failure, when the request did not produce a response. */
  error?: { message: string; code?: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: PLANNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single step within an agent execution plan.
 */
export interface PlanStep {
  /** Unique identifier for this step within the plan. */
  stepId: string;
  /** Name of the tool to invoke in this step. */
  toolName: string;
  /**
   * Template for the tool input (may reference outputs of prior steps).
   * Typed as `any` because the structure is tool-specific.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputTemplate: any;
  /** IDs of steps that must complete before this step can run. */
  dependsOn?: string[];
  /** Human-readable description of what this step does. */
  description: string;
}

/**
 * Execution plan generated by the optional Planner component.
 * Provides full auditability of the agent's intended sequence of actions.
 */
export interface Plan {
  /** Unique identifier for this plan. */
  planId: string;
  /** High-level goal the plan is designed to achieve. */
  goal: string;
  /** Ordered sequence of steps to execute. */
  steps: PlanStep[];
  /** Token estimate for executing all steps (informational). */
  estimatedTokens?: number;
  /** Whether any step in this plan requires human approval before execution. */
  requiresApproval: boolean;
  /** Current lifecycle status of the plan. */
  status: 'draft' | 'approved' | 'executing' | 'completed' | 'failed';
  /** Timestamp when the plan was generated. */
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: SKILLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A logical grouping of related {@link Tool | tools} under a functional domain.
 *
 * Skills are the primary unit of capability composition for agents. An agent
 * declares which skills it uses; the `SkillRegistry` resolves the underlying
 * tools and merges the system-prompt additions at runtime.
 */
export interface Skill {
  /** Unique skill identifier (e.g. `'finance'`, `'hr'`, `'rag'`). */
  name: string;
  /** Human-readable description of what the skill provides. */
  description: string;
  /** Tools exposed to the LLM when this skill is active. */
  tools: Tool[];
  /**
   * Optional text appended to the agent's system prompt when this skill is
   * loaded (e.g. domain-specific instructions or constraints).
   */
  systemPromptAddition?: string;
  /** Roles required to activate this skill (checked by the ACL layer). */
  requiredRoles?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: AGENT CONFIG & LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration object for a registered agent instance.
 */
export interface AgentConfig {
  /** Unique identifier for this agent. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Base system prompt injected at the start of every conversation. */
  systemPrompt: string;
  /** Names of skills to activate for this agent. */
  skills: string[];
  /**
   * LLM provider and model configuration.
   *
   * All fields are optional. When omitted, the Orchestrator resolves values
   * from `SDKConfig.llm.defaultProvider` / `defaultModel`, then falls back to
   * the `defaultModel` declared for that provider in `SDKConfig.llm.providers`.
   */
  llmConfig?: {
    /** Provider name (e.g. 'claude', 'openai', 'deepseek', 'ollama'). */
    provider?: string;
    /** Model identifier (e.g. 'claude-opus-5'). */
    model?: string;
    /** Sampling temperature. Default: 0.1. */
    temperature?: number;
    /** Maximum tokens per LLM call. Default: 4096. */
    maxTokens?: number;
    /** Provider to use if the primary fails. */
    fallbackProvider?: string;
    /** Model to use with the fallback provider. */
    fallbackModel?: string;
  };
  /**
   * Memory compression strategy configuration.
   *
   * All fields are optional. When omitted, the Orchestrator resolves values
   * from `SDKConfig.memory.session` (strategy type and maxMessages).
   */
  memoryStrategy?: {
    /** Strategy type to apply when the conversation exceeds the window. */
    type?: 'sliding_window' | 'incremental_summary';
    /** Maximum number of messages to keep in context. */
    maxMessages?: number;
    /** Message count that triggers incremental summary. */
    summaryThreshold?: number;
  };
  /** Whether to use the explicit Planner before executing. Default: false. */
  usePlanner?: boolean;
  /**
   * Maximum number of agent loop iterations per request.
   * When omitted, resolved from `SDKConfig.agent.maxLoopIterations`.
   */
  maxLoopIterations?: number;
  /** Arbitrary metadata stored with the agent configuration. */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION TOOLS — SHARED VOCABULARY (bindings, limits, envelopes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Caps applied to a single tool execution.
 *
 * Resolved in cascade: the tool's own value, then the connection's, then the
 * SDK default. A tool may lower a connection's cap but never raise it — the
 * connection is the ceiling.
 */
export interface ResourceLimits {
  /** Maximum rows/records returned. Excess is dropped and flagged. */
  maxRows?: number;
  /** Maximum serialised size of the payload handed to the model, in bytes. */
  maxBytes?: number;
  /** Wall-clock cap for the operation, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Fields of the {@link ExecutionContext} a `context` binding may read.
 *
 * `metadata.*` is the open-ended slot the host fills; the SDK transports those
 * values without interpreting them.
 */
export type ContextPath =
  | 'userId'
  | 'tenantId'
  | 'sessionId'
  | 'agentId'
  | 'roles'
  | `metadata.${string}`;

/**
 * Where a tool parameter's value comes from.
 *
 * This is the primitive that keeps the model out of decisions that are not
 * its own: only `model` bindings are published in the tool's `inputSchema`, so
 * `context` and `literal` values never enter the model's decision space — they
 * are not filtered out afterwards, they were never offered.
 */
export type ValueBinding =
  /** Supplied by the LLM. Published in the tool's generated `inputSchema`. */
  | {
      from: 'model';
      /** JSON Schema for this single parameter. */
      schema: JSONSchema;
      /** Description surfaced to the LLM alongside the schema. */
      description?: string;
      /** Whether the LLM must supply it. Default: `false`. */
      required?: boolean;
    }
  /** Read from the {@link ExecutionContext}. Invisible to the model. */
  | {
      from: 'context';
      /** Which context field to read. */
      path: ContextPath;
      /**
       * When `true`, a missing/empty value fails the execution instead of
       * binding `undefined`. Default: `false`.
       */
      required?: boolean;
    }
  /** Fixed value from the configuration. Invisible to the model. */
  | { from: 'literal'; value: unknown };

/** Which cap forced a result to be cut short. */
export type TruncationReason = 'maxRows' | 'maxBytes';

/**
 * Uniform envelope for every tool that returns a collection, so the model
 * learns one shape across SQL, Mongo and HTTP.
 */
export interface CollectionResult<T = unknown> {
  /** The returned records, already capped. */
  rows: T[];
  /** Number of records in `rows`. */
  rowCount: number;
  /** `true` when records were dropped to respect a cap. */
  truncated: boolean;
  /** Which cap caused the truncation. Present only when `truncated`. */
  truncatedBy?: TruncationReason;
  /**
   * Plain-language note included **for the model to read**. Without it the
   * model reports a capped count as if it were the total.
   */
  notice?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: DECLARATIVE CONFIG (agents, skills, tools)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional metadata shared by every declarative tool definition.
 *
 * When present, these fields override the corresponding {@link ToolDescriptor}
 * fields of the loaded/instantiated tool, letting the config tune a tool
 * without changing its implementation.
 */
export interface ToolDefinitionBase {
  /** Unique tool name. Must be unique across all definitions. */
  name: string;
  /** Tags used for filtering and ACL policy matching (overrides the tool's own). */
  tags?: string[];
  /** When true, execution requires explicit human approval (HITL). */
  requiresApproval?: boolean;
  /** Marks the tool as acting outside the SDK. See {@link ToolDescriptor.sideEffects}. */
  sideEffects?: boolean;
  /** Per-tool execution timeout in milliseconds. */
  timeout?: number;
  /** Retry policy applied on transient failures. */
  retryPolicy?: RetryPolicy;
  /**
   * Arbitrary configuration passed to the tool factory when the resolved export
   * (or internal `ref`) is a function `(config) => Tool`. Ignored when the
   * export is a plain {@link Tool} object — there is nowhere to inject it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any;
}

/**
 * A tool whose implementation is loaded dynamically from an external module.
 */
export interface ModuleToolDefinition extends ToolDefinitionBase {
  /** Discriminator: this tool is loaded from an external module. */
  kind: 'module';
  /**
   * Module specifier. Resolved as:
   * 1. **bare specifier** (npm package, e.g. `'@acme/tools'`) — imported as-is;
   * 2. **absolute path** — used verbatim;
   * 3. **relative path** (starts with `'.'`) — resolved against `appHome`, then
   *    the config file's directory, then `process.cwd()`.
   */
  module: string;
  /**
   * Named export to read from the module. The SDK forbids default exports, so
   * when omitted the loader looks for an export matching {@link name}, then
   * falls back to the module's sole named export.
   */
  export?: string;
}

/**
 * A tool provided by the SDK itself, referenced by its internal id
 * (e.g. `'rag.search'`). No external module is loaded.
 */
export interface InternalToolDefinition extends ToolDefinitionBase {
  /** Discriminator: this tool is built from an SDK-internal factory. */
  kind: 'internal';
  /** Internal tool id known to the SDK (e.g. `'rag.search'`). */
  ref: string;
}

/**
 * A tool exposed by an external MCP server declared in `mcp.servers`.
 *
 * Declaring MCP tools one by one (rather than via `autoRegisterTools`) is the
 * recommended production setup: it pins exactly which remote capabilities are
 * reachable and lets each one carry its own tags, timeout, and approval flag.
 */
export interface McpToolDefinition extends ToolDefinitionBase {
  /** Discriminator: this tool lives on an external MCP server. */
  kind: 'mcp';
  /** Key of the server in the `mcp.servers` config section. */
  server: string;
  /** Tool name as exposed by that server (before namespacing). */
  remoteName: string;
}

/** Declarative tool definition, discriminated by `kind`. */
export type ToolDefinition = ModuleToolDefinition | InternalToolDefinition | McpToolDefinition;

/**
 * Declarative form of a {@link Skill} for use in the SDK config.
 *
 * Unlike {@link Skill}, its `tools` field references tool **names** (strings),
 * which the loader resolves against the populated `ToolRegistry`.
 */
export interface DeclarativeSkill {
  /** Unique skill identifier. */
  name: string;
  /** Human-readable description of what the skill provides. */
  description: string;
  /** Names of tools (from `tools.definitions` or registered in code). */
  tools: string[];
  /** Optional text appended to the agent's system prompt when active. */
  systemPromptAddition?: string;
  /** Roles required to activate this skill (metadata; enforced by the ACL layer if registered). */
  requiredRoles?: string[];
}

/**
 * An event emitted by the agent loop and subscribable via EventBus.
 */
export interface AgentEvent {
  /** Dot-separated event name (e.g. 'tool.call.end', 'llm.call.error'). */
  type: string;
  /** Event payload — shape varies per event type. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  /** Timestamp of the event. */
  timestamp: Date;
}

/**
 * Options passed to `AgentLoop.run()` or `Orchestrator.runAgent()`.
 */
export interface RunOptions {
  /** Pre-built conversation history for stateless mode (bypasses session memory). */
  externalContext?: LLMMessage[];
  /**
   * Requests a structured (JSON) answer, using the provider's native mechanism.
   * Applied to every iteration of the loop; the outcome is reported in
   * {@link AgentResponse.structured}.
   *
   * @throws {@link UnsupportedCapabilityError} when the provider has no native
   * support, or cannot combine it with the agent's tools.
   */
  responseFormat?: ResponseFormat;
  /** How binary content is transported. Default: `'inline'`. */
  fileHandling?: FileHandling;
  /** Provider-specific options, keyed by adapter type. */
  providerOptions?: ProviderOptionsMap;
  /** User context to inject into the system prompt. */
  externalUserContext?: UserContext;
  /** Callback invoked for each event emitted during the run. */
  onEvent?: (event: AgentEvent) => void;
  /** Callback configuration for HITL approval resolution notifications. */
  approvalCallback?: ApprovalCallback;
  /**
   * When `true`, the loop requests token streaming from the LLM provider and
   * emits a `llm.token` event (with `{ delta, iteration }`) for each text delta.
   * Forwarded to the caller via {@link onEvent}. Has no effect on the final
   * {@link AgentResponse}; only assistant text content is streamed (not tool
   * calls). Providers without streaming support degrade gracefully.
   */
  stream?: boolean;
  /**
   * Optional abort signal forwarded to the LLM provider so generation can be
   * cancelled when the client disconnects.
   */
  signal?: AbortSignal;
  /**
   * @internal
   * Used by `Orchestrator.approve()` to resume a suspended run.
   * When set, the agent loop uses this array as the full message history
   * (already including the approved tool result and DEFERRED placeholders for
   * sibling calls) and skips the user-message push and the planner phase.
   * Do not set this from application code.
   */
  _resumeContext?: LLMMessage[];
}

/**
 * High-level response returned after a complete agent loop execution.
 */
export interface AgentResponse {
  /** Final text response generated by the agent. */
  content: string;
  /** Names of all tools invoked during the loop. */
  toolsUsed: string[];
  /** Number of agent loop iterations executed. */
  iterations: number;
  /** Plan generated by the Planner, if enabled. */
  plan?: Plan;
  /** Aggregated token usage across all LLM calls in the loop. */
  usage: {
    /** Total input tokens consumed across all iterations. */
    totalInputTokens: number;
    /** Total output tokens generated across all iterations. */
    totalOutputTokens: number;
    /** Total estimated cost in USD for the full loop. */
    totalCostUsd: number;
    /** Per-iteration token usage breakdown. */
    byIteration: LLMResponse['usage'][];
  };
  /** Total wall-clock duration of the loop in milliseconds. */
  durationMs: number;
  /**
   * Outcome of a {@link RunOptions.responseFormat} request on the final answer:
   * what the provider enforced, whether the SDK parsed it, and whether it
   * validated against the schema.
   */
  structured?: StructuredOutput;
  /**
   * Files the SDK uploaded while serving this run (`fileHandling` of `'upload'`
   * or `'auto'`). Reuse them on later turns or delete them.
   */
  uploadedFiles?: ProviderFileRef[];
  /** Pending HITL approval actions created during this run (if any). */
  pendingActions?: PendingActionSummary[];
  /** True if at least one tool call was deferred for human approval. */
  hasPendingApprovals: boolean;
  /**
   * True when the run was suspended waiting for human approval and the agent
   * loop did NOT complete. The caller must call `Orchestrator.approve()` (or
   * `reject()`) to resume or discard the run.
   */
  suspended?: boolean;
}

/**
 * Options accepted by `Orchestrator.chat()`.
 */
export interface ChatOptions {
  /** Reuse an existing session instead of starting a new one. */
  sessionId?: string;
  /**
   * Requests a structured (JSON) answer, using the provider's native mechanism.
   * The outcome is reported in {@link AgentResponse.structured}.
   */
  responseFormat?: ResponseFormat;
  /** How binary content is transported. Default: `'inline'`. */
  fileHandling?: FileHandling;
  /** Provider-specific options, keyed by adapter type. */
  providerOptions?: ProviderOptionsMap;
  /** Pre-built conversation history for stateless mode. */
  externalContext?: LLMMessage[];
  /** User context to inject into the system prompt. */
  userContext?: UserContext;
  /** Callback invoked for each event emitted during the run. */
  onEvent?: (event: AgentEvent) => void;
  /** Callback configuration for HITL approval resolution notifications. */
  approvalCallback?: ApprovalCallback;
  /**
   * When `true`, enables token streaming: the loop emits a `llm.token` event
   * for each assistant text delta, forwarded via {@link onEvent}. Does not change
   * the returned {@link AgentResponse}.
   */
  stream?: boolean;
  /** Optional abort signal forwarded to the LLM provider to cancel generation. */
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: SESSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents an active or historical agent session.
 */
export interface Session {
  /** Unique session identifier. */
  sessionId: string;
  /** Tenant that owns the session. */
  tenantId: string;
  /** User that initiated the session. */
  userId: string;
  /** Agent handling the session. */
  agentId: string;
  /** Current lifecycle status of the session. */
  status: 'active' | 'closed' | 'expired';
  /** When the session was created. */
  createdAt: Date;
  /** Timestamp of the last message or tool call in this session. */
  lastActivityAt: Date;
  /** Arbitrary metadata attached to the session. */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: SKILLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A logical grouping of related tools under a functional domain.
 * Skills expose tools to the agent and can inject additional system prompt content.
 */
export interface Skill {
  /** Unique skill name (e.g. 'finance', 'hr', 'rag'). */
  name: string;
  /** Human-readable description of what this skill provides. */
  description: string;
  /** Names of roles required to activate this skill for a given user. */
  requiredRoles?: string[];
  /** Additional text appended to the system prompt when this skill is active. */
  systemPromptAddition?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — CORE: TOKEN TRACKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable record of token consumption for a single LLM call.
 */
export interface TokenUsageRecord {
  /** Unique identifier for this record. */
  recordId: string;
  /** Tenant billed for this consumption. */
  tenantId: string;
  /** User that triggered the LLM call. */
  userId: string;
  /** Agent that made the LLM call. */
  agentId: string;
  /** Session in which the call occurred. */
  sessionId: string;
  /** Request that triggered the call. */
  requestId: string;
  /** LLM provider name (e.g. 'claude', 'openai'). */
  provider: string;
  /** Model identifier used for the call. */
  model: string;
  /** Skill that originated the call, when attributable. */
  skillId?: string;
  /** Tool that originated the call, when attributable (e.g. 'rag.search'). */
  toolName?: string;
  /** Number of prompt (input) tokens consumed. */
  inputTokens: number;
  /** Number of completion (output) tokens generated. */
  outputTokens: number;
  /** Estimated cost in USD based on configured pricing. */
  estimatedCostUsd: number;
  /** UTC timestamp of the call. */
  timestamp: Date;
}

/**
 * Aggregated token usage summary for a tenant or user over a time range.
 */
export interface TokenUsageSummary {
  /** Total input tokens across all records in the range. */
  totalInputTokens: number;
  /** Total output tokens across all records in the range. */
  totalOutputTokens: number;
  /** Total estimated cost in USD across all records. */
  totalCostUsd: number;
  /** Per-model breakdown of token counts and costs. */
  byModel: Record<string, { tokens: number; cost: number }>;
  /** Per-provider breakdown of token counts and costs. */
  byProvider: Record<string, { tokens: number; cost: number }>;
  /** Per-agent breakdown of token counts and costs. */
  byAgent: Record<string, { tokens: number; cost: number }>;
  /** Per-skill breakdown (only records with an attributed `skillId`). */
  bySkill: Record<string, { tokens: number; cost: number }>;
  /** Per-tool breakdown (only records with an attributed `toolName`). */
  byTool: Record<string, { tokens: number; cost: number }>;
  /** Number of individual records included in this summary. */
  recordCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 2 — RAG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata attached to a document or chunk stored in the vector database.
 */
export interface DocumentMetadata {
  /** Source document identifier. */
  documentId: string;
  /** Document title (if available). */
  title?: string;
  /** URL, file path, or system reference where the document originated. */
  source?: string;
  /** MIME type of the original document (e.g. 'application/pdf'). */
  mimeType?: string;
  /** ISO 639-1 language code (e.g. 'es', 'en'). */
  language?: string;
  /** When the document was first ingested. */
  createdAt?: Date;
  /** When the document was last updated. */
  updatedAt?: Date;
  /** Author or system that produced the document. */
  author?: string;
  /** Classification tags for filtering and faceting. */
  tags?: string[];
  /** Tenant that owns this document (used for isolation). */
  tenantId?: string;
  /** Roles that are allowed to retrieve this document. */
  accessRoles?: string[];
  /** Zero-based index of this chunk within the source document. */
  chunkIndex?: number;
  /** Total number of chunks derived from the source document. */
  totalChunks?: number;
  /** Arbitrary extra fields defined by the host application. */
  custom?: Record<string, unknown>;
}

/**
 * A retrieved text passage with its relevance score and provenance metadata.
 */
export interface Passage {
  /** Unique identifier of this chunk in the vector store. */
  id: string;
  /** The text content of this passage. */
  content: string;
  /** Relevance score normalised to [0, 1]. Higher is more relevant. */
  score: number;
  /** Metadata about the source document. */
  metadata: DocumentMetadata;
  /** Name of the collection this passage was retrieved from. */
  collection: string;
  /** Raw embedding vector (only populated when `includeEmbeddings` is true). */
  embedding?: number[];
}

/**
 * Filter applied during a RAG search to restrict the candidate document set.
 */
export interface RAGFilter {
  /** Restrict results to documents owned by this tenant. */
  tenantId?: string;
  /** Return only documents that carry at least one of these tags (OR). */
  tags?: string[];
  /**
   * Return only documents that carry ALL of these tags (AND).
   * Combines with `tags` (OR): a document must satisfy both conditions.
   */
  tagsAll?: string[];
  /** Return only chunks belonging to this source document (or any of these, when an array). */
  documentId?: string | string[];
  /** Return only documents in this language. */
  language?: string;
  /** Restrict results to documents created/updated within this date range. */
  dateRange?: { from?: Date; to?: Date };
  /** Return only documents whose `accessRoles` overlap with these roles. */
  accessRoles?: string[];
  /**
   * Arbitrary metadata key-value pairs to match.
   * Note: adapter support varies — `InMemoryVectorStore` matches against
   * `metadata.custom`; `MeilisearchAdapter` does not implement this field.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Input parameters for a RAG pipeline search operation.
 */
export interface RAGQuery {
  /** Natural language query to embed and search. */
  query: string;
  /** Collections to search (searched in parallel; results are merged). */
  collections: string[];
  /** Number of candidates retrieved per collection before re-ranking. Default: 10. */
  topK?: number;
  /** Maximum number of passages returned after re-ranking. Default: 5. */
  finalTopK?: number;
  /** Optional filters applied to the candidate set. */
  filters?: RAGFilter;
  /** Search strategy. Default: 'hybrid'. */
  searchMode?: 'vector' | 'keyword' | 'hybrid';
  /**
   * Weight between keyword (0) and vector (1) in hybrid mode.
   * Default: 0.7 (favours semantic similarity).
   */
  hybridAlpha?: number;
  /** Whether to apply a re-ranker after retrieval. Default: true. */
  rerank?: boolean;
  /**
   * What to do when re-ranking is requested but the re-ranker fails.
   *
   * - `'require'` (default) — throw a `RerankerError`. Without the re-ranker the
   *   only absolute relevance signal is lost: retrieval scores are min-max
   *   normalised per collection, so the top candidate always scores 1.0 and
   *   `minScore` silently stops discriminating.
   * - `'degrade'` — fall back to retrieval order and return results anyway.
   *
   * Overrides `rag.retrieval.rerankPolicy` for a single query.
   */
  rerankPolicy?: 'require' | 'degrade';
  /**
   * RRF smoothing constant for hybrid search in `InMemoryVectorStore`.
   * Higher values reduce the penalty for lower-ranked items. Default: 60.
   * Has no effect when using `MeilisearchAdapter` (native hybrid search).
   */
  rrfK?: number;
  /** Whether to include the raw embedding vectors in returned passages. Default: false. */
  includeEmbeddings?: boolean;
  /** Minimum relevance score threshold (passages below this are filtered out). */
  minScore?: number;
  /**
   * Recent conversation messages forwarded to the `QueryRewriter` (if configured).
   * Used by `ContextualRewriter` to resolve implicit references; ignored by `HyDERewriter`
   * and when no rewriter is set.
   */
  conversationHistory?: LLMMessage[];
}

/**
 * Result returned by the RAG pipeline after search, merge, and re-ranking.
 */
export interface RAGResult {
  /** Final list of passages in descending relevance order. */
  passages: Passage[];
  /** Total number of candidates found before applying `finalTopK`. */
  totalFound: number;
  /** Original query string. */
  query: string;
  /** Collections that were searched. */
  collections: string[];
  /** Search mode that was applied. */
  searchMode: string;
  /** Whether a re-ranker was applied. */
  reranked: boolean;
  /** Latency breakdown for each pipeline stage. */
  metrics: {
    /** Time to generate the query embedding in ms. */
    embeddingLatencyMs: number;
    /** Time spent querying the vector store in ms. */
    searchLatencyMs: number;
    /** Time spent re-ranking in ms (absent if reranking was skipped). */
    rerankLatencyMs?: number;
    /** Total end-to-end latency in ms. */
    totalLatencyMs: number;
    /** Tokens consumed if the re-ranker is LLM-based. */
    tokensUsed?: number;
  };
}

/**
 * Outcome of a provider health check (`validate()`).
 *
 * Providers are probed against live infrastructure, where "it failed" is rarely
 * actionable on its own: an unreachable host, an expired key and a missing model
 * each call for a different response. A bare boolean forces the caller to guess,
 * so the reason travels with the result.
 */
export interface ProviderProbe {
  /** Whether the provider answered the probe successfully. */
  ok: boolean;
  /** Failure description when `ok` is `false`. Absent on success. */
  error?: string;
}

/**
 * Outcome of a re-ranker health check (`orch.rag.validateReranker()`).
 *
 * Distinguishes the two failure modes a deployment must handle differently:
 * no re-ranker configured at all (a design choice) versus one configured but
 * unreachable (an incident).
 */
export interface RerankerValidation {
  /** Whether a re-ranker is configured for this pipeline. */
  configured: boolean;
  /** Provider name of the configured re-ranker (absent when none is configured). */
  provider?: string;
  /**
   * Whether the configured re-ranker answered a probe request successfully.
   * Always `false` when `configured` is `false`.
   */
  available: boolean;
  /** Failure description when the probe did not succeed. */
  error?: string;
  /** Milliseconds the probe took (absent when no probe was made). */
  latencyMs?: number;
}

/**
 * Result of a single text embedding operation.
 */
export interface EmbeddingResult {
  /** Dense vector representation of the input text. */
  vector: number[];
  /** Model that produced the embedding. */
  model: string;
  /** Number of dimensions in the vector. */
  dimensions: number;
  /** Tokens consumed by the embedding call. */
  tokensUsed: number;
  /** Latency of the embedding call in ms. */
  latencyMs: number;
}

/**
 * Result returned by a re-ranker after reordering a set of passages.
 */
export interface RerankResult {
  /** Reordered passages in descending relevance order. */
  passages: Passage[];
  /** Model used for re-ranking. */
  model: string;
  /** Latency of the re-ranking call in ms. */
  latencyMs: number;
  /** Tokens consumed (only applicable for LLM-based re-rankers). */
  tokensUsed?: number;
}

/**
 * Options for formatting retrieved passages into a context string for the LLM.
 */
export interface FormatOptions {
  /** Include the source reference below each passage. Default: true. */
  includeSource?: boolean;
  /** Include the relevance score next to each passage. Default: false. */
  includeScore?: boolean;
  /** Truncate each passage to this character limit before formatting. */
  maxCharsPerPassage?: number;
  /** Custom template string; use `{{content}}` and `{{source}}` placeholders. */
  template?: string;
  /** Separator between passages. Default: '\n---\n'. */
  separator?: string;
}

/**
 * Metadata about a vector store collection.
 */
export interface CollectionInfo {
  /** Collection name. */
  name: string;
  /** Number of documents indexed. */
  documentCount: number;
  /** Dimensionality of stored vectors. */
  dimensions: number;
  /**
   * Name of the embedding provider that generated the vectors in this
   * collection. Empty string when the collection was created outside the SDK
   * and the provider is unknown.
   */
  embeddingProvider: string;
  /** Embedding model used to generate vectors in this collection. */
  embeddingModel: string;
  /** Distance metric used for similarity search. */
  distanceMetric: 'cosine' | 'dot' | 'euclidean';
}

/**
 * Configuration used when creating a new vector store collection.
 */
export interface CollectionConfig {
  /** Dimensionality of vectors that will be stored. */
  dimensions: number;
  /** Distance metric to use for similarity comparisons. */
  distanceMetric: 'cosine' | 'dot' | 'euclidean';
  /** Name of the embedding provider that generates vectors for this collection. */
  embeddingProvider: string;
  /** Embedding model identifier (must match the provider). */
  embeddingModel: string;
}

/**
 * A document ready to be upserted into a vector store collection.
 */
export interface VectorDocument {
  /** Unique identifier for this chunk. */
  id: string;
  /** Raw text content of the chunk. */
  content: string;
  /** Pre-computed embedding vector. */
  vector: number[];
  /** Document metadata. */
  metadata: DocumentMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 3 — SECURITY / ACL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Access control policy for a resource (tool, skill, collection, field, or agent).
 * The model is whitelist-based: absent policy means public access.
 */
export interface ACLPolicy {
  /** Type of resource this policy governs. */
  resourceType: 'tool' | 'skill' | 'collection' | 'field' | 'agent';
  /** Identifier of the resource (e.g. 'finance.getBalance'). */
  resourceId: string;
  /** Roles permitted to access this resource. Use `['*']` for public access. */
  allowedRoles: string[];
  /** Roles explicitly denied, even if they appear in `allowedRoles`. */
  deniedRoles?: string[];
  /** Additional runtime conditions that must all be satisfied (AND). */
  conditions?: ACLCondition[];
  /** Human-readable explanation of why this policy exists. */
  description?: string;
}

/**
 * A runtime condition evaluated against the `ExecutionContext` during ACL checks.
 */
export interface ACLCondition {
  /** Dot-notation path within `ExecutionContext` to evaluate (e.g. 'metadata.department'). */
  field: string;
  /** Comparison operator. */
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'exists' | 'regex';
  /** Value to compare the field against. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
}

/**
 * Result of an ACL evaluation for a specific resource and context.
 */
export interface ACLDecision {
  /** Whether the user is allowed to access the resource. */
  allowed: boolean;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** Identifier of the policy that produced this decision (if any matched). */
  matchedPolicy?: string;
  /** When the evaluation was performed. */
  evaluatedAt: Date;
  /** Time taken to evaluate in milliseconds. */
  durationMs: number;
}

/**
 * Rule that controls how a specific field in a tool's output is masked.
 * Users whose roles are NOT in `visibleToRoles` see the masked version.
 */
export interface FieldMaskRule {
  /** Name of the tool whose output this rule applies to. */
  toolName: string;
  /** Dot-notation path to the field within the tool output (e.g. 'employee.salary'). */
  field: string;
  /** How the field value is obscured for unauthorised roles. */
  maskType: 'redact' | 'partial' | 'hash' | 'custom';
  /** Roles that receive the original, unmasked value. */
  visibleToRoles: string[];
  /** Configuration for `maskType: 'partial'`. */
  partialConfig?: {
    /** Number of characters to show from the start of the value. */
    showFirst?: number;
    /** Number of characters to show from the end of the value. */
    showLast?: number;
    /** Character used for masking. Default: '*'. */
    maskChar?: string;
  };
  /**
   * Custom masking function for `maskType: 'custom'`.
   * Receives the original value and returns the masked version.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customMask?: (value: any, context: ExecutionContext) => any;
}

/**
 * Rule that automatically filters data at the result level before returning to the agent.
 */
export interface DataFilterRule {
  /** Whether this rule applies to RAG results, tool results, or both. */
  scope: 'rag' | 'tool' | 'all';
  /** When `scope` is `'tool'`, the specific tool to filter. */
  toolName?: string;
  /** The kind of filter to apply. */
  filterType: 'tenant_isolation' | 'role_based' | 'custom';
  /** Filter configuration depending on `filterType`. */
  config: {
    /**
     * Custom filter function for `filterType: 'custom'`.
     * Receives the raw data and returns the filtered version.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customFilter?: (data: any, context: ExecutionContext) => any;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 4 — AUDIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level category grouping audit events by the subsystem that produced them.
 */
export type AuditCategory =
  | 'agent' // Agent loop start/end
  | 'tool' // Tool execution
  | 'skill' // Skill activation within a run
  | 'llm' // LLM provider calls
  | 'rag' // RAG pipeline searches
  | 'security' // ACL decisions, injection, rate limiting
  | 'session' // Session lifecycle events
  | 'memory' // Memory compression and long-term storage
  | 'system' // SDK startup, shutdown, configuration
  | 'approval'; // HITL approval events

/**
 * Immutable record capturing a single auditable action.
 * Records are written once and never modified; expiry is handled by retention policy.
 */
export interface AuditRecord {
  // ─── Identification ───
  /** UUID unique to this audit record. */
  id: string;
  /** UTC timestamp when the event was captured. */
  timestamp: Date;

  // ─── Correlation ───
  /** UUID of the originating request (links all records for one chat call). */
  requestId: string;
  /** Session in which the event occurred. */
  sessionId: string;
  /** Tenant that owns this record. */
  tenantId: string;
  /** User that triggered the action. */
  userId: string;
  /** Agent that was active when the event occurred. */
  agentId: string;

  // ─── Action ───
  /** Subsystem category of the event. */
  category: AuditCategory;
  /** Specific action name within the category (e.g. 'call_end', 'access_denied'). */
  action: string;
  /** Outcome of the action. */
  outcome: 'success' | 'failure' | 'blocked' | 'error';
  /** Severity level of the event. */
  severity: 'info' | 'warning' | 'critical';

  // ─── Detail ───
  /** Variable-depth detail block populated according to the configured verbosity. */
  detail?: AuditDetail;

  // ─── Resource ───
  /** The resource that was acted upon (if applicable). */
  resource?: {
    /** Type of resource (e.g. 'tool', 'skill', 'document'). */
    type: string;
    /** Identifier of the resource. */
    id: string;
    /** Human-readable name. */
    name?: string;
  };

  // ─── Metrics ───
  /** Performance and cost metrics for this event. */
  metrics?: {
    /** Duration of the operation in ms. */
    durationMs?: number;
    /** Input tokens consumed. */
    tokensInput?: number;
    /** Output tokens generated. */
    tokensOutput?: number;
    /** Estimated cost in USD. */
    estimatedCostUsd?: number;
    /** Time from request start until the first stream chunk. */
    timeToFirstChunkMs?: number;
    /** Time from request start until the streaming response was opened. */
    streamOpenMs?: number;
    /** Time from request start until the first visible output token. */
    timeToFirstTokenMs?: number;
    /** Time spent generating after the first visible output token. */
    generationMs?: number;
    /** Visible output throughput after the first token. */
    visibleTokensPerSecond?: number;
    /** Hidden reasoning tokens reported by the provider. */
    reasoningTokens?: number;
    /** Output tokens visible to the user after excluding hidden reasoning. */
    visibleOutputTokens?: number;
    /** Input tokens served from prompt cache. */
    cachedInputTokens?: number;
  };

  // ─── Security ───
  /** Security-specific metadata attached when relevant. */
  security?: {
    /** ACL decision that was made, if applicable. */
    aclDecision?: ACLDecision;
    /** Names of fields that were masked before the response was returned. */
    fieldsMasked?: string[];
    /** True if a prompt injection pattern was detected in the input. */
    injectionDetected?: boolean;
    /** Risk level string as reported by the sanitizer. */
    riskLevel?: string;
  };

  /** SHA-256 hash of immutable fields for tamper detection. */
  _integrityHash?: string;
}

/**
 * Variable-depth content block within an AuditRecord.
 * The populated fields depend on the configured verbosity level.
 */
export interface AuditDetail {
  // minimal level
  /** One-line summary of what happened. Always populated. */
  summary?: string;

  // standard level (adds these)
  /** Sanitised input to the tool or LLM call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  /** Sanitised output from the tool or LLM call. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: any;
  /** Error message if the action failed. */
  error?: string;

  // verbose level (adds these)
  /** Full conversation history sent to the LLM (verbose only). */
  messages?: LLMMessage[];
  /** Raw LLM response object (verbose only). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fullResponse?: any;
  /** Ordered log of all tool calls made in the agent loop (verbose only). */
  toolCallChain?: ToolCallLog[];
}

/**
 * Entry in the verbose tool call chain stored within an AuditDetail.
 */
export interface ToolCallLog {
  /** Name of the tool that was invoked. */
  toolName: string;
  /** Input passed to the tool. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  /** Output returned by the tool. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;
  /** Execution duration in ms. */
  durationMs: number;
  /** Whether the tool completed successfully. */
  success: boolean;
  /** Agent loop iteration in which this call occurred (1-based). */
  iteration: number;
}

/**
 * Filter object for querying the audit store.
 */
export interface AuditQuery {
  // Identity filters
  /** Filter by tenant. */
  tenantId?: string;
  /** Filter by user. */
  userId?: string;
  /** Filter by agent. */
  agentId?: string;
  /** Filter by session. */
  sessionId?: string;
  /** Filter by originating request. */
  requestId?: string;

  // Event filters
  /** Filter by one or more event categories. */
  category?: AuditCategory | AuditCategory[];
  /** Filter by specific action name. */
  action?: string;
  /** Filter by outcome. */
  outcome?: AuditRecord['outcome'] | AuditRecord['outcome'][];
  /** Filter by severity. */
  severity?: AuditRecord['severity'] | AuditRecord['severity'][];

  // Time filter (required for scoped queries)
  /** Inclusive date range for the query. */
  dateRange: { from: Date; to: Date };

  // Resource filters
  /** Filter by resource type. */
  resourceType?: string;
  /** Filter by resource identifier. */
  resourceId?: string;

  // Full-text search
  /** Full-text search term matched against `detail.summary` and `detail.error`. */
  searchText?: string;

  // Pagination
  /** Maximum records to return. Default: 50. Max: 1000. */
  limit?: number;
  /** Number of records to skip (for pagination). */
  offset?: number;
  /** Field to sort results by. */
  sortBy?: 'timestamp' | 'severity';
  /** Sort direction. Default: 'desc'. */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result set returned from an audit store query.
 */
export interface AuditQueryResult {
  /** Records matching the query on this page. */
  records: AuditRecord[];
  /** Total count of matching records (without pagination). */
  total: number;
  /** True if there are more records beyond this page. */
  hasMore: boolean;
  /** The query that was executed (for reference). */
  query: AuditQuery;
}

/**
 * Aggregated statistics for a tenant's audit activity over a time range.
 */
export interface AuditStats {
  /** Total number of audit records in the period. */
  totalRecords: number;
  /** Record count broken down by category. */
  byCategory: Record<string, number>;
  /** Record count broken down by outcome. */
  byOutcome: Record<string, number>;
  /** Record count broken down by severity. */
  bySeverity: Record<string, number>;
  /** Per-user activity summary. */
  byUser: { userId: string; count: number; tokens: number }[];
  /** Per-agent activity summary. */
  byAgent: { agentId: string; count: number; tokens: number }[];
  /** Total input tokens consumed in the period. */
  totalTokensInput: number;
  /** Total output tokens generated in the period. */
  totalTokensOutput: number;
  /** Total estimated cost in USD for the period. */
  totalCostUsd: number;
  /** Average agent loop response time in ms. */
  avgResponseTimeMs: number;
  /** Number of security incidents (severity 'critical') in the period. */
  securityIncidents: number;
}

/**
 * Dimension by which `AuditStoreAdapter.aggregate()` groups records.
 */
export type AuditAggregateDimension =
  | 'category'
  | 'action'
  | 'outcome'
  | 'severity'
  | 'user'
  | 'agent'
  | 'hour'
  | 'day';

/**
 * Aggregated result item returned from `AuditStoreAdapter.aggregate()`.
 */
export interface AggregateResult {
  /** The group key (e.g. category name, hour bucket). */
  key: string;
  /** Number of records in this group. */
  count: number;
  /** Average duration across records in this group. */
  avgDurationMs?: number;
  /** Total tokens consumed in this group (input + output). */
  totalTokens?: number;
  /** Total input tokens consumed in this group. */
  totalTokensInput?: number;
  /** Total output tokens generated in this group. */
  totalTokensOutput?: number;
  /** Total estimated cost in USD for this group. */
  totalCostUsd?: number;
}

/**
 * Retention policy that controls how long audit records are kept.
 */
export interface RetentionPolicy {
  /** Default retention in days for records without a severity-specific override. Default: 90. */
  default: number;
  /** Per-severity retention overrides in days. */
  bySeverity: {
    /** Retention for 'info' records. Default: 30 days. */
    info: number;
    /** Retention for 'warning' records. Default: 90 days. */
    warning: number;
    /** Retention for 'critical' records. Default: 365 days. */
    critical: number;
  };
  /** Per-tenant overrides that take precedence over the defaults. */
  tenantOverrides?: Record<
    string,
    {
      default?: number;
      bySeverity?: Partial<RetentionPolicy['bySeverity']>;
    }
  >;
  /** What to do with records that exceed their retention period. */
  onExpire: 'delete' | 'archive';
  /** Filesystem path for archived records (required when `onExpire` is 'archive'). */
  archivePath?: string;
  /** Cron expression for the cleanup job. Default: '0 2 * * *' (2 AM daily). */
  cleanupSchedule: string;
}

/**
 * Result summary returned after a retention cleanup run.
 */
export interface RetentionResult {
  /** Number of records permanently deleted. */
  recordsDeleted: number;
  /** Number of records moved to the archive. */
  recordsArchived: number;
  /** Approximate storage space freed in megabytes. */
  spaceFreedMb: number;
  /** Duration of the cleanup operation in ms. */
  duration: number;
  /** Non-fatal errors encountered during cleanup. */
  errors?: string[];
}

/**
 * Result returned after exporting audit records to a file.
 */
export interface ExportResult {
  /** Number of records included in the export. */
  recordsExported: number;
  /** Absolute path of the generated file. */
  filePath: string;
  /** Size of the generated file in bytes. */
  fileSizeBytes: number;
  /** Export format used (e.g. 'json', 'csv', 'cef'). */
  format: string;
  /** Duration of the export operation in ms. */
  durationMs: number;
  /** Date range covered by the export. */
  dateRange: { from: Date; to: Date };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 5 — HITL (HUMAN-IN-THE-LOOP)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a pending approval action.
 *
 * ### Two-phase approve flow
 * ```
 * pending | escalated
 *   → executing        (claimForExecution — atomic, idempotency fence)
 *   → tool_completed   (tool ran OK AND a resume checkpoint exists)
 *   → resuming         (AgentLoop resume is in flight)
 *   → completed        (resume finished successfully)
 *   → resume_failed    (tool ran OK, but AgentLoop resume threw — retryResume() picks this up)
 *
 * executing → failed   (tool itself threw)
 * pending | escalated → rejected | cancelled | expired
 * ```
 */
export type PendingActionStatus =
  | 'pending' // Awaiting a decision from an approver
  | 'approved' // Approved; tool execution is in progress
  | 'rejected' // Explicitly rejected by an approver
  | 'executing' // Tool is currently running post-approval
  | 'tool_completed' // Tool ran successfully; AgentLoop resume not yet started
  | 'resuming' // AgentLoop resume is in progress
  | 'completed' // Tool executed and AgentLoop resumed successfully
  | 'failed' // Tool threw during post-approval execution
  | 'resume_failed' // Tool succeeded but AgentLoop resume threw — retryable via retryResume()
  | 'expired' // No resolution within the configured timeout
  | 'escalated' // Escalated to the next approval level
  | 'cancelled'; // Cancelled by the original requestor

/**
 * An agent action that has been deferred for human approval.
 * Created by the ApprovalService and persisted until resolved or expired.
 */
export interface PendingAction {
  // ─── Identification ───
  /** UUID unique to this pending action. */
  id: string;
  /** Request that generated this action. */
  requestId: string;
  /** Session in which the action was generated. */
  sessionId: string;
  /** Tenant that owns this action. */
  tenantId: string;

  // ─── Requester ───
  /** User whose agent interaction triggered the action. */
  requestedBy: string;
  /** Agent that attempted to execute the tool. */
  agentId: string;

  // ─── Action Details ───
  /** Name of the tool that requires approval. */
  toolName: string;
  /**
   * Validated input that will be passed to the tool upon approval.
   * Typed as `any` because the shape is tool-specific.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolInput: any;
  /** Human-readable description of what the action does (shown to approvers). */
  description: string;
  /** Explanation of why this action requires approval. */
  reason: string;
  /** Risk level assigned by the matching trigger configuration. */
  risk: 'low' | 'medium' | 'high' | 'critical';

  // ─── Approvers ───
  /** Roles whose members are authorised to approve or reject this action. */
  approverRoles: string[];
  /** Specific users authorised to approve (optional, supplements roles). */
  approverUsers?: string[];
  /** Current escalation level (0 = initial, 1+ = escalated). */
  currentEscalationLevel: number;

  // ─── Status ───
  /** Current lifecycle status. */
  status: PendingActionStatus;
  /** When the action was created. */
  createdAt: Date;
  /** When the action was last updated. */
  updatedAt: Date;
  /** Deadline for resolution; expiry policy applies if this passes unresolved. */
  expiresAt: Date;

  // ─── Resolution ───
  /** Populated when the action is approved, rejected, or expires. */
  resolution?: ActionResolution;

  // ─── Context for Resumption ───
  /** Saved context needed to execute the tool once approved. */
  savedContext: {
    /** Execution context from the original request. */
    executionContext: ExecutionContext;
    /** Agent ID used to reconstruct the agent on resumption. */
    agentConfig: string;
    /** Optional conversation summary for UI display. */
    conversationSummary?: string;
    /**
     * Conversation snapshot at the moment of suspension (after the assistant
     * tool-calling turn, before any tool results). Present only when the run
     * was suspended via the suspend/resume HITL path. Used by
     * `Orchestrator.approve()` to reconstruct the agent loop context.
     */
    messagesSnapshot?: LLMMessage[];
    /**
     * `toolCallId` of the suspended tool call. Required alongside
     * `messagesSnapshot` to inject the real tool result on resumption.
     */
    toolCallId?: string;
    /**
     * Other tool calls that were in the same LLM response turn but were
     * skipped because the current tool was suspended. The resume logic injects
     * DEFERRED placeholders for each so the LLM API receives a result for
     * every call in the assistant turn, then the LLM re-invokes them.
     */
    siblingCalls?: Array<{ id: string; toolName: string }>;
    /**
     * Set to `true` when `messagesSnapshot` was discarded because it exceeded
     * `maxSnapshotBytes`. When `true`, Phase 2 (automatic resume) is not
     * possible — the agent must restart from the post-tool state.
     */
    snapshotTruncated?: boolean;
  };

  /** Arbitrary metadata attached by the host application. */
  metadata?: Record<string, unknown>;
}

/**
 * Resolution record created when an approver decides on a pending action.
 */
export interface ActionResolution {
  /** User ID of the approver who made the decision. */
  resolvedBy: string;
  /** When the decision was recorded. */
  resolvedAt: Date;
  /** The approver's decision. */
  decision: 'approve' | 'reject';
  /** Optional comment from the approver explaining the decision. */
  comment?: string;
  /** Any conditions attached to an approval. */
  conditions?: string;
  /**
   * Modified input provided by the approver (replaces the original `toolInput` when present).
   * Typed as `any` because the shape is tool-specific.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modifiedInput?: any;
  /** Result of the tool execution after approval (populated after execution). */
  toolResult?: ToolResult;
}

/**
 * Summary of a pending action included in an AgentResponse.
 */
export interface PendingActionSummary {
  /** Identifier of the pending action. */
  actionId: string;
  /** Tool that requires approval. */
  toolName: string;
  /** Human-readable description of what the action does. */
  description: string;
  /** Risk level. */
  risk: PendingAction['risk'];
  /** Current status. */
  status: PendingActionStatus;
  /** Deadline for resolution. */
  expiresAt: Date;
}

/**
 * Configuration for a single approval trigger rule.
 */
export interface ApprovalTrigger {
  /** Unique identifier for this trigger. */
  id: string;
  /** Human-readable name for the trigger (used in logs and UI). */
  name: string;
  /** Whether this trigger is currently active. */
  enabled: boolean;
  /** Defines which tools this trigger monitors. */
  scope: {
    /** Monitor only these specific tools. */
    tools?: string[];
    /** Monitor all tools belonging to these skills. */
    skills?: string[];
    /** Monitor all tools with these tags. */
    tags?: string[];
    /** Monitor every tool (use with caution). */
    all?: boolean;
  };
  /** Conditions that must ALL be true (AND) to activate the trigger. */
  conditions: ApprovalCondition[];
  /** Configuration applied when the trigger fires. */
  approvalConfig: {
    /** Roles authorised to approve actions triggered by this rule. */
    approverRoles: string[];
    /** Specific users authorised to approve (supplements roles). */
    approverUsers?: string[];
    /** Risk level assigned to actions created by this trigger. */
    risk: PendingAction['risk'];
    /** Total time limit for resolution in minutes before expiry. Default: 60. */
    timeoutMinutes: number;
    /** Optional escalation ladder. */
    escalation?: EscalationConfig;
  };
  /** Human-readable explanation of why this trigger exists. */
  description: string;
}

/**
 * A single condition within an ApprovalTrigger evaluated before tool execution.
 */
export interface ApprovalCondition {
  /** How to evaluate the condition. */
  type:
    | 'always' // Always requires approval (no field comparison)
    | 'input_field' // Evaluate a field in the tool input
    | 'context_field' // Evaluate a field in the ExecutionContext
    | 'custom'; // Custom evaluation function

  /** Dot-notation path of the field to evaluate (for 'input_field' and 'context_field'). */
  field?: string;
  /** Comparison operator to apply. */
  operator?: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'in' | 'not_in' | 'exists' | 'regex';
  /** Value to compare the field against. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
  /** Custom evaluation function (for type 'custom'). Returns true if approval is required. */
  evaluate?: (
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ) => boolean;
}

/**
 * Escalation configuration for an ApprovalTrigger.
 */
export interface EscalationConfig {
  /** Ordered list of escalation levels (level 1 is first). */
  levels: EscalationLevel[];
}

/**
 * A single level in an escalation ladder.
 */
export interface EscalationLevel {
  /** Numeric level (1 = first escalation, 2 = second, etc.). */
  level: number;
  /** Escalate to this level if unresolved after this many minutes. */
  afterMinutes: number;
  /** Roles that receive the action at this escalation level. */
  approverRoles: string[];
  /** Specific users to notify at this level (supplements roles). */
  approverUsers?: string[];
  /** Notification channels to use when escalating (e.g. 'webhook', 'email', 'event'). */
  notificationChannels: string[];
}

/**
 * Describes how resolution notifications are delivered to the originating system.
 */
export interface ApprovalCallback {
  /** Delivery mechanism for approval notifications. */
  type: 'webhook' | 'event' | 'queue';
  /** URL to POST the resolution payload to (for type 'webhook'). */
  webhookUrl?: string;
  /** Additional HTTP headers for the webhook request. */
  webhookHeaders?: Record<string, string>;
  /** Queue name for asynchronous delivery (for type 'queue'). */
  queueName?: string;
}

/**
 * Information returned by `ApprovalService.requiresApproval()` when a trigger fires.
 */
export interface ApprovalRequirement {
  /** Identifier of the trigger that matched. */
  triggerId: string;
  /** Name of the trigger that matched. */
  triggerName: string;
  /** Risk level assigned by the trigger. */
  risk: PendingAction['risk'];
  /** Roles authorised to approve actions under this trigger. */
  approverRoles: string[];
  /** Human-readable explanation of why approval is required. */
  reason: string;
}

/**
 * Filter used when querying pending actions from the store.
 */
export interface PendingActionFilter {
  /** Filter by tenant. */
  tenantId?: string;
  /** Filter by one or more statuses. */
  status?: PendingActionStatus | PendingActionStatus[];
  /** Return only actions that roles in this list can resolve. */
  approverRoles?: string[];
  /** Filter by the user who originally requested the action. */
  requestedBy?: string;
  /** Filter by originating request ID. */
  requestId?: string;
  /** Filter by agent. */
  agentId?: string;
  /** Filter by risk level. */
  risk?: PendingAction['risk'];
  /** Return only actions created after this date. */
  createdAfter?: Date;
  /** Return only actions created before this date. */
  createdBefore?: Date;
  /** Maximum records to return. */
  limit?: number;
  /** Sort order for the result set. */
  sortBy?: 'createdAt' | 'expiresAt' | 'risk';
}

/**
 * Payload sent via notification channels when an approval event occurs.
 */
export interface Notification {
  /** Type of notification event. */
  type: 'approval_required' | 'action_resolved' | 'escalation' | 'action_expired';
  /** The action this notification is about. */
  action: PendingAction;
  /** Resolution details (only present for 'action_resolved' notifications). */
  resolution?: ActionResolution;
  /** Escalation level reached (only present for 'escalation' notifications). */
  escalationLevel?: number;
  /** Roles that should receive this notification. */
  recipientRoles?: string[];
  /** Specific users that should receive this notification. */
  recipientUsers?: string[];
}

/**
 * Result of a notification dispatch operation.
 */
export interface NotificationResult {
  /** Names of channels through which the notification was successfully sent. */
  channelsSent: string[];
  /** Names of channels that failed to deliver the notification. */
  channelsFailed: string[];
  /** Error details for any failed channels. */
  errors?: string[];
}

/**
 * Policy that governs what happens when a pending action reaches its expiry time.
 */
export interface ExpirationPolicy {
  /** Action taken when a pending action expires without resolution. */
  onExpire: 'expire' | 'auto_reject' | 'auto_approve';
  /** Whether to notify the original requestor upon expiry. Default: true. */
  notifyRequestor: boolean;
  /** Whether to notify the approvers who did not act. Default: true. */
  notifyApprovers: boolean;
  /** How often to check for expired actions in milliseconds. Default: 60000. */
  checkIntervalMs: number;
}

/**
 * Summary returned after a batch escalation processing run.
 */
export interface EscalationResult {
  /** Number of actions escalated to the next level. */
  escalated: number;
  /** Number of actions that expired during this run. */
  expired: number;
}
