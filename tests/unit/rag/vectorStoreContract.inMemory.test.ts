import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { describeVectorStoreContract } from '../../fixtures/vectorStoreContract.js';

// The in-memory store is the reference implementation of the adapter contract.
describeVectorStoreContract('InMemoryVectorStore', () => new InMemoryVectorStore(), {
  keyword: true,
  metadataFilter: true,
});
