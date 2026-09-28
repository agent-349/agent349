// Document reading: PDF, Word, HTML and text, from bounded sources.
export { createDocReadTool } from './DocReadTool.js';
export type { DocReadToolConfig, DocSourceConfig } from './DocReadTool.js';
export { DocumentStore, FilesystemDocumentStore, mimeFromName } from './DocumentStore.js';
export type { FetchedDocument } from './DocumentStore.js';
export { extractFromBytes, extractText, selectPages } from './extract.js';
export type { ExtractedText } from './extract.js';
