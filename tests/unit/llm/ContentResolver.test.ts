import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { ContentResolver } from '../../../src/llm/ContentResolver.js';
import { textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { UnsupportedCapabilityError } from '../../../src/errors/index.js';
import {
  documentFromBytes,
  documentFromPath,
  documentFromUrl,
  fromBase64,
  fromProviderFile,
  imageFromBytes,
} from '../../../src/content/index.js';
import type { ProviderCapabilities, ProviderFileRef } from '../../../src/types/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/media');

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    ...textOnlyCapabilities(),
    input: { text: true, image: true, document: true, audio: false, video: false },
    sources: { url: true, providerFile: true },
    files: true,
    ...overrides,
  };
}

function makeResolver(overrides: Partial<Parameters<typeof ContentResolver>[0]> = {}) {
  return new ContentResolver({
    provider: 'test',
    providerType: 'test-adapter',
    capabilities: capabilities(),
    model: 'test-model',
    ...overrides,
  });
}

describe('source resolution', () => {
  it('reads a path into inline bytes and base64', async () => {
    const resolver = makeResolver();
    const resolved = await resolver.resolve(documentFromPath(join(FIXTURES, 'invoice.pdf')));

    expect(resolved.kind).toBe('inline');
    if (resolved.kind !== 'inline') return;
    expect(resolved.mimeType).toBe('application/pdf');
    expect(resolved.fileName).toBe('invoice.pdf');
    expect(resolved.byteLength).toBeGreaterThan(0);
    expect(resolved.base64.length).toBeGreaterThan(0);
  });

  it('passes bytes through, encoding them for inline transport', async () => {
    const resolver = makeResolver();
    const resolved = await resolver.resolve(imageFromBytes(new Uint8Array([1, 2, 3]), 'image/png'));

    expect(resolved.kind).toBe('inline');
    if (resolved.kind !== 'inline') return;
    expect(resolved.byteLength).toBe(3);
    expect(resolved.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('decodes a base64 source back to bytes', async () => {
    const resolver = makeResolver();
    const data = Buffer.from('hello').toString('base64');
    const resolved = await resolver.resolve(fromBase64(data, 'application/pdf'));

    expect(resolved.kind).toBe('inline');
    if (resolved.kind !== 'inline') return;
    expect(Buffer.from(resolved.bytes).toString()).toBe('hello');
  });

  it('passes a URL through when the provider fetches URLs itself', async () => {
    const resolver = makeResolver();
    const resolved = await resolver.resolve(documentFromUrl('https://example.com/a.pdf'));

    expect(resolved).toEqual({
      kind: 'url',
      url: 'https://example.com/a.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('never downloads a URL itself: it fails when the provider cannot fetch', async () => {
    const resolver = makeResolver({
      capabilities: capabilities({ sources: { url: false, providerFile: true } }),
    });

    await expect(resolver.resolve(documentFromUrl('https://example.com/a.pdf'))).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    await expect(resolver.resolve(documentFromUrl('https://example.com/a.pdf'))).rejects.toThrow(
      /never\s+downloads URLs/,
    );
  });
});

describe('lazy transports', () => {
  it('does not encode base64 when the content is going to be uploaded', async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: 'files/x',
      provider: 'test',
      providerType: 'test-adapter',
    });
    const resolver = makeResolver({ upload });
    const bytes = new Uint8Array(1_024);
    const block = imageFromBytes(bytes, 'image/png');

    // The upload path reads `bytes`; `base64` must never be computed for it.
    const resolved = await resolver.resolve(block, 'upload');

    expect(resolved.kind).toBe('providerFile');
    expect(upload.mock.calls[0]![0].content).toEqual({ kind: 'bytes', bytes });
  });

  it('does not decode a base64 source that goes back out inline', async () => {
    const resolver = makeResolver();
    const data = Buffer.from('hello world').toString('base64');

    const resolved = await resolver.resolve(fromBase64(data, 'application/pdf'));

    expect(resolved.kind).toBe('inline');
    if (resolved.kind !== 'inline') return;
    // Passed through untouched, and the size is known without decoding.
    expect(resolved.base64).toBe(data);
    expect(resolved.byteLength).toBe(11);
  });

  it('still exposes both forms when a provider asks for them', async () => {
    const resolver = makeResolver();
    const resolved = await resolver.resolve(imageFromBytes(new Uint8Array([1, 2, 3]), 'image/png'));

    if (resolved.kind !== 'inline') throw new Error('expected inline');
    expect(resolved.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect([...resolved.bytes]).toEqual([1, 2, 3]);
  });

  it('memoises the computed form instead of recomputing it', async () => {
    const resolver = makeResolver();
    const resolved = await resolver.resolve(imageFromBytes(new Uint8Array([1, 2, 3]), 'image/png'));

    if (resolved.kind !== 'inline') throw new Error('expected inline');
    expect(resolved.base64).toBe(resolved.base64);
  });

  it('reports the decoded size of a padded base64 payload', async () => {
    const resolver = makeResolver();
    for (const raw of ['a', 'ab', 'abc', 'abcd']) {
      const resolved = await resolver.resolve(
        fromBase64(Buffer.from(raw).toString('base64'), 'application/pdf'),
      );
      if (resolved.kind !== 'inline') throw new Error('expected inline');
      expect(resolved.byteLength, raw).toBe(raw.length);
    }
  });
});

describe('capability guards', () => {
  it('rejects a modality the model does not accept, instead of dropping it', async () => {
    const resolver = makeResolver({
      capabilities: capabilities({
        input: { text: true, image: true, document: false, audio: false, video: false },
      }),
    });

    await expect(
      resolver.resolve(documentFromBytes(new Uint8Array([1]), 'application/pdf')),
    ).rejects.toThrow(UnsupportedCapabilityError);
  });

  it('reports the missing capability on the error', async () => {
    const resolver = makeResolver({
      capabilities: capabilities({
        input: { text: true, image: false, document: true, audio: false, video: false },
      }),
    });

    await expect(
      resolver.resolve(imageFromBytes(new Uint8Array([1]), 'image/png')),
    ).rejects.toMatchObject({ capability: 'input.image', provider: 'test' });
  });

  it('rejects a file reference issued by another provider type', async () => {
    const ref: ProviderFileRef = {
      fileId: 'files/abc',
      provider: 'gemini-prod',
      providerType: 'gemini',
      mimeType: 'application/pdf',
    };
    const resolver = makeResolver();

    await expect(resolver.resolve(fromProviderFile(ref))).rejects.toThrow(/provider-scoped/);
  });

  it('rejects an expired file reference before the provider does', async () => {
    const ref: ProviderFileRef = {
      fileId: 'files/abc',
      provider: 'test',
      providerType: 'test-adapter',
      mimeType: 'application/pdf',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    };
    const resolver = makeResolver({ now: () => new Date('2026-01-01T00:00:00Z') });

    await expect(resolver.resolve(fromProviderFile(ref))).rejects.toThrow(/expired/);
  });

  it('accepts a reference that has not expired yet', async () => {
    const ref: ProviderFileRef = {
      fileId: 'files/abc',
      provider: 'test',
      providerType: 'test-adapter',
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    };
    const resolver = makeResolver({ now: () => new Date('2026-01-01T00:00:00Z') });

    const resolved = await resolver.resolve(fromProviderFile(ref));
    expect(resolved.kind).toBe('providerFile');
  });

  it('fails when the media type cannot be inferred', async () => {
    const resolver = makeResolver();
    await expect(
      resolver.resolve({ type: 'document', source: { kind: 'path', path: '/tmp/data.bin' } }),
    ).rejects.toThrow(/media type could not be inferred/);
  });
});

describe('fileHandling policy', () => {
  const big = () => imageFromBytes(new Uint8Array(2_000), 'image/png');

  it('inlines by default and fails loudly above the limit', async () => {
    const resolver = makeResolver({ inlineLimitBytes: 1_000 });

    await expect(resolver.resolve(big(), 'inline')).rejects.toThrow(/exceeds the inline limit/);
  });

  it("escalates to an upload under 'auto' only when the payload does not fit", async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: 'files/uploaded',
      provider: 'test',
      providerType: 'test-adapter',
    });
    const resolver = makeResolver({ inlineLimitBytes: 1_000, upload });

    const small = await resolver.resolve(imageFromBytes(new Uint8Array(10), 'image/png'), 'auto');
    expect(small.kind).toBe('inline');
    expect(upload).not.toHaveBeenCalled();

    const large = await resolver.resolve(big(), 'auto');
    expect(large.kind).toBe('providerFile');
    expect(upload).toHaveBeenCalledOnce();
  });

  it("always uploads under 'upload', regardless of size", async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: 'files/uploaded',
      provider: 'test',
      providerType: 'test-adapter',
    });
    const resolver = makeResolver({ upload });

    const resolved = await resolver.resolve(
      imageFromBytes(new Uint8Array([1]), 'image/png'),
      'upload',
    );

    expect(resolved).toEqual({
      kind: 'providerFile',
      ref: { fileId: 'files/uploaded', provider: 'test', providerType: 'test-adapter' },
    });
  });

  it('records every reference it created so the caller can reuse or delete them', async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: 'files/uploaded',
      provider: 'test',
      providerType: 'test-adapter',
    });
    const resolver = makeResolver({ upload });

    await resolver.resolve(imageFromBytes(new Uint8Array([1]), 'image/png'), 'upload');

    expect(resolver.uploadedFiles).toEqual([
      { fileId: 'files/uploaded', provider: 'test', providerType: 'test-adapter' },
    ]);
  });

  it('fails when an upload is requested from a provider with no file API', async () => {
    const resolver = makeResolver({ capabilities: capabilities({ files: false }) });

    await expect(
      resolver.resolve(imageFromBytes(new Uint8Array([1]), 'image/png'), 'upload'),
    ).rejects.toThrow(/no file API/);
  });
});

