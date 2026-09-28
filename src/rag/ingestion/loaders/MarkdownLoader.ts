import { readFile } from 'node:fs/promises';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads Markdown files (`.md`, `.markdown`) and returns the raw Markdown text.
 *
 * The content is intentionally preserved as-is (not converted to plain text)
 * so that the `MarkdownChunker` and `RecursiveChunker` can use header
 * boundaries for semantically aware chunking.
 */
export class MarkdownLoader extends DocumentLoader {
  override readonly name = 'markdown';
  override readonly supportedMimeTypes = ['text/markdown'];

  override canLoad(source: DocumentSource): boolean {
    return source.mimeType === 'text/markdown';
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
          `MarkdownLoader does not support type '${source.type}'`,
        );
    }

    // Extract a title from the first H1 heading, if present
    const titleMatch = /^#\s+(.+)/m.exec(content);

    const title = titleMatch?.[1]?.trim();

    return {
      content,
      metadata: {
        documentId: '',
        source: source.path ?? source.url ?? '[text]',
        mimeType: 'text/markdown',
        ...(title !== undefined && { title }),
        ...source.metadata,
      },
      extractionMethod: this.name,
    };
  }
}
