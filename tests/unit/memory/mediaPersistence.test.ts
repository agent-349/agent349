import { describe, it, expect, vi } from 'vitest';
import { applyMediaPersistence } from '../../../src/memory/mediaPersistence.js';
import { SessionMemory } from '../../../src/memory/SessionMemory.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import {
  documentFromPath,
  documentFromUrl,
  fromBase64,
  fromProviderFile,
  imageFromBytes,
  text,
} from '../../../src/content/index.js';
import type { LLMMessage, ProviderFileRef } from '../../../src/types/index.js';

const NOW = () => new Date('2026-03-01T10:00:00Z').getTime();

function liveRef(): ProviderFileRef {
  return {
    fileId: 'files/live',
    provider: 'gemini',
    providerType: 'gemini',
    mimeType: 'application/pdf',
    expiresAt: new Date('2026-03-03T10:00:00Z'),
  };
}

function expiredRef(): ProviderFileRef {
  return {
    fileId: 'files/old',
    provider: 'gemini',
    providerType: 'gemini',
    mimeType: 'application/pdf',
    byteLength: 1013,
    expiresAt: new Date('2026-02-01T10:00:00Z'),
  };
}

describe("applyMediaPersistence — 'omit' (default)", () => {
  it('replaces inline bytes with an explicit placeholder, never a silent drop', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          text('extract'),
          imageFromBytes(new Uint8Array(64), 'image/png', undefined, 'a.png'),
        ],
      },
    ];

    const { messages: stored, omitted } = applyMediaPersistence(messages, 'omit', NOW);

    expect(stored[0]!.content).toEqual([
      { type: 'text', text: 'extract' },
      {
        type: 'media_omitted',
        mediaType: 'image',
        mimeType: 'image/png',
        fileName: 'a.png',
        byteLength: 64,
        reason: 'not_persisted',
      },
    ]);
    expect(omitted).toHaveLength(1);
  });

  it('keeps no base64 payload in what gets written', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [fromBase64('c2VjcmV0IHBheWxvYWQ=', 'application/pdf')] },
    ];

    const { messages: stored } = applyMediaPersistence(messages, 'omit', NOW);
    expect(JSON.stringify(stored)).not.toContain('c2VjcmV0');
  });

  it('keeps a live provider file reference: it is small and still usable', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [fromProviderFile(liveRef())] }];

    const { messages: stored, omitted } = applyMediaPersistence(messages, 'omit', NOW);

    expect(stored[0]!.content).toEqual(messages[0]!.content);
    expect(omitted).toEqual([]);
  });

  it('replaces an expired reference so a restored session fails clearly, not confusingly', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: [fromProviderFile(expiredRef())] }];

    const { messages: stored, omitted } = applyMediaPersistence(messages, 'omit', NOW);

    expect(stored[0]!.content).toEqual([
      {
        type: 'media_omitted',
        mediaType: 'document',
        mimeType: 'application/pdf',
        byteLength: 1013,
        reason: 'expired',
      },
    ]);
    expect(omitted[0]!.reason).toBe('expired');
  });

  it('keeps a URL source, which is only a short string', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [documentFromUrl('https://example.com/a.pdf')] },
    ];

    const { omitted } = applyMediaPersistence(messages, 'omit', NOW);
    expect(omitted).toEqual([]);
  });

  it('replaces content read from disk, which would otherwise be inlined', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [documentFromPath('/tmp/invoice.pdf')] },
    ];

    const { omitted } = applyMediaPersistence(messages, 'omit', NOW);
    expect(omitted[0]).toMatchObject({ mediaType: 'document', reason: 'not_persisted' });
  });

  it('leaves text-only messages untouched, by reference', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [text('hi')] },
    ];

    const { messages: stored, omitted } = applyMediaPersistence(messages, 'omit', NOW);

    expect(stored[0]).toBe(messages[0]);
    expect(stored[1]).toBe(messages[1]);
    expect(omitted).toEqual([]);
  });

  it("does not mutate the caller's messages", () => {
    const block = imageFromBytes(new Uint8Array(8), 'image/png');
    const messages: LLMMessage[] = [{ role: 'user', content: [block] }];

    applyMediaPersistence(messages, 'omit', NOW);

    expect(messages[0]!.content).toEqual([block]);
  });
});

describe("applyMediaPersistence — 'full'", () => {
  it('stores everything verbatim when the caller opts in', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [imageFromBytes(new Uint8Array(8), 'image/png')] },
    ];

    const { messages: stored, omitted } = applyMediaPersistence(messages, 'full', NOW);

    expect(stored).toBe(messages);
    expect(omitted).toEqual([]);
  });
});

describe('SessionMemory integration', () => {
  it('omits media by default and reports it, so the loss is traceable', async () => {
    const onMediaOmitted = vi.fn();
    const memory = new SessionMemory(new InMemoryAdapter(), { onMediaOmitted });

    await memory.save('s1', [
      { role: 'user', content: [text('hi'), imageFromBytes(new Uint8Array(32), 'image/png')] },
    ]);

    const loaded = await memory.load('s1');
    expect(loaded[0]!.content).toMatchObject([{ type: 'text' }, { type: 'media_omitted' }]);
    expect(onMediaOmitted).toHaveBeenCalledWith('s1', [
      expect.objectContaining({ mediaType: 'image', reason: 'not_persisted' }),
    ]);
  });

  it("stores binaries verbatim under 'full'", async () => {
    const memory = new SessionMemory(new InMemoryAdapter(), { mediaPersistence: 'full' });

    await memory.save('s1', [
      { role: 'user', content: [imageFromBytes(new Uint8Array([7]), 'image/png')] },
    ]);

    const loaded = await memory.load('s1');
    expect(loaded[0]!.content).toMatchObject([{ type: 'image' }]);
  });

  it('does not call the reporter when nothing was omitted', async () => {
    const onMediaOmitted = vi.fn();
    const memory = new SessionMemory(new InMemoryAdapter(), { onMediaOmitted });

    await memory.save('s1', [{ role: 'user', content: 'plain text' }]);

    expect(onMediaOmitted).not.toHaveBeenCalled();
  });
});
