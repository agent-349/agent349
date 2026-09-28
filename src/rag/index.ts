// RAG module: Pipeline, Embedding, VectorStore, Reranker
export { EmbeddingProvider } from './embedding/EmbeddingProvider.js';
export { EmbeddingRouter } from './embedding/EmbeddingRouter.js';
export type { EmbeddingProviderInfo } from './embedding/EmbeddingRouter.js';
export { OpenAIEmbeddingProvider } from './embedding/OpenAIEmbedding.js';
export type { OpenAIEmbeddingConfig } from './embedding/OpenAIEmbedding.js';
export { CohereEmbeddingProvider } from './embedding/CohereEmbedding.js';
export type { CohereEmbeddingConfig, CohereInputType } from './embedding/CohereEmbedding.js';
export { OllamaEmbeddingProvider } from './embedding/OllamaEmbedding.js';
export type { OllamaEmbeddingConfig } from './embedding/OllamaEmbedding.js';
export { VectorStoreAdapter } from './vectorstore/VectorStoreAdapter.js';
export { InMemoryVectorStore } from './vectorstore/InMemoryVectorStore.js';
export { MeilisearchAdapter } from './vectorstore/MeilisearchAdapter.js';
export type { MeilisearchConfig } from './vectorstore/MeilisearchAdapter.js';
export { PgVectorAdapter } from './vectorstore/PgVectorAdapter.js';
export type { PgVectorConfig, PgVectorPool } from './vectorstore/PgVectorAdapter.js';
export { QdrantAdapter } from './vectorstore/QdrantAdapter.js';
export type { QdrantConfig } from './vectorstore/QdrantAdapter.js';
export { PineconeAdapter } from './vectorstore/PineconeAdapter.js';
export type { PineconeConfig } from './vectorstore/PineconeAdapter.js';
export { WeaviateAdapter } from './vectorstore/WeaviateAdapter.js';
export type { WeaviateConfig } from './vectorstore/WeaviateAdapter.js';
export { MilvusAdapter } from './vectorstore/MilvusAdapter.js';
export type { MilvusConfig } from './vectorstore/MilvusAdapter.js';
export { createVectorStoreAdapter } from './vectorstore/createVectorStoreAdapter.js';
export type {
  VectorStoreAdapterConfig,
  VectorStoreAdapterName,
} from './vectorstore/createVectorStoreAdapter.js';
export { reciprocalRankFusion } from './fusion/RRF.js';
export { RerankerProvider } from './reranker/RerankerProvider.js';
export { LLMReranker } from './reranker/LLMReranker.js';
export type { LLMRerankerConfig } from './reranker/LLMReranker.js';
export { CohereReranker } from './reranker/CohereReranker.js';
export type { CohereRerankerConfig } from './reranker/CohereReranker.js';
export { TEIReranker } from './reranker/TEIReranker.js';
export type { TEIRerankerConfig } from './reranker/TEIReranker.js';
export { QueryRewriter } from './queryRewriting/QueryRewriter.js';
export { ContextualRewriter } from './queryRewriting/ContextualRewriter.js';
export { HyDERewriter } from './queryRewriting/HyDERewriter.js';
export { RAGPipeline } from './RAGPipeline.js';
export { createRAGTool } from './RAGTool.js';
export type { RAGToolDefaults } from './RAGTool.js';
export { RAGFacade } from './RAGFacade.js';
export type { RAGFacadeEmbeddingDefaults } from './RAGFacade.js';
export type { RerankerValidation } from './types.js';

// Ingestion
export { IngestionPipeline } from './ingestion/IngestionPipeline.js';
export type { IngestionPipelineOptions } from './ingestion/IngestionPipeline.js';
export { DocumentLoaderRegistry } from './ingestion/DocumentLoaderRegistry.js';
export { DocumentLoader } from './ingestion/loaders/DocumentLoader.js';
export { PlainTextLoader } from './ingestion/loaders/PlainTextLoader.js';
export { MarkdownLoader } from './ingestion/loaders/MarkdownLoader.js';
export { HTMLLoader } from './ingestion/loaders/HTMLLoader.js';
export { PDFLoader } from './ingestion/loaders/PDFLoader.js';
export { DOCXLoader } from './ingestion/loaders/DOCXLoader.js';
export { ChunkingStrategy } from './ingestion/chunking/ChunkingStrategy.js';
export { RecursiveChunker } from './ingestion/chunking/RecursiveChunker.js';
export { FixedSizeChunker } from './ingestion/chunking/FixedSizeChunker.js';
export { MarkdownChunker } from './ingestion/chunking/MarkdownChunker.js';
export type {
  DocumentSource,
  RawDocument,
  TextChunk,
  ChunkingConfig,
  IngestOptions,
  IngestDirectoryOptions,
  IngestResult,
  IngestProgress,
  CollectionSummary,
} from './ingestion/types.js';
export { EXTENSION_TO_MIME } from './ingestion/types.js';

// Collections
export { CollectionManager } from './collections/CollectionManager.js';
