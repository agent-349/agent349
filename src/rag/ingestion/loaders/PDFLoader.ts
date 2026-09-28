import { readFile } from 'node:fs/promises';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// PDFLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads PDF files and extracts their text content using `pdf-parse`.
 *
 * Works with `type='file'` and `type='buffer'` sources. The extracted
 * metadata includes the number of pages and the document title when the
 * PDF metadata contains it.
 *
 * `pdf-parse` is a devDependency-style optional dependency. The import is
 * performed dynamically so that environments without the package do not
 * fail at startup — they will only throw at call time.
 */
export class PDFLoader extends DocumentLoader {
  override readonly name = 'pdf';
  override readonly supportedMimeTypes = ['application/pdf'];

  override canLoad(source: DocumentSource): boolean {
    return source.mimeType === 'application/pdf';
  }

  override async load(source: DocumentSource): Promise<RawDocument> {
    let buffer: Buffer;

    switch (source.type) {
      case 'file':
        if (!source.path) {
          throw new ValidationError('source.path', 'file source requires a path');
        }
        buffer = await readFile(source.path);
        break;

      case 'buffer':
        if (!source.buffer) {
          throw new ValidationError('source.buffer', 'buffer source requires the buffer field');
        }
        buffer = source.buffer;
        break;

      default:
        throw new ValidationError(
          'source.type',
          `PDFLoader does not support type '${source.type}'. Use 'file' or 'buffer'.`,
        );
    }

    // Dynamic import so the module is optional at startup.
    // pdf-parse ships a CJS bundle; in ESM context we access it via the
    // module namespace object directly (no .default wrapper needed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfMod = (await import('pdf-parse')) as any;
    const pdfParse: (
      buffer: Buffer,
    ) => Promise<{ text: string; numpages: number; info?: Record<string, unknown> }> =
      pdfMod.default ?? pdfMod;
    const result = await pdfParse(buffer);

    // Clean up extracted text
    const content = result.text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfInfo = result.info as Record<string, any> | undefined;
    const title: string | undefined = pdfInfo?.Title || pdfInfo?.title || undefined;

    return {
      content,
      metadata: {
        documentId: '',
        source: source.path ?? '[buffer]',
        mimeType: 'application/pdf',
        ...(title !== undefined && { title }),
        ...source.metadata,
      },
      pages: result.numpages,
      extractionMethod: this.name,
    };
  }
}
