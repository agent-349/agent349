import { describe, it, expect } from 'vitest';
import { DocumentLoaderRegistry } from '../../../../src/rag/ingestion/DocumentLoaderRegistry.js';
import { PlainTextLoader } from '../../../../src/rag/ingestion/loaders/PlainTextLoader.js';
import { MarkdownLoader } from '../../../../src/rag/ingestion/loaders/MarkdownLoader.js';
import { HTMLLoader } from '../../../../src/rag/ingestion/loaders/HTMLLoader.js';
import { ValidationError } from '../../../../src/errors/index.js';

function makeRegistry(): DocumentLoaderRegistry {
  const registry = new DocumentLoaderRegistry();
  registry.register(new PlainTextLoader());
  registry.register(new MarkdownLoader());
  registry.register(new HTMLLoader());
  return registry;
}

describe('DocumentLoaderRegistry', () => {
  it('lists all supported MIME types', () => {
    const registry = makeRegistry();
    const types = registry.supportedTypes();
    expect(types).toContain('text/plain');
    expect(types).toContain('text/markdown');
    expect(types).toContain('text/html');
  });

  it('returns correct loader for a MIME type', () => {
    const registry = makeRegistry();
    expect(registry.getLoader('text/markdown')?.name).toBe('markdown');
    expect(registry.getLoader('text/html')?.name).toBe('html');
    expect(registry.getLoader('text/plain')?.name).toBe('plain-text');
  });

  it('returns undefined for unknown MIME type', () => {
    const registry = makeRegistry();
    expect(registry.getLoader('application/json')).toBeUndefined();
  });

  // TC-ING-09: MIME type auto-detected by extension
  it('auto-detects MIME type from .md extension', async () => {
    const registry = makeRegistry();
    // We don't have a real file, so use buffer instead and set path for extension detection
    // This tests the #resolveSource path detection
    const source = { type: 'text' as const, path: 'README.md', text: '# Title\nBody' };
    const raw = await registry.load(source);
    expect(raw.metadata.mimeType).toBe('text/markdown');
  });

  it('auto-detects MIME type from .html extension', async () => {
    const registry = makeRegistry();
    const source = { type: 'text' as const, path: 'page.html', text: '<p>Content</p>' };
    const raw = await registry.load(source);
    expect(raw.metadata.mimeType).toBe('text/html');
  });

  it('uses text/plain for type=text with no path', async () => {
    const registry = makeRegistry();
    const raw = await registry.load({ type: 'text', text: 'Direct text' });
    expect(raw.content).toBe('Direct text');
  });

  it('throws ValidationError when no loader found', async () => {
    const registry = makeRegistry();
    await expect(
      registry.load({ type: 'buffer', mimeType: 'application/pdf', buffer: Buffer.from('') }),
    ).rejects.toThrow(ValidationError);
  });
});
