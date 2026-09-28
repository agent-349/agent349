import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from '../../../errors/index.js';
import { extractText } from '../doc/extract.js';
import { truncateText } from '../limits.js';

/** Syndication formats {@link parseFeed} understands. */
export type FeedFormat = 'rss' | 'atom' | 'rdf';

/** One entry of a feed, normalised across formats. */
export interface FeedEntry {
  /**
   * Stable identity: the entry's `guid` / `id`, else its link, else a hash of
   * its title, date and summary prefixed `sha1:`.
   */
  id: string;
  /** Absolute http(s) link. Other schemes are dropped. */
  link?: string;
  /** Title, as plain text. */
  title?: string;
  /** Description or content, as plain text, capped. */
  summary?: string;
  /** Publication date, ISO 8601. */
  published?: string;
  /** Last update, ISO 8601. */
  updated?: string;
  /** Category labels. */
  categories: string[];
  /** Author name. */
  author?: string;
}

/** A parsed feed. */
export interface ParsedFeed {
  /** Format detected from the document root. */
  format: FeedFormat;
  /** Feed title. */
  title?: string;
  /** Feed home link. */
  link?: string;
  /** Entries, in document order, up to `maxEntries`. */
  entries: FeedEntry[];
  /** Entries present in the document, before the cap. */
  totalEntries: number;
}

