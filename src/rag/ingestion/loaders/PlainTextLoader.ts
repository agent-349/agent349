import { readFile } from 'node:fs/promises';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// PlainTextLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads plain text files (`.txt`, `.csv`, `.text`) without any transformation.
 *
 * For `type='text'` sources the content is used directly. For `type='file'`
 * or `type='buffer'` sources the bytes are decoded as UTF-8.
 */
export class PlainTextLoader extends DocumentLoader {
  override readonly name = 'plain-text';
  override readonly supportedMimeTypes = ['text/plain'];

  override canLoad(source: DocumentSource): boolean {
    return (
      source.mimeType === 'text/plain' ||
      (source.type === 'text' &&
        (source.mimeType === undefined || source.mimeType === 'text/plain'))
    );
  }

  override async load(source: DocumentSource): Promise<RawDocument> {
    let content: string;

    switch (source.type) {
      case 'text':
        if (source.text === undefined) {
          throw new ValidationError('source.text', 'text source requires the text field');
        }
        content = source.text;
        break;

      case 'file':
        if (!source.path) {
          throw new ValidationError('source.path', 'file source requires a path');
        }
        content = await readFile(source.path, 'utf-8');
        break;

      case 'buffer':
        if (!source.buffer) {
          throw new ValidationError('source.buffer', 'buffer source requires the buffer field');
        }
        content = source.buffer.toString('utf-8');
        break;

      default:
        throw new ValidationError(
          'source.type',
          `PlainTextLoader does not support type '${source.type}'`,
        );
    }

    return {
      content,
      metadata: {
        documentId: '',
        source: source.path ?? source.url ?? '[text]',
        mimeType: 'text/plain',
        ...source.metadata,
      },
      extractionMethod: this.name,
    };
  }
}
