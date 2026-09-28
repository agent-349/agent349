import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type {
  ContentBlock,
  ContentSource,
  MediaBlock,
  MediaKind,
  MediaBlockOptions,
  MessageContent,
  ProviderFileRef,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MIME types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extension → media type map used when a `path` source omits `mimeType`.
 * Deliberately small: it covers what current models accept as direct input.
 * Anything else must declare its media type explicitly.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
};

/**
 * Infers a media type from a file name or path extension.
 *
 * @param fileNameOrPath - File name or path (only the extension is read).
 * @returns The media type, or `undefined` when the extension is unknown.
 */
export function mimeTypeFromPath(fileNameOrPath: string): string | undefined {
  return MIME_BY_EXTENSION[extname(fileNameOrPath).toLowerCase()];
}

/**
 * Infers the modality a media type belongs to.
 *
 * @param mimeType - IANA media type.
 * @returns `'image'`, `'audio'`, `'video'`, or `'document'` for everything else.
 */
export function mediaKindFromMimeType(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

// ─────────────────────────────────────────────────────────────────────────────
// Block builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a text block.
 *
 * @param value - Text content.
 */
export function text(value: string): TextBlock {
  return { type: 'text', text: value };
}

/** Builds a media block of an explicit kind from any source. */
function media(kind: MediaKind, source: ContentSource, options?: MediaBlockOptions): MediaBlock {
  return { type: kind, source, ...(options !== undefined && { options }) };
}

/**
 * Builds an image block from a file on disk. The media type is inferred from
 * the extension unless given.
 *
 * @param path     - Path to the image file.
 * @param options  - Optional per-block provider hints.
 * @param mimeType - Explicit media type, when the extension is unknown.
 */
export function imageFromPath(
  path: string,
  options?: MediaBlockOptions,
  mimeType?: string,
): MediaBlock {
  return media(
    'image',
    { kind: 'path', path, ...(mimeType !== undefined && { mimeType }), fileName: basename(path) },
    options,
  );
}

/**
 * Builds an image block from in-memory bytes.
 *
 * @param bytes    - Image content.
 * @param mimeType - Media type of the content (e.g. `'image/png'`).
 * @param options  - Optional per-block provider hints.
 * @param fileName - Optional original file name.
 */
export function imageFromBytes(
  bytes: Uint8Array,
  mimeType: string,
  options?: MediaBlockOptions,
  fileName?: string,
): MediaBlock {
  return media(
    'image',
    { kind: 'bytes', bytes, mimeType, ...(fileName !== undefined && { fileName }) },
    options,
  );
}

/**
 * Builds an image block from a URL. The **provider** fetches it; the SDK never
 * downloads the URL itself.
 *
 * @param url      - Publicly reachable URL.
 * @param options  - Optional per-block provider hints.
 * @param mimeType - Explicit media type, when it cannot be inferred.
 */
export function imageFromUrl(
  url: string,
  options?: MediaBlockOptions,
  mimeType?: string,
): MediaBlock {
  return media('image', { kind: 'url', url, ...(mimeType !== undefined && { mimeType }) }, options);
}

/**
 * Builds a document block from a file on disk (PDF, text, CSV, …).
 *
 * @param path     - Path to the document.
 * @param options  - Optional per-block provider hints.
 * @param mimeType - Explicit media type, when the extension is unknown.
 */
export function documentFromPath(
  path: string,
  options?: MediaBlockOptions,
  mimeType?: string,
): MediaBlock {
  return media(
    'document',
    { kind: 'path', path, ...(mimeType !== undefined && { mimeType }), fileName: basename(path) },
    options,
  );
}

/**
 * Builds a document block from in-memory bytes.
 *
 * @param bytes    - Document content.
 * @param mimeType - Media type (e.g. `'application/pdf'`).
 * @param options  - Optional per-block provider hints.
 * @param fileName - Optional original file name.
 */
export function documentFromBytes(
  bytes: Uint8Array,
  mimeType: string,
  options?: MediaBlockOptions,
  fileName?: string,
): MediaBlock {
  return media(
    'document',
    { kind: 'bytes', bytes, mimeType, ...(fileName !== undefined && { fileName }) },
    options,
  );
}

/**
 * Builds a document block from a URL fetched by the provider.
 *
 * @param url      - Publicly reachable URL.
 * @param options  - Optional per-block provider hints.
 * @param mimeType - Explicit media type, when it cannot be inferred.
 */
export function documentFromUrl(
  url: string,
  options?: MediaBlockOptions,
  mimeType?: string,
): MediaBlock {
  return media(
    'document',
    { kind: 'url', url, ...(mimeType !== undefined && { mimeType }) },
    options,
  );
}

/**
 * Builds a block referencing a file already uploaded to a provider.
 *
 * The modality is inferred from the reference's media type when it is known,
 * and defaults to `'document'` otherwise.
 *
 * @param ref     - Reference returned by `uploadFile()`.
 * @param options - Optional per-block provider hints.
 */
export function fromProviderFile(ref: ProviderFileRef, options?: MediaBlockOptions): MediaBlock {
  const kind = ref.mimeType !== undefined ? mediaKindFromMimeType(ref.mimeType) : 'document';
  return media(kind, { kind: 'providerFile', ref }, options);
}

/**
 * Builds a media block from pre-encoded base64 content.
 *
 * Provided for interop with callers that already hold base64 (an HTTP upload, a
 * queue payload). Prefer the path/bytes/URL builders: how content reaches the
 * wire is the SDK's decision, not the application's.
 *
 * @param data     - Base64 payload, without a `data:` prefix.
 * @param mimeType - Media type of the encoded content.
 * @param kind     - Modality; inferred from `mimeType` when omitted.
 * @param fileName - Optional original file name.
 */
export function fromBase64(
  data: string,
  mimeType: string,
  kind?: MediaKind,
  fileName?: string,
): MediaBlock {
  return media(kind ?? mediaKindFromMimeType(mimeType), {
    kind: 'base64',
    data,
    mimeType,
    ...(fileName !== undefined && { fileName }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspection helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Narrows a block to the media variants. */
export function isMediaBlock(block: ContentBlock): block is MediaBlock {
  return (
    block.type === 'image' ||
    block.type === 'document' ||
    block.type === 'audio' ||
    block.type === 'video'
  );
}

/** Narrows a block to `tool_use`. */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/** Narrows a block to `tool_result`. */
export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

/**
 * Media type declared by a block's source, when it is known without reading it.
 *
 * @param block - A media block.
 */
export function mimeTypeOf(block: MediaBlock): string | undefined {
  const { source } = block;
  switch (source.kind) {
    case 'bytes':
    case 'base64':
      return source.mimeType;
    case 'path':
      return source.mimeType ?? mimeTypeFromPath(source.path);
    case 'url':
      return source.mimeType ?? mimeTypeFromPath(source.url);
    case 'providerFile':
      return source.ref.mimeType;
  }
}

/** Original file name carried by a block's source, when known. */
export function fileNameOf(block: MediaBlock): string | undefined {
  const { source } = block;
  switch (source.kind) {
    case 'bytes':
    case 'base64':
    case 'url':
      return source.fileName;
    case 'path':
      return source.fileName ?? basename(source.path);
    case 'providerFile':
      return source.ref.fileName;
  }
}

/**
 * Flattens message content to plain text.
 *
 * Used wherever a text view of a message is needed — prompt-injection
 * detection, summarisation, audit metadata — without ever touching binaries.
 * Non-text blocks are rendered as short, explicit descriptors.
 *
 * @param content - Message content (string or blocks).
 */
export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'document':
      case 'audio':
      case 'video': {
        const mime = mimeTypeOf(block) ?? 'unknown';
        const name = fileNameOf(block);
        parts.push(`[${block.type}${name !== undefined ? ` '${name}'` : ''} (${mime})]`);
        break;
      }
      case 'media_omitted':
        parts.push(describeOmitted(block));
        break;
      case 'tool_use':
        parts.push(`[tool_use ${block.toolName}]`);
        break;
      case 'tool_result':
        parts.push(block.content);
        break;
    }
  }
  return parts.join('\n');
}

/**
 * Renders a {@link MediaOmittedBlock} as the explicit note providers send to
 * the model in place of the missing content.
 *
 * Keeping this visible — instead of dropping the block — is what stops a
 * restored session from silently losing a document the model was reasoning
 * about.
 */
export function describeOmitted(block: Extract<ContentBlock, { type: 'media_omitted' }>): string {
  const name = block.fileName !== undefined ? ` '${block.fileName}'` : '';
  const why =
    block.reason === 'expired'
      ? 'the provider file reference has expired'
      : 'it was not persisted with the conversation';
  return `[${block.mediaType}${name} (${block.mimeType}) is no longer available: ${why}]`;
}

/**
 * Normalises a caller-supplied message body into content blocks.
 *
 * @param content - A plain string or an already-built block list.
 */
export function toBlocks(content: MessageContent): ContentBlock[] {
  return typeof content === 'string' ? [text(content)] : content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a file from disk into memory.
 *
 * Kept here so `ContentResolver` is the only place that touches the filesystem
 * on behalf of a `path` source.
 *
 * @param path - Path to read.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

/** Encodes bytes as base64, the inline transport every provider accepts. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decodes a base64 payload into bytes. */
export function fromBase64String(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}
