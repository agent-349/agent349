import type {
  BatchJob,
  BatchRequestItem,
  BatchResultItem,
  BatchSubmitOptions,
  FileUploadInput,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ProviderFileRef,
  ProviderProbe,
} from '../types/index.js';

/**
 * Abstract base class for all LLM provider implementations.
 *
 * Concrete providers (Claude, OpenAI, Gemini, Ollama) extend this class and
 * translate the SDK's normalised {@link LLMRequest} / {@link LLMResponse} types
 * to and from the provider-specific wire format.
 *
 * Optional capabilities — file storage and batch processing — are **not** part
 * of this class. They are separate interfaces ({@link FileCapableProvider},
 * {@link BatchCapableProvider}) a provider implements when it has them, so the
 * type system, not a runtime error, tells callers what is available.
 *
 * @example
 * ```typescript
 * class MyProvider extends LLMProvider {
 *   readonly name = 'my-instance';
 *   readonly providerType = 'my-adapter';
 *   async call(request: LLMRequest): Promise<LLMResponse> { ... }
 *   async validate(): Promise<ProviderProbe> { ... }
 *   async listModels(): Promise<string[]> { ... }
 *   capabilities(): ProviderCapabilities { return textOnlyCapabilities(); }
 * }
 * ```
 */
export abstract class LLMProvider {
  /**
   * Instance identity: the router key, and the value reported in
   * `LLMResponse.provider`, metrics, audit records and errors.
   */
  abstract readonly name: string;

  /**
   * Adapter type backing this instance (`'claude'`, `'openai'`, `'gemini'`,
   * `'ollama'`, or a custom type). Several instances may share a type.
   *
   * Distinct from {@link name}: the type selects which entry of
   * `LLMRequest.providerOptions` applies, and lets metrics be grouped by
   * adapter rather than by deployment.
   */
  abstract readonly providerType: string;

  /**
   * Sends a request to the LLM and returns the normalised response.
   *
   * @param request - Prompt, messages, tools, and generation parameters.
   * @returns Normalised {@link LLMResponse} including usage stats and any tool calls.
   * @throws {@link ProviderError} on authentication or network failures.
   * @throws {@link UnsupportedCapabilityError} when the request needs something
   *         this provider or model cannot do.
   */
  abstract call(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Verifies that the provider is reachable and correctly configured.
   *
   * Implementations must not throw: a failed probe is reported as
   * `{ ok: false, error }` so callers can log *why* the provider is unusable.
   *
   * @returns `{ ok: true }` when operational, `{ ok: false, error }` otherwise.
   */
  abstract validate(): Promise<ProviderProbe>;

  /**
   * Returns the list of model identifiers available through this provider.
   */
  abstract listModels(): Promise<string[]>;

  /**
   * Declares what this provider — optionally narrowed to one model — can do.
   *
   * The SDK consults this before translating a request, so an unsupported
   * modality or output format fails with {@link UnsupportedCapabilityError}
   * instead of being silently stripped from the prompt. It also stops the
   * {@link LLMRouter} from falling back to a provider that cannot serve the
   * request.
   *
   * Declare honestly: over-declaring turns a clear SDK error into an opaque
   * provider error.
   *
   * @param model - Model the capabilities are queried for, when they differ per model.
   */
  abstract capabilities(model?: string): ProviderCapabilities;
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional capability interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider that can store files and reference them by id.
 *
 * References are provider-scoped and may expire (Gemini deletes uploads after
 * 48 h); see {@link ProviderFileRef}.
 */
export interface FileCapableProvider {
  /**
   * Uploads a file to the provider's file store.
   *
   * @param input - File content plus its media type and optional name.
   * @returns A reference usable as a `providerFile` content source.
   */
  uploadFile(input: FileUploadInput): Promise<ProviderFileRef>;

  /**
   * Retrieves the current state of a stored file (including its expiry).
   *
   * @param fileId - Identifier returned by {@link uploadFile}.
   */
  getFile(fileId: string): Promise<ProviderFileRef>;

  /**
   * Deletes a stored file.
   *
   * @param fileId - Identifier returned by {@link uploadFile}.
   */
  deleteFile(fileId: string): Promise<void>;
}

/**
 * A provider that can run requests asynchronously as a batch job.
 *
 * A batch has a lifecycle of its own — submit, poll, collect, cancel — that is
 * deliberately kept out of {@link LLMProvider.call}: there is no streaming, no
 * circuit breaking and no agent loop around it. The unit of work is still an
 * {@link LLMRequest}, so content, structured output and provider options are
 * expressed exactly as in a synchronous call.
 *
 * The SDK runs no timers and does no automatic polling: the application owns
 * the `jobId` and decides when to check on it.
 */
export interface BatchCapableProvider {
  /**
   * Submits a set of requests for asynchronous processing.
   *
   * @param items   - Requests, each tagged with a stable `customId`.
   * @param options - Optional job name and default model.
   * @returns The created job. Persist `jobId` to poll it later.
   */
  submitBatch(items: BatchRequestItem[], options?: BatchSubmitOptions): Promise<BatchJob>;

  /**
   * Reads the current state of a job.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  getBatch(jobId: string): Promise<BatchJob>;

  /**
   * Streams the results of a finished job, one item at a time.
   *
   * Iterating instead of returning an array keeps memory flat for jobs with
   * tens of thousands of documents. Each item carries the originating
   * `customId`, since providers do not guarantee result order, and reports an
   * individual success or failure — a job can end successfully with some items
   * failed, so only those need reprocessing.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  streamBatchResults(jobId: string): AsyncIterable<BatchResultItem>;

  /**
   * Requests cancellation of a job that has not finished.
   *
   * @param jobId - Identifier returned by {@link submitBatch}.
   */
  cancelBatch(jobId: string): Promise<void>;
}

/**
 * Narrows a provider to one that supports file storage.
 *
 * @param provider - The provider to test.
 */
export function supportsFiles(
  provider: LLMProvider,
): provider is LLMProvider & FileCapableProvider {
  return (
    typeof (provider as Partial<FileCapableProvider>).uploadFile === 'function' &&
    provider.capabilities().files
  );
}

/**
 * Narrows a provider to one that supports batch processing.
 *
 * @param provider - The provider to test.
 */
export function supportsBatch(
  provider: LLMProvider,
): provider is LLMProvider & BatchCapableProvider {
  return (
    typeof (provider as Partial<BatchCapableProvider>).submitBatch === 'function' &&
    provider.capabilities().batch
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capabilities of a plain text-only provider: streaming and tool calling, no
 * media, no structured output, no files, no batch.
 *
 * Use as the base for a custom provider and override what it actually adds:
 *
 * ```typescript
 * capabilities(): ProviderCapabilities {
 *   return { ...textOnlyCapabilities(), input: { ...textOnlyCapabilities().input, image: true } };
 * }
 * ```
 */
export function textOnlyCapabilities(): ProviderCapabilities {
  return {
    streaming: true,
    toolCalling: true,
    input: { text: true, image: false, document: false, audio: false, video: false },
    sources: { url: false, providerFile: false },
    structuredOutput: 'none',
    structuredOutputWithTools: false,
    files: false,
    batch: false,
  };
}
