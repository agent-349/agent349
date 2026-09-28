import type { Tool } from '../types/index.js';
import type { RAGToolDefaults } from '../rag/RAGTool.js';
import { createRAGTool } from '../rag/RAGTool.js';
import type { InternalToolContext } from './internalToolContext.js';
import { createSqlQueryTool, createSqlSchemaTool } from './builtin/sql/index.js';
import type { SqlQueryToolConfig, SqlSchemaToolConfig } from './builtin/sql/index.js';
import { createMongoQueryTool, createMongoSchemaTool } from './builtin/mongo/index.js';
import type { MongoQueryToolConfig, MongoSchemaToolConfig } from './builtin/mongo/index.js';
import {
  createFeedReadTool,
  createHttpRequestTool,
  createWebReadTool,
} from './builtin/http/index.js';
import type {
  FeedReadToolConfig,
  HttpRequestToolConfig,
  WebReadToolConfig,
} from './builtin/http/index.js';
import { createDocReadTool } from './builtin/doc/index.js';
import type { DocReadToolConfig } from './builtin/doc/index.js';
import { createFileReadTool } from './builtin/file/index.js';
import type { FileReadToolConfig } from './builtin/file/index.js';
import { createMailSendTool } from './builtin/mail/index.js';
import type { MailSendToolConfig } from './builtin/mail/index.js';

export type { InternalToolContext } from './internalToolContext.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal tool factories
// ─────────────────────────────────────────────────────────────────────────────

/** Config shape accepted by the `rag.search` internal tool. */
interface RAGSearchConfig extends RAGToolDefaults {
  /** Collections searched when the LLM omits `collections`. */
  collections?: string[];
}

/**
 * Builds a {@link Tool} from declarative `config`, using SDK-internal services.
 * Returning a fresh tool on each call lets a single `ref` be declared multiple
 * times under different names and configurations.
 */
export type InternalToolFactory = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  ctx: InternalToolContext,
) => Tool;

/**
 * Registry of SDK-provided tools, keyed by the `ref` used in a declarative
 * {@link import('../types/index.js').InternalToolDefinition}.
 */
export const INTERNAL_TOOL_FACTORIES: Readonly<Record<string, InternalToolFactory>> = {
  'rag.search': (config, ctx): Tool => {
    const { collections, ...retrieval } = (config ?? {}) as RAGSearchConfig;
    return createRAGTool(ctx.getRAGPipeline(), collections ?? ['default'], {
      ...ctx.ragRetrievalDefaults,
      ...retrieval,
    });
  },
  'sql.query': (config, ctx): Tool => createSqlQueryTool((config ?? {}) as SqlQueryToolConfig, ctx),
  'sql.schema': (config, ctx): Tool =>
    createSqlSchemaTool((config ?? {}) as SqlSchemaToolConfig, ctx),
  'mongo.query': (config, ctx): Tool =>
    createMongoQueryTool((config ?? {}) as MongoQueryToolConfig, ctx),
  'mongo.schema': (config, ctx): Tool =>
    createMongoSchemaTool((config ?? {}) as MongoSchemaToolConfig, ctx),
  'http.request': (config, ctx): Tool =>
    createHttpRequestTool((config ?? {}) as HttpRequestToolConfig, ctx),
  'web.read': (config, ctx): Tool => createWebReadTool((config ?? {}) as WebReadToolConfig, ctx),
  'feed.read': (config, ctx): Tool => createFeedReadTool((config ?? {}) as FeedReadToolConfig, ctx),
  'doc.read': (config, ctx): Tool => createDocReadTool((config ?? {}) as DocReadToolConfig, ctx),
  'file.read': (config, ctx): Tool => createFileReadTool((config ?? {}) as FileReadToolConfig, ctx),
  'mail.send': (config, ctx): Tool => createMailSendTool((config ?? {}) as MailSendToolConfig, ctx),
};

/** Ids of all tools the SDK can build from an `internal` definition. */
export const INTERNAL_TOOL_IDS: readonly string[] = Object.keys(INTERNAL_TOOL_FACTORIES);

/** Returns `true` if `ref` matches a known internal tool factory. */
export function isInternalToolRef(ref: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTERNAL_TOOL_FACTORIES, ref);
}
