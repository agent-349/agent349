import { describe, it, expect } from 'vitest';
import { PlainTextLoader } from '../../../../../src/rag/ingestion/loaders/PlainTextLoader.js';
import { ValidationError } from '../../../../../src/errors/index.js';

describe('PlainTextLoader', () => {
  const loader = new PlainTextLoader();

  it('has correct name and supported MIME types', () => {
    expect(loader.name).toBe('plain-text');
    expect(loader.supportedMimeTypes).toContain('text/plain');
  });

  it('canLoad text/plain source', () => {
    expect(loader.canLoad({ type: 'text', mimeType: 'text/plain' })).toBe(true);
  });

  it('canLoad text source without mimeType', () => {
    expect(loader.canLoad({ type: 'text' })).toBe(true);
  });

  it('loads from type=text', async () => {
    const raw = await loader.load({ type: 'text', text: 'Hello world' });
    expect(raw.content).toBe('Hello world');
    expect(raw.metadata.mimeType).toBe('text/plain');
    expect(raw.extractionMethod).toBe('plain-text');
  });

  it('loads from buffer', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: 'text/plain',
      buffer: Buffer.from('Buffer content', 'utf-8'),
    });
    expect(raw.content).toBe('Buffer content');
  });

  it('throws ValidationError when text is missing', async () => {
    await expect(loader.load({ type: 'text' })).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when buffer is missing', async () => {
    await expect(loader.load({ type: 'buffer', mimeType: 'text/plain' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError for unsupported type', async () => {
    // url type — not supported by PlainTextLoader
    await expect(loader.load({ type: 'url', mimeType: 'text/plain' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('merges user metadata', async () => {
    const raw = await loader.load({
      type: 'text',
      text: 'content',
      metadata: { tags: ['test'], tenantId: 'acme' },
    });
    expect(raw.metadata.tags).toEqual(['test']);
    expect(raw.metadata.tenantId).toBe('acme');
  });
});
