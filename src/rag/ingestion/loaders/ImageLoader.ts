import { readFile } from 'node:fs/promises';
import type { DocumentSource, RawDocument } from '../types.js';
import { DocumentLoader } from './DocumentLoader.js';
import { ValidationError } from '../../../errors/index.js';
import { OcrService } from '../../ocr/OcrService.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/tiff', 'image/bmp', 'image/webp'];

/**
 * Loads the text of an image (a scanned page, a photo of a document) with OCR.
 * Registered only when OCR is configured (`rag.ocr`).
 */
export class ImageLoader extends DocumentLoader {
  override readonly name = 'image-ocr';
  override readonly supportedMimeTypes = IMAGE_TYPES;
  readonly #ocr: OcrService;

  constructor(ocr: OcrService) {
    super();
    this.#ocr = ocr;
  }

  override canLoad(source: DocumentSource): boolean {
    return source.mimeType !== undefined && IMAGE_TYPES.includes(source.mimeType);
  }

  override async load(source: DocumentSource): Promise<RawDocument> {
    let buffer: Buffer;
    if (source.type === 'file') {
      if (!source.path) throw new ValidationError('source.path', 'file source requires a path');
      buffer = await readFile(source.path);
    } else if (source.type === 'buffer') {
      if (!source.buffer)
        throw new ValidationError('source.buffer', 'buffer source requires the buffer field');
      buffer = source.buffer;
    } else {
      throw new ValidationError(
        'source.type',
        `ImageLoader does not support type '${source.type}'. Use 'file' or 'buffer'.`,
      );
    }
    const lang = source.metadata?.language;
    const tess = typeof lang === 'string' ? OcrService.tesseractLanguage(lang) : undefined;
    const result = await this.#ocr.extractImage(
      buffer,
      tess !== undefined ? { languages: [tess] } : {},
    );
    return {
      content: result.text.trim(),
      metadata: {
        documentId: '',
        source: source.path ?? '[buffer]',
        ...(source.mimeType !== undefined && { mimeType: source.mimeType }),
        ...source.metadata,
        custom: {
          ...(source.metadata?.custom ?? {}),
          ocr: {
            pages: result.ocrPages,
            escalatedPages: result.escalatedPages,
            ...(result.avgConfidence !== undefined && { avgConfidence: result.avgConfidence }),
          },
        },
      },
      pages: 1,
      extractionMethod: this.name,
    };
  }
}
