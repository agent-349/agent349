import type { Tool, ExecutionContext, ToolResult } from '../types/index.js';
import type { RAGQuery } from './types.js';
import type { RAGPipeline } from './RAGPipeline.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input schema shape for the `rag.search` tool.
 * Typed explicitly so `execute()` can treat `input` as a known object.
 */
interface RAGToolInput {
  query: string;
  collections?: string[];
  filters?: {
    tags?: string[];
    language?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default retrieval parameters applied to every `rag.search` invocation.
 * All fields are optional — omitted fields use the pipeline's built-in defaults.
 * The LLM can override individual fields via the tool input (except security
 * context fields `tenantId` and `accessRoles`).
 */
export interface RAGToolDefaults {
  topK?: number;
  finalTopK?: number;
  searchMode?: 'vector' | 'keyword' | 'hybrid';
  hybridAlpha?: number;
  minScore?: number;
  rerank?: boolean;
  rrfK?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a `rag.search` {@link Tool} that wraps a {@link RAGPipeline}.
 *
 * The tool is designed to be registered with the {@link ToolRegistry} and
 * invoked by the Agent Loop. It automatically injects the execution context's
 * `tenantId` and `roles` into every RAG query for tenant isolation and ACL
 * enforcement, regardless of what the LLM specifies in the input.
 *
 * **Input schema:**
 * ```json
 * {
 *   "query":       "text to search for",
 *   "collections": ["optional", "list"],
 *   "filters": {
 *     "tags":     ["optional", "tags"],
 *     "language": "en"
 *   }
 * }
 * ```
 *
 * **Output on success:**
 * ```json
 * {
 *   "context":      "formatted passages for LLM",
 *   "sourcesCount": 3,
 *   "sources": [
 *     { "title": "...", "source": "...", "score": "0.847" }
 *   ]
 * }
 * ```
 *
 * @param pipeline           - The configured {@link RAGPipeline} to delegate searches to.
 * @param defaultCollections - Default collection names used when the LLM omits `collections`.
 *                             Defaults to `['default']`.
 * @param defaults           - Default retrieval parameters loaded from `SDKConfig.rag.retrieval`.
 *                             LLM input overrides these (except security fields).
 * @returns A {@link Tool} instance ready for registration.
 *
 * @example
 * ```typescript
 * const ragTool = createRAGTool(pipeline, ['corporate-docs'], { topK: 10, finalTopK: 5 });
 * toolRegistry.register(ragTool);
 * ```
 */
export function createRAGTool(
  pipeline: RAGPipeline,
  defaultCollections: string[] = ['default'],
  defaults: RAGToolDefaults = {},
): Tool {
  return {
    name: 'rag.search',
    description:
      'Searches the corporate knowledge base for relevant information. ' +
      'Use this tool when you need to retrieve facts, documentation, or context ' +
      'that may not be in your training data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query — a natural language question or topic.',
        },
        collections: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of collection names to search. Defaults to the configured collections.',
        },
        filters: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Restrict results to documents carrying at least one of these tags (OR).',
            },
            language: {
              type: 'string',
              description: 'Restrict results to documents in this language (ISO 639-1 code).',
            },
          },
        },
      },
      required: ['query'],
    },
    tags: ['rag', 'knowledge', 'read-only'],
    timeout: 60_000,

    async execute(input: RAGToolInput, context: ExecutionContext): Promise<ToolResult> {
      const ragQuery: RAGQuery = {
        // Defaults applied first; LLM input overrides them.
        ...defaults,
        query: input.query,
        collections: input.collections ?? defaultCollections,
        filters: {
          ...input.filters,
          // Automatically inject security context — the LLM cannot override these.
          tenantId: context.tenantId,
          accessRoles: context.roles,
        },
      };

      try {
        const result = await pipeline.search(ragQuery, context);
        const formatted = pipeline.formatForContext(result.passages);

        return {
          success: true,
          data: {
            context: formatted,
            sourcesCount: result.passages.length,
            sources: result.passages.map((p) => ({
              title: p.metadata.title,
              source: p.metadata.source,
              score: p.score.toFixed(3),
            })),
          },
          passages: result.passages,
          metadata: {
            durationMs: result.metrics.totalLatencyMs,
            ...(result.metrics.tokensUsed !== undefined && {
              tokensUsed: result.metrics.tokensUsed,
            }),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'RAG search failed',
        };
      }
    },
  };
}
