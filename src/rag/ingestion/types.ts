/**
 * Types for the document ingestion pipeline.
 *
 * Re-exports shared types from `src/types/index.ts` and defines
 * ingestion-specific types used within this module.
 */
export type { DocumentMetadata, CollectionConfig } from '../../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Document Source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Describes the origin of a document to be ingested.
 */
export interface DocumentSource {
  /** Content origin type. */
  type: 'file' | 'url' | 'buffer' | 'text';
  /** For `type='file'`: path to the file on disk. */
  path?: string;
  /** For `type='url'`: URL to fetch the document from. */
  url?: string;
  /** For `type='buffer'`: raw binary content. */
  buffer?: Buffer;
  /** For `type='text'`: content string to ingest directly. */
  text?: string;
  /** MIME type. Auto-detected from file extension when omitted. */
  mimeType?: string;
  /** Metadata fields to merge into the extracted document metadata. */
  metadata?: Partial<import('../../types/index.js').DocumentMetadata>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw Document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of a document loader: raw extracted text plus metadata.
 */
export interface RawDocument {
  /** Full extracted text content. */
  content: string;
  /** Auto-detected and user-supplied metadata merged together. */
  metadata: import('../../types/index.js').DocumentMetadata;
  /** Number of pages, if available (e.g. PDF). */
  pages?: number;
  /** Identifies which loader extracted this document. */
  extractionMethod: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Chunk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single chunk of text produced by a chunking strategy.
 */
export interface TextChunk {
  /** Text content of this chunk. */
  content: string;
  /** Zero-based position of this chunk within the document. */
  index: number;
  /** Character offset from the start of the document. */
  startOffset: number;
  /** Exclusive character offset at the end of this chunk. */
  endOffset: number;
  /** Metadata inherited from the source document, extended with chunk fields. */
  metadata: import('../../types/index.js').DocumentMetadata;
  /** SHA-256 hex digest of the chunk content (used for deduplication). */
  contentHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Controls how documents are split into chunks before embedding.
 */
export interface ChunkingConfig {
  /** Chunking algorithm to use. */
  strategy: 'recursive' | 'fixed_size' | 'markdown';
  /** Target chunk size in tokens. Default: 512. */
  chunkSize: number;
  /** Token overlap between consecutive chunks. Default: 50. */
  chunkOverlap: number;
  /** Minimum chunk size; smaller chunks are discarded. Default: 100. */
  minChunkSize?: number;
  /**
   * Ordered list of separator strings for the recursive strategy.
   * Splitting is attempted from the first separator down; the next is used
   * only when the text cannot be split by the current one.
   * Default: `['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ']`
   */
  separators?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for a single ingest operation.
 */
export interface IngestOptions {
  /** Chunking configuration. Merges with pipeline defaults. */
  chunking?: Partial<ChunkingConfig>;
  /** Maximum number of chunks per embedding API batch. Default: 50. */
  embeddingBatchSize?: number;
  /** Maximum number of documents per vector store upsert batch. Default: 100. */
  upsertBatchSize?: number;
  /** Skip chunks whose content hash already exists for this document. Default: true. */
  deduplication?: boolean;
  /** Delete previous chunks for the document before inserting new ones. Default: true. */
  overwriteExisting?: boolean;
  /** Additional metadata to merge into every chunk. */
  metadata?: Partial<import('../../types/index.js').DocumentMetadata>;
  /** Progress callback invoked after each batch step. */
  onProgress?: (progress: IngestProgress) => void;
}

/**
 * Options for ingesting all files in a directory.
 */
export interface IngestDirectoryOptions extends IngestOptions {
  /** Scan subdirectories recursively. Default: true. */
  recursive?: boolean;
  /** Process only files with these extensions. Default: all supported. */
  extensions?: string[];
  /**
   * Directory or filename patterns to skip.
   * Default: `['node_modules', '.git']`
   */
  ignorePatterns?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest Result & Progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned after a successful ingest operation.
 */
export interface IngestResult {
  /** The document ID assigned to or found in the ingested document. */
  documentId: string;
  /** Source reference: file path, URL, or '[buffer]' / '[text]'. */
  source: string;
  /** Number of chunks inserted into the vector store. */
  chunksCreated: number;
  /** Number of chunks that were skipped due to deduplication. */
  chunksSkipped: number;
  /** Total embedding tokens consumed. */
  tokensUsed: number;
  /** End-to-end duration in milliseconds. */
  durationMs: number;
  /** Non-fatal error messages collected during processing. */
  errors?: string[];
}

/**
 * Progress snapshot emitted during an ingest operation.
 */
export interface IngestProgress {
  /** Current pipeline phase. */
  phase: 'loading' | 'chunking' | 'embedding' | 'upserting';
  /** Index of the document currently being processed (0-based within the batch). */
  documentIndex: number;
  /** Total documents in the current batch. */
  totalDocuments: number;
  /** Number of chunks processed so far. */
  chunksProcessed: number;
  /** Total chunks to process. */
  totalChunks: number;
  /** Completion percentage (0–100). */
  percentage: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summary information about a vector store collection.
 */
export interface CollectionSummary {
  /** Collection name. */
  name: string;
  /** Number of source documents indexed. */
  documentCount: number;
  /** Total number of chunks stored. */
  chunkCount: number;
  /** Vector dimensionality. */
  dimensions: number;
  /** Embedding provider used for this collection. */
  embeddingProvider: string;
  /** Embedding model used for this collection. */
  embeddingModel: string;
  /** Distance metric for similarity search. */
  distanceMetric: string;
  /** When the collection was created. */
  createdAt?: Date;
  /** When the collection was last modified. */
  lastUpdatedAt?: Date;
  /** Approximate size in bytes (if available). */
  sizeBytes?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension map (exported so loaders can use it)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps file extensions to MIME types for auto-detection.
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.csv': 'text/plain',
};
