/**
 * `createRAGTool({ scopeFilters })`: host-enforced filters the model cannot
 * widen or drop, below the security filters.
 */
import { describe, it, expect } from 'vitest';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import type { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import type { RAGQuery, RAGResult } from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

const CONTEXT: ExecutionContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  roles: ['reader'],
  sessionId: 'sess-1',
  agentId: 'agent-1',
  requestId: 'req-1',
};

function stubPipeline(): { pipeline: RAGPipeline; queries: RAGQuery[] } {
  const queries: RAGQuery[] = [];
  const pipeline = {
    queryRewriter: undefined,
    async search(q: RAGQuery): Promise<RAGResult> {
      queries.push(q);
      return {
        passages: [],
        totalFound: 0,
        query: q.query,
        metrics: { totalLatencyMs: 1 },
      } as unknown as RAGResult;
    },
    formatForContext: () => '',
  } as unknown as RAGPipeline;
  return { pipeline, queries };
}

describe('createRAGTool — scopeFilters', () => {
  it('applies the host scope over the model input, below the security filters', async () => {
    const { pipeline, queries } = stubPipeline();
    const tool = createRAGTool(
      pipeline,
      ['docs'],
      {},
      {
        scopeFilters: (ctx) => ({
          tagsAll: ['cat:reglamento'],
          // A scope cannot override the security context.
          tenantId: 'other-tenant',
          ...(ctx.sessionId === 'sess-1' && { language: 'es' }),
        }),
      },
    );

    const result = await tool.execute(
      { query: 'q', filters: { tags: ['cat:otra'], language: 'en' } },
      CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(queries[0]!.filters).toEqual({
      tags: ['cat:otra'],
      language: 'es',
      tagsAll: ['cat:reglamento'],
      tenantId: 'tenant-1',
      accessRoles: ['reader'],
    });
  });

  it('runs unscoped when the resolver returns undefined', async () => {
    const { pipeline, queries } = stubPipeline();
    const tool = createRAGTool(pipeline, ['docs'], {}, { scopeFilters: async () => undefined });
    await tool.execute({ query: 'q' }, CONTEXT);
    expect(queries[0]!.filters).toEqual({ tenantId: 'tenant-1', accessRoles: ['reader'] });
  });

  it('fails the search instead of running unscoped when the scope cannot be resolved', async () => {
    const { pipeline, queries } = stubPipeline();
    const tool = createRAGTool(
      pipeline,
      ['docs'],
      {},
      {
        scopeFilters: () => {
          throw new Error('scope store down');
        },
      },
    );
    const result = await tool.execute({ query: 'q' }, CONTEXT);
    expect(result.success).toBe(false);
    expect(result.error).toContain('scope store down');
    expect(queries).toHaveLength(0);
  });
});
