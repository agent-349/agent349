import { readFile } from 'node:fs/promises';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ─────────────────────────────────────────────────────────────────────────────
// DOCXLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads Microsoft Word (`.docx`) files and extracts their text using `mammoth`.
 *
 * Works with `type='file'` and `type='buffer'` sources. `mammoth` converts
 * the DOCX structure to plain text, discarding formatting but preserving
 * paragraph breaks.
 *
 * `mammoth` is an optional dependency — it is imported dynamically so that
 * environments without the package do not fail at startup.
 */
export class DOCXLoader extends DocumentLoader {
  override readonly name = 'docx';
  override readonly supportedMimeTypes = [DOCX_MIME];

  override canLoad(source: DocumentSource): boolean {
    return source.mimeType === DOCX_MIME;
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
          `DOCXLoader does not support type '${source.type}'. Use 'file' or 'buffer'.`,
        );
    }

    // Dynamic import so the module is optional at startup
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });

    const content = result.value
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      content,
      metadata: {
        documentId: '',
        source: source.path ?? '[buffer]',
        mimeType: DOCX_MIME,
        ...source.metadata,
      },
      extractionMethod: this.name,
    };
  }
}
