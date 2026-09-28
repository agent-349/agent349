import { readFile } from 'node:fs/promises';
import { parse } from 'node-html-parser';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// HTMLLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads HTML files and strips tags to return plain text content.
 *
 * Uses `node-html-parser` to parse the HTML and extract:
 * - The page title from `<title>` (as metadata).
 * - The visible text body (scripts, styles, and head are removed).
 *
 * Consecutive whitespace and blank lines are collapsed so the extracted
 * text is compact and suitable for embedding.
 */
export class HTMLLoader extends DocumentLoader {
  override readonly name = 'html';
  override readonly supportedMimeTypes = ['text/html'];

  override canLoad(source: DocumentSource): boolean {
    return source.mimeType === 'text/html';
  }

  override async load(source: DocumentSource): Promise<RawDocument> {
    let raw: string;

    switch (source.type) {
      case 'text':
        if (source.text === undefined) {
          throw new ValidationError('source.text', 'text source requires the text field');
        }
        raw = source.text;
        break;

      case 'file':
        if (!source.path) {
          throw new ValidationError('source.path', 'file source requires a path');
        }
        raw = await readFile(source.path, 'utf-8');
        break;

      case 'buffer':
        if (!source.buffer) {
          throw new ValidationError('source.buffer', 'buffer source requires the buffer field');
        }
        raw = source.buffer.toString('utf-8');
        break;

      default:
        throw new ValidationError(
          'source.type',
          `HTMLLoader does not support type '${source.type}'`,
        );
    }

    const root = parse(raw);

    // Extract page title
    const titleEl = root.querySelector('title');
    const title = titleEl?.text.trim() || undefined;

    // Remove non-content elements
    for (const tag of ['script', 'style', 'head', 'noscript', 'nav', 'footer', 'aside']) {
      root.querySelectorAll(tag).forEach((el) => el.remove());
    }

    // Extract visible text; collapse whitespace
    const body = root.querySelector('body') ?? root;
    const content = body.text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      content,
      metadata: {
        documentId: '',
        source: source.path ?? source.url ?? '[text]',
        mimeType: 'text/html',
        ...(title !== undefined && { title }),
        ...source.metadata,
      },
      extractionMethod: this.name,
    };
  }
}
