import type { ContentBlock, LLMMessage, MediaOmittedBlock } from '../types/index.js';
import { fileNameOf, isMediaBlock, mimeTypeOf } from '../content/index.js';

/**
 * What happens to binary content when a conversation is written to a store.
 *
 * - `'omit'` (default) — inline content (bytes, base64, a file read from disk)
 *   is **not** written. It is replaced by an explicit
 *   {@link MediaOmittedBlock}, and provider file references — which are small,
 *   reusable and re-fetchable — are kept.
 * - `'full'` — everything is written verbatim. Only appropriate when the store
 *   can take it: a base64 PDF is megabytes per turn, against MongoDB's 16 MB
 *   document ceiling and Redis' memory budget, and it is re-sent on every
 *   iteration of the loop.
 *
 * Neither mode drops content silently. Under `'omit'` the placeholder stays in
 * the history, is visible to the application, and is rendered to the model as
 * an explicit note on the next turn — so a restored conversation can never
 * quietly lose the document it was reasoning about.
 */
export type MediaPersistence = 'omit' | 'full';

/** Details of one omission, for observability. */
export interface OmittedMedia {
  /** Modality of the omitted content. */
  mediaType: MediaOmittedBlock['mediaType'];
  /** Media type of the omitted content. */
  mimeType: string;
  /** Why it was omitted. */
  reason: MediaOmittedBlock['reason'];
  /** Size in bytes, when known. */
  byteLength?: number;
  /** File name, when known. */
  fileName?: string;
}

/** Result of applying the persistence policy to a message list. */
export interface MediaPersistenceResult {
  /** The messages to write, with inline media replaced where applicable. */
  messages: LLMMessage[];
  /** One entry per omitted block; empty when nothing was replaced. */
  omitted: OmittedMedia[];
}

/**
 * Applies the media persistence policy to a conversation about to be stored.
 *
 * Input messages are not mutated: a message that needs no change is passed
 * through by reference, and only the ones carrying inline media are rebuilt.
 *
 * @param messages - Conversation to persist.
 * @param policy   - Persistence mode. Defaults to `'omit'`.
 * @param now      - Clock, injectable for tests.
 */
export function applyMediaPersistence(
  messages: LLMMessage[],
  policy: MediaPersistence = 'omit',
  now: () => number = Date.now,
): MediaPersistenceResult {
  if (policy === 'full') return { messages, omitted: [] };

  const omitted: OmittedMedia[] = [];
  const out = messages.map((message) => {
    if (typeof message.content === 'string') return message;

    let changed = false;
    const blocks = message.content.map((block) => {
      const replacement = toPlaceholder(block, now);
      if (replacement === undefined) return block;
      changed = true;
      omitted.push({
        mediaType: replacement.mediaType,
        mimeType: replacement.mimeType,
        reason: replacement.reason,
        ...(replacement.byteLength !== undefined && { byteLength: replacement.byteLength }),
        ...(replacement.fileName !== undefined && { fileName: replacement.fileName }),
      });
      return replacement;
    });

    return changed ? { ...message, content: blocks } : message;
  });

  return { messages: out, omitted };
}

/**
 * Returns the placeholder a block should be persisted as, or `undefined` when
 * the block can be stored unchanged.
 *
 * A provider file reference is kept — it is a few dozen bytes and points at
 * content the provider still holds — unless it has already expired, in which
 * case storing it would set up a confusing failure on the next turn.
 */
function toPlaceholder(block: ContentBlock, now: () => number): MediaOmittedBlock | undefined {
  if (!isMediaBlock(block)) return undefined;

  const mimeType = mimeTypeOf(block) ?? 'application/octet-stream';
  const fileName = fileNameOf(block);

  if (block.source.kind === 'providerFile') {
    const expiresAt = block.source.ref.expiresAt;
    if (expiresAt === undefined || expiresAt.getTime() > now()) return undefined;
    return {
      type: 'media_omitted',
      mediaType: block.type,
      mimeType,
      reason: 'expired',
      ...(fileName !== undefined && { fileName }),
      ...(block.source.ref.byteLength !== undefined && {
        byteLength: block.source.ref.byteLength,
      }),
    };
  }

  // A URL is a short string the provider fetches itself: keep it.
  if (block.source.kind === 'url') return undefined;

  const byteLength =
    block.source.kind === 'bytes'
      ? block.source.bytes.byteLength
      : block.source.kind === 'base64'
        ? Math.floor((block.source.data.length * 3) / 4)
        : undefined;

  return {
    type: 'media_omitted',
    mediaType: block.type,
    mimeType,
    reason: 'not_persisted',
    ...(fileName !== undefined && { fileName }),
    ...(byteLength !== undefined && { byteLength }),
  };
}
