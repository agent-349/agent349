/**
 * RAG module types.
 *
 * Canonical definitions live in `src/types/index.ts` (the shared type layer).
 * This file re-exports them so that intra-module imports stay local
 * (`./types.js`) without duplicating definitions or inverting the dependency
 * direction (rag → types, never types → rag).
 */
export type {
  DocumentMetadata,
  Passage,
  RAGFilter,
  RAGQuery,
  RAGResult,
  EmbeddingResult,
  RerankResult,
  RerankerValidation,
  ProviderProbe,
  CollectionInfo,
  CollectionConfig,
  VectorDocument,
  FormatOptions,
} from '../types/index.js';
