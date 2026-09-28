import { describe, it, expect } from 'vitest';
import { MarkdownLoader } from '../../../../../src/rag/ingestion/loaders/MarkdownLoader.js';

describe('MarkdownLoader', () => {
  const loader = new MarkdownLoader();

  it('has correct name and MIME types', () => {
    expect(loader.name).toBe('markdown');
    expect(loader.supportedMimeTypes).toContain('text/markdown');
  });

  it('canLoad text/markdown', () => {
    expect(loader.canLoad({ type: 'text', mimeType: 'text/markdown' })).toBe(true);
  });

  it('loads from text source', async () => {
    const md = '# My Title\n\nHello world';
    const raw = await loader.load({ type: 'text', mimeType: 'text/markdown', text: md });
    expect(raw.content).toBe(md);
    expect(raw.metadata.mimeType).toBe('text/markdown');
    expect(raw.extractionMethod).toBe('markdown');
  });

  it('extracts title from first H1', async () => {
    const raw = await loader.load({
      type: 'text',
      mimeType: 'text/markdown',
      text: '# Política de Vacaciones\n\nContenido',
    });
    expect(raw.metadata.title).toBe('Política de Vacaciones');
  });

  it('no title when no H1 present', async () => {
    const raw = await loader.load({
      type: 'text',
      mimeType: 'text/markdown',
      text: '## Section\n\nNo H1 here',
    });
    expect(raw.metadata.title).toBeUndefined();
  });

  it('loads from buffer', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Title\nBody', 'utf-8'),
    });
    expect(raw.metadata.title).toBe('Title');
  });
});
