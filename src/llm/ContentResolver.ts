import { UnsupportedCapabilityError } from '../errors/index.js';
import type {
  ContentBlock,
  FileHandling,
  FileUploadInput,
  MediaBlock,
  ProviderCapabilities,
  ProviderFileRef,
} from '../types/index.js';
import {
  fileNameOf,
  isMediaBlock,
  mimeTypeOf,
  readFileBytes,
  toBase64,
  fromBase64String,
} from '../content/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Binary content the SDK holds, ready for whichever transport the provider
 * needs.
 *
 * `bytes` and `base64` are **lazy and memoised**: reading one computes it once,
 * the other is never computed if nothing asks for it. That matters because the
 * two transports want different things — a provider SDK that takes a file
 * upload wants `bytes`, one that embeds content in JSON wants `base64` — and
 * encoding a 50 MB PDF that is about to be uploaded as a binary would waste
 * ~67 MB of string for nothing. `byteLength` is always cheap: it never forces a
 * decode.
 */
export interface ResolvedInlineContent {
  kind: 'inline';
  /** Raw bytes. Preferred by providers whose SDK uploads binaries directly. */
  readonly bytes: Uint8Array;
  /** Base64 encoding. Preferred by providers that embed content in the body. */
  readonly base64: string;
  /** IANA media type. */
  mimeType: string;
  /** Original file name, when known. */
  fileName?: string;
  /** Size in bytes of the decoded content. */
  byteLength: number;
}

/** Content the provider fetches itself from a URL. */
export interface ResolvedUrlContent {
  kind: 'url';
  url: string;
  mimeType?: string;
  fileName?: string;
}

/** Content stored in the provider's own file store. */
export interface ResolvedFileContent {
  kind: 'providerFile';
  ref: ProviderFileRef;
}

/** How one media block should reach the provider. */
export type ResolvedContent = ResolvedInlineContent | ResolvedUrlContent | ResolvedFileContent;

/** Uploads a file to the provider's file store. */
export type FileUploader = (input: FileUploadInput) => Promise<ProviderFileRef>;

/** Dependencies a {@link ContentResolver} needs from its provider. */
export interface ContentResolverDeps {
  /** Provider instance name (used in errors and reference checks). */
  provider: string;
  /** Adapter type (used to reject references issued by another adapter). */
  providerType: string;
  /** What the provider/model can accept. */
  capabilities: ProviderCapabilities;
  /** Model the request targets (reported in errors). */
  model?: string;
  /**
   * Maximum inline payload the provider accepts, in bytes. Used to fail early
   * with a helpful message under `'inline'`, and to decide when `'auto'`
   * switches to an upload.
   */
  inlineLimitBytes?: number;
  /** Uploads a file; required for `'upload'` and for `'auto'` to escalate. */
  upload?: FileUploader;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** Lightweight descriptor of one media block, safe to log or audit. */
export interface MediaDescriptor {
  /** Modality of the block. */
  kind: MediaBlock['type'];
  /** Media type, when known without reading the content. */
  mimeType?: string;
  /** Where the content comes from. */
  source: 'path' | 'bytes' | 'url' | 'providerFile' | 'base64';
  /** Size in bytes, when known without reading the content. */
  byteLength?: number;
  /** File name, when known. */
  fileName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ContentResolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turns an application-facing {@link ContentSource} into the transport a
 * provider actually accepts.
 *
 * This is where the SDK — not the calling application — decides whether content
 * travels inline, is uploaded to a file store, or is passed as a reference.
 * Applications hand over a path, a buffer, a URL or a previous reference and
 * never deal with base64 or upload mechanics.
 *
 * Two guarantees the rest of the LLM layer depends on:
 *
 * - **Nothing is dropped silently.** A modality the provider cannot accept, a
 *   URL it will not fetch, or a file reference issued by a different provider
 *   raises {@link UnsupportedCapabilityError} instead of vanishing from the
 *   prompt.
 * - **Work happens once per block.** Results are memoised by block identity, so
 *   an agent loop that sends the same attachment across ten iterations reads
 *   and encodes it once.
 *
 * @example
 * ```typescript
 * const resolver = new ContentResolver({
 *   provider: 'gemini', providerType: 'gemini',
 *   capabilities, upload: (input) => provider.uploadFile(input),
 * });
 * const resolved = await resolver.resolve(block, 'auto');
 * ```
 */
export class ContentResolver {
  readonly #deps: ContentResolverDeps;
  readonly #cache = new WeakMap<MediaBlock, ResolvedContent>();
  readonly #uploaded: ProviderFileRef[] = [];
  readonly #now: () => Date;

