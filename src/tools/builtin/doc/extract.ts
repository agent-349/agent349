import { parse } from 'node-html-parser';

/** Text pulled out of a document, plus whatever metadata came with it. */
export interface ExtractedText {
  /** The text content. */
  text: string;
  /** Document or page title, when the format carries one. */
  title?: string;
  /** Page count, for formats that have pages. */
  pages?: number;
  /** Elements matched by the selector, when one was applied to HTML. */
  selectorMatches?: number;
}

/** Options for {@link extractText}. */
export interface ExtractTextOptions {
  /**
   * CSS selector limiting HTML extraction to the matching elements, joined in
   * document order. Ignored for bodies that are not HTML.
   */
  selector?: string;
}

/** MIME type of a Word document. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Extracts readable text from bytes, dispatching on MIME type.
 *
 * Delegates to the same libraries the RAG loaders already use — `pdf-parse`,
 * `mammoth`, `node-html-parser`, all existing dependencies — so no new one is
 * introduced. They are imported dynamically, matching the loaders.
 *
 * @param bytes    - Raw document bytes.
 * @param mimeType - Declared MIME type; the extension is used when it is vague.
 * @param fileName - Optional name, used to disambiguate `application/octet-stream`.
 * @returns The extracted text and metadata.
 * @throws When the format is not one of the supported ones.
 */
export async function extractFromBytes(
  bytes: Uint8Array,
  mimeType: string,
  fileName?: string,
): Promise<ExtractedText> {
  const kind = classify(mimeType, fileName);
  const buffer = Buffer.from(bytes);

  switch (kind) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'html':
      return extractHtml(buffer.toString('utf8'));
    case 'text':
      return { text: collapse(buffer.toString('utf8')) };
  }
}

/**
 * Extracts text from an already-decoded body, for callers that hold a string.
 *
 * @param body        - The decoded body.
 * @param contentType - Content-Type header value.
 * @param options     - Optional selector for HTML bodies.
 */
export function extractText(
  body: string,
  contentType: string,
  options: ExtractTextOptions = {},
): ExtractedText {
  return classify(contentType) === 'html'
    ? extractHtml(body, options.selector)
    : { text: collapse(body) };
}

/**
 * Whether `selector` is a CSS selector the HTML parser accepts.
 *
 * Checked when a tool is built, so a typo in a declared selector fails at load
 * time instead of on every read.
 *
 * @param selector - The selector to check.
 */
export function isValidSelector(selector: string): boolean {
  if (selector.trim() === '') return false;
  try {
    parse('<div><p></p></div>').querySelectorAll(selector);
    return true;
  } catch {
    return false;
  }
}

/** Document families this module can read. */
type Kind = 'pdf' | 'docx' | 'html' | 'text';

/** Picks the extraction path from the MIME type, falling back to the name. */
function classify(mimeType: string, fileName?: string): Kind {
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (type === 'application/pdf') return 'pdf';
  if (type === DOCX_MIME) return 'docx';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json') return 'text';

  // Servers and file stores often say octet-stream and leave the real type to
  // the extension.
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (extension) {
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'html':
    case 'htm':
      return 'html';
    default:
      return 'text';
  }
}

/** Reads a PDF with `pdf-parse`, the loaders' dependency. */
async function extractPdf(buffer: Buffer): Promise<ExtractedText> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import('pdf-parse')) as any;
  const pdfParse: (input: Buffer) => Promise<{
    text: string;
    numpages?: number;
    info?: Record<string, unknown>;
  }> =
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    mod.default ?? mod;

  const parsed = await pdfParse(buffer);
  const title = typeof parsed.info?.['Title'] === 'string' ? parsed.info['Title'] : undefined;

  return {
    text: collapse(parsed.text),
    ...(title !== undefined && title !== '' && { title }),
    ...(parsed.numpages !== undefined && { pages: parsed.numpages }),
  };
}

/** Reads a Word document with `mammoth`, the loaders' dependency. */
async function extractDocx(buffer: Buffer): Promise<ExtractedText> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: collapse(result.value) };
}

/** Tags that never carry readable content. */
const NON_CONTENT_TAGS = ['script', 'style', 'head', 'noscript'];

/** Page chrome, dropped only when no selector says which region matters. */
const CHROME_TAGS = ['nav', 'footer', 'aside'];

/**
 * Strips markup with `node-html-parser`, the loaders' dependency.
 *
 * Uses `structuredText`, which ends each block-level element on its own line.
 * Plain `text` concatenates adjacent blocks, so `<p>a</p><p>b</p>` read as
 * `ab` — two paragraphs fused into one word, and no way for a caller to tell
 * where one block ended.
 */
function extractHtml(html: string, selector?: string): ExtractedText {
  const root = parse(html);
  const title = root.querySelector('title')?.text.trim();
  const scoped = selector !== undefined && selector.trim() !== '';

  // With a selector the caller has already said which region matters, so page
  // chrome is left alone: the region may well be inside a <nav> or <aside>.
  const drop = scoped ? NON_CONTENT_TAGS : [...NON_CONTENT_TAGS, ...CHROME_TAGS];
  for (const tag of drop) {
    root.querySelectorAll(tag).forEach((element) => {
      element.remove();
    });
  }

  if (scoped) {
    const matches = root.querySelectorAll(selector);
    return {
      text: collapse(matches.map((element) => element.structuredText).join('\n\n')),
      selectorMatches: matches.length,
      ...(title !== undefined && title !== '' && { title }),
    };
  }

  const body = root.querySelector('body') ?? root;
  return {
    text: collapse(body.structuredText),
    ...(title !== undefined && title !== '' && { title }),
  };
}

/** Collapses runs of whitespace so the text costs fewer tokens to read. */
function collapse(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Returns the requested page range of a PDF's text.
 *
 * `pdf-parse` yields the whole document as one string with form feeds between
 * pages, so the split is on `\f`. When the document carries no page breaks the
 * range is ignored rather than returning nothing.
 *
 * @param text  - Extracted text.
 * @param range - `'3'`, `'3-8'`, or undefined for everything.
 * @returns The selected text and whether a range was actually applied.
 */
export function selectPages(
  text: string,
  range?: string,
): { text: string; applied: boolean; totalPages: number } {
  const pages = text.split('\f');
  if (range === undefined || pages.length <= 1) {
    return { text, applied: false, totalPages: pages.length };
  }

  const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(range.trim());
  if (match?.[1] === undefined) {
    return { text, applied: false, totalPages: pages.length };
  }

  const from = Math.max(1, Number(match[1]));
  const to = match[2] === undefined ? from : Math.max(from, Number(match[2]));

  return {
    text: pages
      .slice(from - 1, to)
      .join('\n\n')
      .trim(),
    applied: true,
    totalPages: pages.length,
  };
}
