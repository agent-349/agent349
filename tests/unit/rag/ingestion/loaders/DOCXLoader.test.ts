import { describe, it, expect, vi } from 'vitest';
import { DOCXLoader } from '../../../../../src/rag/ingestion/loaders/DOCXLoader.js';
import { ValidationError } from '../../../../../src/errors/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Mock mammoth so tests run without a real DOCX file
vi.mock('mammoth', () => ({
  extractRawText: async (_opts: unknown) => ({
    value: 'DOCX extracted content\nSecond paragraph',
    messages: [],
  }),
}));

describe('DOCXLoader', () => {
  const loader = new DOCXLoader();

  it('has correct name and MIME type', () => {
    expect(loader.name).toBe('docx');
    expect(loader.supportedMimeTypes).toContain(DOCX_MIME);
  });

  it('canLoad DOCX MIME type', () => {
    expect(loader.canLoad({ type: 'buffer', mimeType: DOCX_MIME })).toBe(true);
  });

  it('loads from buffer', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: DOCX_MIME,
      buffer: Buffer.from('fake-docx'),
    });
    expect(raw.content).toContain('DOCX extracted content');
    expect(raw.metadata.mimeType).toBe(DOCX_MIME);
    expect(raw.extractionMethod).toBe('docx');
  });

  it('throws ValidationError when buffer is missing', async () => {
    await expect(loader.load({ type: 'buffer', mimeType: DOCX_MIME })).rejects.toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError for unsupported type', async () => {
    await expect(loader.load({ type: 'text', mimeType: DOCX_MIME })).rejects.toThrow(
      ValidationError,
    );
  });

  it('merges user metadata', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: DOCX_MIME,
      buffer: Buffer.from('fake'),
      metadata: { tags: ['rrhh'] },
    });
    expect(raw.metadata.tags).toEqual(['rrhh']);
  });
});