  /**
   * @param deps - Provider identity, capabilities and optional uploader.
   */
  constructor(deps: ContentResolverDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /** References created by this resolver while serving the current request. */
  get uploadedFiles(): ProviderFileRef[] {
    return [...this.#uploaded];
  }

  /**
   * Resolves one media block to its wire representation.
   *
   * @param block        - The block to resolve.
   * @param fileHandling - Transport policy for binary content.
   * @throws {@link UnsupportedCapabilityError} when the provider cannot accept
   *         the block's modality or source.
   */
  async resolve(
    block: MediaBlock,
    fileHandling: FileHandling = 'inline',
  ): Promise<ResolvedContent> {
    const cached = this.#cache.get(block);
    if (cached !== undefined) return cached;

    this.#assertModality(block);
    const resolved = await this.#resolveSource(block, fileHandling);
    this.#cache.set(block, resolved);
    return resolved;
  }

  /**
   * Describes the media blocks in a message list without reading any content.
   * Used for observability: counts, types and sizes — never payloads.
   *
   * @param blocks - Content blocks to inspect.
   */
  static describe(blocks: ContentBlock[]): MediaDescriptor[] {
    const out: MediaDescriptor[] = [];
    for (const block of blocks) {
      if (!isMediaBlock(block)) continue;
      const mimeType = mimeTypeOf(block);
      const fileName = fileNameOf(block);
      const byteLength =
        block.source.kind === 'bytes'
          ? block.source.bytes.byteLength
          : block.source.kind === 'base64'
            ? Math.floor((block.source.data.length * 3) / 4)
            : block.source.kind === 'providerFile'
              ? block.source.ref.byteLength
              : undefined;
      out.push({
        kind: block.type,
        source: block.source.kind,
        ...(mimeType !== undefined && { mimeType }),
        ...(fileName !== undefined && { fileName }),
        ...(byteLength !== undefined && { byteLength }),
      });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Rejects a modality the provider/model does not accept as input. */
  #assertModality(block: MediaBlock): void {
    const supported = this.#deps.capabilities.input[block.type];
    if (supported) return;
    throw new UnsupportedCapabilityError(
      this.#deps.provider,
      `input.${block.type}`,
      `the model does not accept ${block.type} input`,
      this.#deps.model,
    );
  }

  async #resolveSource(block: MediaBlock, fileHandling: FileHandling): Promise<ResolvedContent> {
    const { source } = block;

    if (source.kind === 'url') {
      if (!this.#deps.capabilities.sources.url) {
        throw new UnsupportedCapabilityError(
          this.#deps.provider,
          'sources.url',
          `this provider does not fetch URLs. Pass the content as bytes or a path, ` +
            `or upload it first and reference the returned file. The SDK never ` +
            `downloads URLs on your behalf.`,
          this.#deps.model,
        );
      }
      // Prefer the inferred type: several providers require a media type
      // alongside a URI, and the extension is usually enough to supply one.
      const mimeType = mimeTypeOf(block);
      return {
        kind: 'url',
        url: source.url,
        ...(mimeType !== undefined && { mimeType }),
        ...(source.fileName !== undefined && { fileName: source.fileName }),
      };
    }

    if (source.kind === 'providerFile') {
      this.#assertUsableReference(source.ref);
      return { kind: 'providerFile', ref: source.ref };
    }

    // path / bytes / base64 → binary content the SDK owns.
    const inline = await this.#toInline(block);
    return this.#applyFileHandling(inline, fileHandling);
  }

  /** Rejects references issued by another provider, or already expired. */
  #assertUsableReference(ref: ProviderFileRef): void {
    if (!this.#deps.capabilities.sources.providerFile) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'sources.providerFile',
        'this provider cannot reference previously uploaded files',
        this.#deps.model,
      );
    }
    if (ref.providerType !== this.#deps.providerType) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'sources.providerFile',
        `file '${ref.fileId}' was uploaded to a '${ref.providerType}' provider and ` +
          `cannot be reused by '${this.#deps.providerType}'. File references are ` +
          `provider-scoped: upload the content again for this provider.`,
        this.#deps.model,
      );
    }
    if (ref.expiresAt !== undefined && ref.expiresAt.getTime() <= this.#now().getTime()) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'sources.providerFile',
        `file '${ref.fileId}' expired at ${ref.expiresAt.toISOString()}. ` +
          `Upload the content again to obtain a fresh reference.`,
        this.#deps.model,
      );
    }
  }

