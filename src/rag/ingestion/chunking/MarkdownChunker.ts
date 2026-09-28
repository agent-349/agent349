import { createHash } from 'node:crypto';
import type { DocumentMetadata } from '../types.js';
import type { RawDocument, TextChunk, ChunkingConfig } from '../types.js';
import { ChunkingStrategy, tokenCount } from './ChunkingStrategy.js';
import { RecursiveChunker } from './RecursiveChunker.js';

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownChunker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits Markdown documents by header boundaries, preserving the hierarchy.
 *
 * Each section (`## Header\n<body>`) becomes a chunk candidate. Sections that
 * exceed `chunkSize` are further split with {@link RecursiveChunker}. The
 * header path (e.g. `"# Root > ## Section"`) is recorded in `metadata.custom`.
 *
 * Sub-sections carry their parent headers in the chunk text so the LLM retains
 * full context even when a section is split across multiple chunks.
 */
export class MarkdownChunker extends ChunkingStrategy {
  override readonly name = 'markdown';

  readonly #recursive = new RecursiveChunker();

  override chunk(document: RawDocument, config: ChunkingConfig): TextChunk[] {
    const chunkSize = config.chunkSize ?? 512;
    const minSize = config.minChunkSize ?? 100;

    const sections = parseSections(document.content);
    const allChunks: string[] = [];
    const headerPaths: string[] = [];

    for (const section of sections) {
      const headerPath = section.headers.join(' > ');
      const text =
        section.headers.length > 0
          ? `${section.headers[section.headers.length - 1]}\n${section.body}`
          : section.body;

      if (tokenCount(text) <= chunkSize) {
        if (tokenCount(text) >= minSize) {
          allChunks.push(text.trim());
          headerPaths.push(headerPath);
        }
      } else {
        // Sub-split using recursive strategy
        const fakeDoc: RawDocument = {
          content: text,
          metadata: document.metadata,
          extractionMethod: document.extractionMethod,
        };
        const subChunks = this.#recursive.chunk(fakeDoc, config);
        for (const sc of subChunks) {
          allChunks.push(sc.content);
          headerPaths.push(headerPath);
        }
      }
    }

    const total = allChunks.length;
    return allChunks.map((text, idx) => {
      const metadata: DocumentMetadata = {
        ...document.metadata,
        chunkIndex: idx,
        totalChunks: total,
        custom: {
          ...document.metadata.custom,
          headerPath: headerPaths[idx] ?? '',
        },
      };

      return {
        content: text,
        index: idx,
        startOffset: 0,
        endOffset: text.length,
        metadata,
        contentHash: createHash('sha256').update(text, 'utf-8').digest('hex'),
      } satisfies TextChunk;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Section {
  headers: string[];
  body: string;
}

/**
 * Splits a Markdown string into sections at header boundaries.
 *
 * Headers are defined as lines starting with one or more `#` characters.
 * The hierarchy is tracked so each section knows its full ancestor chain.
 */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];

  let currentHeaders: string[] = [];
  let bodyLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const headerMatch = /^(#{1,6})\s+(.*)/.exec(line);
    if (headerMatch) {
      // Flush current section
      if (inSection && bodyLines.length > 0) {
        sections.push({
          headers: [...currentHeaders],
          body: bodyLines.join('\n').trim(),
        });
      }

      const level = headerMatch[1]!.length;
      const heading = line;

      // Update header stack: keep ancestors up to this level
      currentHeaders = currentHeaders.slice(0, level - 1);
      currentHeaders.push(heading);
      bodyLines = [];
      inSection = true;
    } else {
      bodyLines.push(line);
    }
  }

  // Flush final section
  if (bodyLines.length > 0 || !inSection) {
    sections.push({
      headers: [...currentHeaders],
      body: bodyLines.join('\n').trim(),
    });
  }

  return sections.filter((s) => s.body.trim().length > 0 || s.headers.length > 0);
}
