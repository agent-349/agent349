import { describe, it, expect, vi } from 'vitest';
import { PDFLoader } from '../../../../../src/rag/ingestion/loaders/PDFLoader.js';
import { ValidationError } from '../../../../../src/errors/index.js';

// Mock pdf-parse so tests run without a real PDF binary
vi.mock('pdf-parse', () => {
  return {
    default: async (_buffer: Buffer) => ({
      text: 'Extracted PDF content\nPage two content',
      numpages: 2,
      info: { Title: 'My PDF Title' },
    }),
  };
});

describe('PDFLoader', () => {
  const loader = new PDFLoader();

  it('has correct name and MIME type', () => {
    expect(loader.name).toBe('pdf');
    expect(loader.supportedMimeTypes).toContain('application/pdf');
  });

  it('canLoad application/pdf', () => {
    expect(loader.canLoad({ type: 'buffer', mimeType: 'application/pdf' })).toBe(true);
  });

  it('loads from buffer and returns content + pages', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: 'application/pdf',
      buffer: Buffer.from('fake-pdf-bytes'),
    });
    expect(raw.content).toContain('Extracted PDF content');
    expect(raw.pages).toBe(2);
    expect(raw.metadata.mimeType).toBe('application/pdf');
    expect(raw.extractionMethod).toBe('pdf');
  });

  it('extracts title from PDF info', async () => {
    const raw = await loader.load({
      type: 'buffer',
      mimeType: 'application/pdf',
      buffer: Buffer.from('fake'),
    });
    expect(raw.metadata.title).toBe('My PDF Title');
  });

  it('throws ValidationError when buffer is missing', async () => {
    await expect(loader.load({ type: 'buffer', mimeType: 'application/pdf' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError for unsupported type', async () => {
    await expect(loader.load({ type: 'text', mimeType: 'application/pdf' })).rejects.toThrow(
      ValidationError,
    );
  });
});
