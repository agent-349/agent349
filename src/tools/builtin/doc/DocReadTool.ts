import { AccessDeniedError, ValidationError } from '../../../errors/index.js';
import type { ExecutionContext, Tool, ToolResult } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { truncateText } from '../limits.js';
import { DocumentStore, FilesystemDocumentStore } from './DocumentStore.js';
import { extractFromBytes, selectPages } from './extract.js';

/** A document origin declared in the tool config. */
export interface DocSourceConfig {
  /** Store id the model names in its input. */
  name: string;
  /** `'fs'` reads from a directory; `'store'` uses a host-injected store. */
  kind: 'fs' | 'store';
  /** Directory documents are read from. Required for `'fs'`. */
  root?: string;
}

/** Configuration for {@link createDocReadTool}. */
export interface DocReadToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Description sent to the LLM. */
  description?: string;
  /** Where documents may be read from. */
  sources: DocSourceConfig[];
  /** Characters of text returned. Default `40000`. */
  maxChars?: number;
  /** Bytes a document may occupy before it is refused. Default `20 MB`. */
  maxBytes?: number;
}

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_BYTES = 20_971_520;

/**
 * Builds a `doc.read` tool: extracts the text of one PDF or Word document.
 *
 * Supported: PDF, Word (`.docx`), HTML and plain text — reusing the very
 * libraries the RAG loaders already depend on, so nothing new is installed.
 * **Excel is deliberately absent**: no installed dependency reads `.xlsx`, and
 * none was added for it.
 *
 * ### Where documents come from
 * The critical question is not parsing but reachability. A tool that accepts an
 * arbitrary path is a reader of the whole server filesystem. Two origins are
 * offered, and both are bounded: a `fs` source resolves inside a declared root
 * and re-checks after following symlinks, and a `store` source hands the
 * reference to a host-injected {@link DocumentStore} that applies its own
 * access control.
 *
 * ### When not to use it
 * This is for one document the user pointed at. For questions over a corpus,
 * ingest it and use `rag.search`: dumping a 300-page PDF into the context is
 * expensive and answers worse than retrieving the relevant passages.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} for a malformed source declaration.
 */
export function createDocReadTool(config: DocReadToolConfig, ctx: InternalToolContext): Tool {
  const name = config.name ?? 'doc.read';
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  if (config.sources.length === 0) {
    throw new ValidationError(`${name}.sources`, 'declare at least one document source');
  }

  const stores = new Map<string, DocumentStore>();
  for (const source of config.sources) {
    if (source.kind === 'fs') {
      if (source.root === undefined || source.root === '') {
        throw new ValidationError(
          `${name}.sources.${source.name}.root`,
          "a source of kind 'fs' needs a root directory",
        );
      }
      stores.set(source.name, new FilesystemDocumentStore(source.name, source.root));
      continue;
    }

    const injected = ctx.documentStores?.[source.name];
    if (injected === undefined) {
      throw new ValidationError(
        `${name}.sources.${source.name}`,
        `no DocumentStore named '${source.name}' was injected. Provide it via ` +
          'OrchestratorOverrides.documentStores.',
      );
    }
    stores.set(source.name, injected);
  }

  const names = [...stores.keys()];

  return {
    name,
    description:
      config.description ??
      `Reads a PDF, Word, HTML or text document and returns its text. ` +
        `Available sources: ${names.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: names,
          description: `Which document source to read from. One of: ${names.join(', ')}.`,
        },
        ref: {
          type: 'string',
          description: 'Identifier of the document within that source.',
        },
        pages: {
          type: 'string',
          description:
            "Page range for PDFs, e.g. '3' or '3-8'. Omit for the whole document. " +
            'Use it to read a long document in parts.',
        },
      },
      required: ['source', 'ref'],
      additionalProperties: false,
    },
    async execute(
      input: { source?: unknown; ref?: unknown; pages?: unknown },
      context: ExecutionContext,
    ): Promise<ToolResult> {
      const sourceName = typeof input?.source === 'string' ? input.source : '';
      const ref = typeof input?.ref === 'string' ? input.ref : '';
      const pages = typeof input?.pages === 'string' ? input.pages : undefined;

      const store = stores.get(sourceName);
      if (store === undefined) {
        return {
          success: false,
          error: `Unknown source '${sourceName}'. Available: ${names.join(', ')}.`,
        };
      }
      if (ref === '') {
        return { success: false, error: 'No document reference was supplied.' };
      }

      let document;
      try {
        document = await store.fetch(ref, context);
      } catch (err) {
        if (err instanceof AccessDeniedError || err instanceof ValidationError) {
          return { success: false, error: err.message };
        }
        return {
          success: false,
          error: `The document could not be read: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (document.bytes.byteLength > maxBytes) {
        return {
          success: false,
          error:
            `The document is ${document.bytes.byteLength} bytes, over the ${maxBytes}-byte limit. ` +
            'Ingest it into the knowledge base and search it instead of reading it whole.',
        };
      }

      let extracted;
      try {
        extracted = await extractFromBytes(
          document.bytes,
          document.mimeType,
          document.fileName ?? ref,
        );
      } catch (err) {
        return {
          success: false,
          error: `The document could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const selected = selectPages(extracted.text, pages);
      const cut = truncateText(selected.text, maxChars);

      return {
        success: true,
        data: {
          source: sourceName,
          ref,
          ...(extracted.title !== undefined && { title: extracted.title }),
          ...(extracted.pages !== undefined && { pages: extracted.pages }),
          ...(selected.applied && { pageRange: pages, totalPages: selected.totalPages }),
          text: cut.text,
          ...(cut.truncated && {
            truncated: true,
            notice:
              `${cut.notice ?? ''} For a PDF, ask for a page range to read the rest in parts.`.trim(),
          }),
        },
      };
    },
  };
}