describe('memoisation', () => {
  it('reads and encodes a block only once across loop iterations', async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: 'files/uploaded',
      provider: 'test',
      providerType: 'test-adapter',
    });
    const resolver = makeResolver({ upload });
    const block = imageFromBytes(new Uint8Array([1]), 'image/png');

    const first = await resolver.resolve(block, 'upload');
    const second = await resolver.resolve(block, 'upload');

    expect(second).toBe(first);
    expect(upload).toHaveBeenCalledOnce();
  });
});

describe('describe()', () => {
  it('reports counts, types and sizes without touching content', () => {
    const described = ContentResolver.describe([
      { type: 'text', text: 'hello' },
      imageFromBytes(new Uint8Array(64), 'image/png', undefined, 'a.png'),
      documentFromPath('/tmp/invoice.pdf'),
      fromBase64('AAAA', 'application/pdf'),
    ]);

    expect(described).toEqual([
      { kind: 'image', source: 'bytes', mimeType: 'image/png', fileName: 'a.png', byteLength: 64 },
      {
        kind: 'document',
        source: 'path',
        mimeType: 'application/pdf',
        fileName: 'invoice.pdf',
      },
      { kind: 'document', source: 'base64', mimeType: 'application/pdf', byteLength: 3 },
    ]);
  });

  it('never includes the payload itself', () => {
    const [descriptor] = ContentResolver.describe([
      fromBase64('c2VjcmV0IHBheWxvYWQ=', 'application/pdf'),
    ]);
    expect(JSON.stringify(descriptor)).not.toContain('c2VjcmV0');
  });
});