/** Options for {@link parseFeed}. */
export interface ParseFeedOptions {
  /** Entries returned at most. Default `50`. */
  maxEntries?: number;
  /** Characters kept per summary. Default `2000`. */
  maxSummaryChars?: number;
  /** URL the feed was read from, to resolve relative links. */
  baseUrl?: string;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_SUMMARY_CHARS = 2_000;

/** Elements that may repeat, parsed as arrays so one and many look alike. */
const ARRAY_TAGS: ReadonlySet<string> = new Set(['item', 'entry', 'link', 'category', 'subject']);

type XmlNode = Record<string, unknown>;

/**
 * Parses an RSS 2.0, Atom 1.0 or RSS 1.0 (RDF) document into normalised entries.
 *
 * ### What it refuses, and why
 * - **Entity declarations.** A feed has no business declaring `<!ENTITY>`, and
 *   entity expansion is the classic way to turn a few kilobytes of XML into
 *   gigabytes of memory. The parser runs with entity processing off anyway;
 *   refusing the declaration makes the intent explicit.
 * - **Non-http links.** A `javascript:` link in a feed is a payload waiting for
 *   a UI that renders it.
 *
 * Only the five predefined XML entities and numeric character references are
 * decoded. Anything that is markup after that — HTML in a description, or a
 * double-escaped Atom `type="html"` title — goes through the same HTML
 * extraction as `web.read`, so what comes out is plain text.
 *
 * @param xml     - The document.
 * @param options - Caps and base URL.
 * @returns The feed, with entries in document order.
 * @throws {@link ValidationError} when the document is not a feed this parser reads.
 */
export function parseFeed(xml: string, options: ParseFeedOptions = {}): ParsedFeed {
  if (/<!ENTITY/i.test(xml)) {
    throw new ValidationError(
      'feed',
      'the document declares XML entities, which feeds do not need and this parser refuses',
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    isArray: (tagName: string): boolean => ARRAY_TAGS.has(tagName),
  });

  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (err) {
    throw new ValidationError(
      'feed',
      `the document is not well-formed XML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ctx: EntryContext = {
    maxSummaryChars: positive(options.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
  };
  const maxEntries = positive(options.maxEntries, DEFAULT_MAX_ENTRIES);

  const rss = asNode(doc['rss']);
  if (rss !== undefined) {
    const channel = asNode(first(rss['channel']));
    if (channel === undefined) {
      throw new ValidationError('feed', 'the RSS document has no <channel>');
    }
    return assemble(
      'rss',
      channel,
      rssLink(channel, ctx),
      entries(channel['item'], rssEntry, ctx),
      maxEntries,
    );
  }

  const atom = asNode(doc['feed']);
  if (atom !== undefined) {
    return assemble(
      'atom',
      atom,
      atomLink(atom, ctx),
      entries(atom['entry'], atomEntry, ctx),
      maxEntries,
    );
  }

  const rdf = asNode(doc['RDF']);
  if (rdf !== undefined) {
    const channel = asNode(first(rdf['channel'])) ?? {};
    return assemble(
      'rdf',
      channel,
      rssLink(channel, ctx),
      entries(rdf['item'], rssEntry, ctx),
      maxEntries,
    );
  }

  throw new ValidationError('feed', 'the document is neither RSS nor Atom');
}

/**
 * Decodes the five predefined XML entities and numeric character references,
 * in a single pass so `&amp;lt;` becomes `&lt;` and not `<`.
 *
 * @param value - Text as it appears in the document.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (match, entity: string) => {
    const name = entity.toLowerCase();
    if (name.startsWith('#')) {
      const code = name.startsWith('#x')
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      const valid =
        Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    }
    switch (name) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return '&';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entries
// ─────────────────────────────────────────────────────────────────────────────

interface EntryContext {
  maxSummaryChars: number;
  baseUrl?: string;
}

type EntryBuilder = (node: XmlNode, ctx: EntryContext) => FeedEntry | undefined;

/** Builds the entries of a document, dropping the ones with nothing to identify them. */
function entries(value: unknown, build: EntryBuilder, ctx: EntryContext): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const node of nodes(value)) {
    const entry = build(node, ctx);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/** Caps the entries and puts the feed together. */
function assemble(
  format: FeedFormat,
  channel: XmlNode,
  link: string | undefined,
  all: FeedEntry[],
  maxEntries: number,
): ParsedFeed {
  const title = cleanText(channel['title'], true);
  return {
    format,
    ...(title !== undefined && { title }),
    ...(link !== undefined && { link }),
    entries: all.slice(0, maxEntries),
    totalEntries: all.length,
  };
}

/** An RSS 2.0 `<item>` or an RSS 1.0 (RDF) `<item>`. */
function rssEntry(item: XmlNode, ctx: EntryContext): FeedEntry | undefined {
  const link = rssLink(item, ctx);
  const guid = plain(item['guid']);
  const title = cleanText(item['title'], true);
  const summary = summaryOf(item['description'] ?? item['encoded'], ctx);
  const published = toIso(plain(item['pubDate']) ?? plain(item['date']));
  const updated = toIso(plain(item['updated']));
  const author = cleanText(item['author'] ?? item['creator'], true);
  const categories = [...nodes(item['category']), ...nodes(item['subject'])]
    .map((node) => cleanText(node, true))
    .filter((label): label is string => label !== undefined);

  const id = guid ?? link ?? contentHash(title, published, summary);
  if (id === undefined) return undefined;

  return {
    id,
    ...(link !== undefined && { link }),
    ...(title !== undefined && { title }),
    ...(summary !== undefined && { summary }),
    ...(published !== undefined && { published }),
    ...(updated !== undefined && { updated }),
    categories,
    ...(author !== undefined && { author }),
  };
}

/** An Atom `<entry>`. */
function atomEntry(entry: XmlNode, ctx: EntryContext): FeedEntry | undefined {
  const link = atomLink(entry, ctx);
  const title = cleanText(entry['title'], true);
  const summary = summaryOf(entry['summary'] ?? entry['content'], ctx);
  const published = toIso(plain(entry['published']));
  const updated = toIso(plain(entry['updated']));
  const author = cleanText(asNode(first(entry['author']))?.['name'], true);
  const categories = nodes(entry['category'])
    .map((node) => {
      const label = node['@_label'] ?? node['@_term'];
      return typeof label === 'string' ? cleanText(label, true) : cleanText(node, true);
    })
    .filter((label): label is string => label !== undefined);

  const id = plain(entry['id']) ?? link ?? contentHash(title, published ?? updated, summary);
  if (id === undefined) return undefined;

  return {
    id,
    ...(link !== undefined && { link }),
    ...(title !== undefined && { title }),
    ...(summary !== undefined && { summary }),
    ...(published !== undefined && { published }),
    ...(updated !== undefined && { updated }),
    categories,
    ...(author !== undefined && { author }),
  };
}

/** RSS link: element text, or the `href` of an embedded `<atom:link>`. */
function rssLink(node: XmlNode, ctx: EntryContext): string | undefined {
  for (const link of nodes(node['link'])) {
    const text = plain(link);
    const href = typeof link['@_href'] === 'string' ? link['@_href'] : undefined;
    const url = safeUrl(text ?? (href !== undefined ? decodeXmlEntities(href) : undefined), ctx);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** Atom link: the `alternate` one, or the first without a `rel`. */
function atomLink(node: XmlNode, ctx: EntryContext): string | undefined {
  const links = nodes(node['link']);
  const preferred =
    links.find((link) => link['@_rel'] === 'alternate') ??
    links.find((link) => link['@_rel'] === undefined);
  const href = preferred?.['@_href'];
  return typeof href === 'string' ? safeUrl(decodeXmlEntities(href), ctx) : undefined;
}

/** Summary text, capped. */
function summaryOf(value: unknown, ctx: EntryContext): string | undefined {
  const text = cleanText(value, false);
  if (text === undefined) return undefined;
  return truncateText(text, ctx.maxSummaryChars).text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

/** The node as an object, or undefined. */
function asNode(value: unknown): XmlNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

/** First element of an array, or the value itself. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Every element as an object node; bare text becomes `{ '#text': … }`. */
function nodes(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const out: XmlNode[] = [];
  for (const item of list) {
    if (typeof item === 'string' || typeof item === 'number') {
      out.push({ '#text': String(item) });
      continue;
    }
    const node = asNode(item);
    if (node !== undefined) out.push(node);
  }
  return out;
}

/** Raw text of an element, entity-decoded, trimmed; undefined when empty. */
function plain(value: unknown): string | undefined {
  const node = first(value);
  let raw: string | undefined;
  if (typeof node === 'string' || typeof node === 'number') raw = String(node);
  else {
    const text = asNode(node)?.['#text'];
    if (typeof text === 'string' || typeof text === 'number') raw = String(text);
  }
  if (raw === undefined) return undefined;
  const decoded = decodeXmlEntities(raw).trim();
  return decoded === '' ? undefined : decoded;
}

/**
 * Element text as plain text: entities decoded, then any markup stripped.
 *
 * @param singleLine - Collapse line breaks, for titles and labels.
 */
function cleanText(value: unknown, singleLine: boolean): string | undefined {
  const decoded = plain(value);
  if (decoded === undefined) return undefined;
  const text = /[<&]/.test(decoded) ? extractText(decoded, 'text/html').text : decoded;
  const shaped = singleLine ? text.replace(/\s+/g, ' ').trim() : text.trim();
  return shaped === '' ? undefined : shaped;
}

/** An absolute http(s) URL, resolved against the feed URL; anything else is dropped. */
function safeUrl(value: string | undefined, ctx: EntryContext): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const url =
      ctx.baseUrl !== undefined ? new URL(value.trim(), ctx.baseUrl) : new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A date as ISO 8601, or undefined when it does not parse. */
function toIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  try {
    return new Date(time).toISOString();
  } catch {
    return undefined;
  }
}

/** Fallback identity for an entry with neither id nor link. */
function contentHash(
  title: string | undefined,
  date: string | undefined,
  summary: string | undefined,
): string | undefined {
  if (title === undefined && summary === undefined) return undefined;
  const digest = createHash('sha1')
    .update(`${title ?? ''}\n${date ?? ''}\n${summary ?? ''}`)
    .digest('hex');
  return `sha1:${digest}`;
}

/** A positive integer option, or the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
