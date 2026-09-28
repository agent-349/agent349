import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExecutionContext } from '../../../types/index.js';
import { resolveInsideRoot } from '../pathJail.js';

/** A document handed back by a store. */
export interface FetchedDocument {
  /** Raw bytes. */
  bytes: Uint8Array;
  /** MIME type, as well as the store can determine it. */
  mimeType: string;
  /** Original file name, when known. */
  fileName?: string;
}

/**
 * Resolves an opaque document reference to bytes.
 *
 * Named `DocumentStore` rather than `DocumentSource` to stay clear of the RAG
 * ingestion type of that name, which describes something different.
 *
 * ### Why a host would implement one
 * `doc.read` must never become a general-purpose reader of the server's
 * filesystem. When documents live in an application's own store, with its own
 * permissions, the host implements this and applies its access control before
 * returning anything. `fetch()` receives the {@link ExecutionContext} precisely
 * so it can.
 *
 * @example
 * ```typescript
 * class AttachmentStore extends DocumentStore {
 *   readonly name = 'attachments';
 *
 *   async fetch(ref: string, context: ExecutionContext): Promise<FetchedDocument> {
 *     const file = await this.repo.find(ref);
 *     if (!(await this.acl.canRead(context.userId, file))) {
 *       throw new AccessDeniedError('document', ref, context.roles);
 *     }
 *     return { bytes: await this.repo.bytes(file), mimeType: file.mimeType };
 *   }
 * }
 * ```
 */
export abstract class DocumentStore {
  /** Store id, matched against the `source` the model names. */
  abstract readonly name: string;

  /**
   * Returns the document behind `ref`.
   *
   * @param ref     - Reference supplied by the model.
   * @param context - Execution context, for the store's own access control.
   * @throws {@link AccessDeniedError} when the caller may not read it.
   */
  abstract fetch(ref: string, context: ExecutionContext): Promise<FetchedDocument>;
}

/**
 * A store serving files from one directory.
 *
 * ### Staying inside the corral
 * The reference is resolved against `root` and then checked **after symlinks
 * are followed** (see {@link resolveInsideRoot}). Rejecting `..` alone is not
 * enough: a symlink sitting inside the permitted directory and pointing outside
 * it would otherwise hand the model any file the process can read.
 */
export class FilesystemDocumentStore extends DocumentStore {
  override readonly name: string;
  readonly #root: string;

  /**
   * @param name - Store id used by the model.
   * @param root - Directory documents are read from.
   */
  constructor(name: string, root: string) {
    super();
    this.name = name;
    this.#root = resolve(root);
  }

  /**
   * Reads a file from the configured root.
   *
   * @param ref     - Path relative to the root.
   * @param context - Execution context; its roles are reported on a refusal.
   * @throws {@link ValidationError} for a reference that tries to leave the root.
   * @throws {@link AccessDeniedError} when the resolved file lies outside it.
   */
  override async fetch(ref: string, context: ExecutionContext): Promise<FetchedDocument> {
    const real = await resolveInsideRoot(this.#root, ref, {
      field: 'ref',
      noun: 'document reference',
      resource: 'document',
      notFound: 'document',
      roles: context.roles,
    });

    return {
      bytes: await readFile(real),
      mimeType: mimeFromName(real),
      fileName: ref,
    };
  }
}

/** Guesses a MIME type from a file name, for the formats this SDK reads. */
export function mimeFromName(fileName: string): string {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'md':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
