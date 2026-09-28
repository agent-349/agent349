import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  contentToText,
  describeOmitted,
  documentFromBytes,
  documentFromPath,
  documentFromUrl,
  fileNameOf,
  fromBase64,
  fromProviderFile,
  imageFromBytes,
  imageFromPath,
  isMediaBlock,
  mediaKindFromMimeType,
  mimeTypeFromPath,
  mimeTypeOf,
  readFileBytes,
  text,
  toBase64,
  toBlocks,
} from '../../../src/content/index.js';
import type { ContentBlock, ProviderFileRef } from '../../../src/types/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/media');

describe('mime type inference', () => {
  it('infers a media type from a path extension', () => {
    expect(mimeTypeFromPath('/tmp/invoice.pdf')).toBe('application/pdf');
    expect(mimeTypeFromPath('photo.JPEG')).toBe('image/jpeg');
  });

  it('returns undefined for an unknown extension', () => {
    expect(mimeTypeFromPath('archive.xyz')).toBeUndefined();
  });

  it('maps a media type to its modality', () => {
    expect(mediaKindFromMimeType('image/png')).toBe('image');
    expect(mediaKindFromMimeType('audio/mpeg')).toBe('audio');
    expect(mediaKindFromMimeType('video/mp4')).toBe('video');
    expect(mediaKindFromMimeType('application/pdf')).toBe('document');
  });
});

describe('block builders', () => {
  it('builds a text block', () => {
    expect(text('hola')).toEqual({ type: 'text', text: 'hola' });
  });

  it('builds an image block from a path, inferring the media type', () => {
    const block = imageFromPath('/tmp/photo.png');
    expect(block.type).toBe('image');
    expect(block.source).toEqual({
      kind: 'path',
      path: '/tmp/photo.png',
      fileName: 'photo.png',
    });
    expect(mimeTypeOf(block)).toBe('image/png');
  });

  it('builds an image block from bytes with an explicit media type', () => {
    const block = imageFromBytes(new Uint8Array([1, 2, 3]), 'image/webp', undefined, 'x.webp');
    expect(mimeTypeOf(block)).toBe('image/webp');
    expect(fileNameOf(block)).toBe('x.webp');
  });

  it('builds a document block from bytes', () => {
    const block = documentFromBytes(new Uint8Array([1]), 'application/pdf');
    expect(block.type).toBe('document');
    expect(block.source.kind).toBe('bytes');
  });

  it('builds a document block from a URL without downloading anything', () => {
    const block = documentFromUrl('https://example.com/a.pdf');
    expect(block.source).toEqual({ kind: 'url', url: 'https://example.com/a.pdf' });
    expect(mimeTypeOf(block)).toBe('application/pdf');
  });

  it('infers the modality of a provider file reference from its media type', () => {
    const ref: ProviderFileRef = {
      fileId: 'files/abc',
      provider: 'gemini',
      providerType: 'gemini',
      mimeType: 'image/png',
    };
    expect(fromProviderFile(ref).type).toBe('image');
  });

  it('defaults a reference with no media type to a document', () => {
    const ref: ProviderFileRef = { fileId: 'f', provider: 'p', providerType: 'gemini' };
    expect(fromProviderFile(ref).type).toBe('document');
  });

  it('accepts pre-encoded base64 as an interop source', () => {
    const block = fromBase64('AAAA', 'application/pdf');
    expect(block.type).toBe('document');
    expect(block.source).toEqual({ kind: 'base64', data: 'AAAA', mimeType: 'application/pdf' });
  });

  it('carries per-block provider options', () => {
    const block = imageFromPath('/tmp/a.png', { detail: 'high' });
    expect(block.options).toEqual({ detail: 'high' });
  });
});

describe('inspection helpers', () => {
  it('narrows media blocks', () => {
    expect(isMediaBlock(imageFromPath('/a.png'))).toBe(true);
    expect(isMediaBlock(text('hi'))).toBe(false);
    expect(isMediaBlock({ type: 'tool_use', toolUseId: '1', toolName: 't', input: {} })).toBe(
      false,
    );
  });

  it('normalises a plain string into blocks', () => {
    expect(toBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('passes an existing block list through unchanged', () => {
    const blocks = [text('a')];
    expect(toBlocks(blocks)).toBe(blocks);
  });
});

describe('contentToText', () => {
  it('returns a plain string unchanged', () => {
    expect(contentToText('hola')).toBe('hola');
  });

  it('renders media as a short descriptor, never as content', () => {
    const out = contentToText([
      text('Extract this'),
      documentFromPath('/tmp/invoice.pdf'),
      imageFromBytes(new Uint8Array([1, 2, 3]), 'image/png'),
    ]);
    expect(out).toContain('Extract this');
    expect(out).toContain("[document 'invoice.pdf' (application/pdf)]");
    expect(out).toContain('[image (image/png)]');
  });

  it('renders an omitted-media placeholder explicitly', () => {
    const block: ContentBlock = {
      type: 'media_omitted',
      mediaType: 'document',
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      reason: 'not_persisted',
    };
    const out = contentToText([block]);
    expect(out).toContain('no longer available');
    expect(out).toContain('invoice.pdf');
  });

  it('flattens tool blocks without leaking payloads', () => {
    const out = contentToText([
      { type: 'tool_use', toolUseId: '1', toolName: 'search', input: { q: 'x' } },
      { type: 'tool_result', toolUseId: '1', content: '{"ok":true}' },
    ]);
    expect(out).toContain('[tool_use search]');
    expect(out).toContain('{"ok":true}');
  });
});

describe('describeOmitted', () => {
  it('explains an expired provider reference', () => {
    const message = describeOmitted({
      type: 'media_omitted',
      mediaType: 'document',
      mimeType: 'application/pdf',
      reason: 'expired',
    });
    expect(message).toContain('expired');
  });

  it('explains content that was not persisted', () => {
    const message = describeOmitted({
      type: 'media_omitted',
      mediaType: 'image',
      mimeType: 'image/png',
      reason: 'not_persisted',
    });
    expect(message).toContain('not persisted');
  });
});

describe('byte helpers', () => {
  it('reads a file from disk and round-trips it through base64', async () => {
    const bytes = await readFileBytes(join(FIXTURES, 'pixel.png'));
    expect(bytes.byteLength).toBeGreaterThan(0);
    // PNG magic number survives the round trip.
    expect(Buffer.from(toBase64(bytes), 'base64').subarray(1, 4).toString()).toBe('PNG');
  });
});