  /** Materialises path/bytes/base64 content as bytes plus its base64 form. */
  async #toInline(block: MediaBlock): Promise<ResolvedInlineContent> {
    const { source } = block;

    // Validate before doing any I/O: a block the provider could never accept
    // should not cost a file read first.
    const mimeType = mimeTypeOf(block);
    if (mimeType === undefined) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'mimeType',
        `the media type could not be inferred for this ${block.type} block. ` +
          `Pass it explicitly when building the block.`,
        this.#deps.model,
      );
    }

    let known: { bytes?: Uint8Array; base64?: string };

    if (source.kind === 'path') {
      known = { bytes: await readFileBytes(source.path) };
    } else if (source.kind === 'bytes') {
      known = { bytes: source.bytes };
    } else if (source.kind === 'base64') {
      known = { base64: source.data };
    } else {
      // Unreachable: url/providerFile are handled before this point.
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'sources',
        `unsupported content source '${source.kind}'`,
        this.#deps.model,
      );
    }

    const fileName = fileNameOf(block);
    return ContentResolver.#makeInline(known, mimeType, fileName);
  }

  /**
   * Builds inline content whose two representations are computed on demand.
   *
   * Only the form the provider actually reads gets built: an upload never pays
   * for a base64 encoding, and content that arrives already encoded is never
   * decoded just to be re-embedded.
   */
  static #makeInline(
    known: { bytes?: Uint8Array; base64?: string },
    mimeType: string,
    fileName: string | undefined,
  ): ResolvedInlineContent {
    let bytes = known.bytes;
    let base64 = known.base64;

    return {
      kind: 'inline',
      get bytes(): Uint8Array {
        bytes ??= fromBase64String(base64!);
        return bytes;
      },
      get base64(): string {
        base64 ??= toBase64(bytes!);
        return base64;
      },
      mimeType,
      // Derived arithmetically for base64 so the inline-size check — which runs
      // on every request — never triggers a decode.
      byteLength: bytes?.byteLength ?? ContentResolver.#decodedLength(base64!),
      ...(fileName !== undefined && { fileName }),
    };
  }

  /** Decoded size of a base64 payload, without decoding it. */
  static #decodedLength(base64: string): number {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  }

  /** Applies the transport policy to binary content the SDK holds. */
  async #applyFileHandling(
    inline: ResolvedInlineContent,
    fileHandling: FileHandling,
  ): Promise<ResolvedContent> {
    const limit = this.#deps.inlineLimitBytes;
    const exceedsLimit = limit !== undefined && inline.byteLength > limit;

    if (fileHandling === 'upload') return this.#upload(inline);
    if (fileHandling === 'auto' && exceedsLimit) return this.#upload(inline);

    if (exceedsLimit) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'inlineSizeLimit',
        `content of ${String(inline.byteLength)} bytes exceeds the inline limit of ` +
          `${String(limit)} bytes. Use fileHandling: 'auto' or 'upload' to send it ` +
          `through the provider's file API.`,
        this.#deps.model,
      );
    }
    return inline;
  }

  /** Uploads content and records the resulting reference. */
  async #upload(inline: ResolvedInlineContent): Promise<ResolvedFileContent> {
    const upload = this.#deps.upload;
    if (upload === undefined || !this.#deps.capabilities.files) {
      throw new UnsupportedCapabilityError(
        this.#deps.provider,
        'files',
        'this provider has no file API, so content cannot be uploaded',
        this.#deps.model,
      );
    }
    const ref = await upload({
      content: { kind: 'bytes', bytes: inline.bytes },
      mimeType: inline.mimeType,
      ...(inline.fileName !== undefined && { fileName: inline.fileName }),
      purpose: 'input',
    });
    this.#uploaded.push(ref);
    return { kind: 'providerFile', ref };
  }
}
