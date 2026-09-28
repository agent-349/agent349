import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { PgVectorAdapter } from '../../../../src/rag/vectorstore/PgVectorAdapter.js';
import type { PgVectorPool } from '../../../../src/rag/vectorstore/PgVectorAdapter.js';
import { RAGError } from '../../../../src/errors/RAGError.js';

/** Fake pool that records queries and answers from a script. */
function fakePool(answer: (sql: string) => Record<string, unknown>[] = () => []) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool: PgVectorPool & { ended: boolean } = {
    ended: false,
    async query(sql, values = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      const rows = answer(sql);
      return { rows, rowCount: rows.length };
    },
    async end() {
      pool.ended = true;
    },
  };
  return { pool, queries };
}

const withMeta = (sql: string): Record<string, unknown>[] =>
  /to_regclass/.test(sql)
    ? [{ exists: true }]
    : /distance_metric FROM/.test(sql)
      ? [{ distance_metric: 'cosine' }]
      : [];

describe('PgVectorAdapter', () => {
  it('creates the table, the HNSW and full-text indexes, and the metadata row', async () => {
    const { pool, queries } = fakePool();
    const store = new PgVectorAdapter({ pool, textSearchConfig: 'spanish' });
    await store.createCollection('docs', {
      dimensions: 3,
      distanceMetric: 'dot',
      embeddingProvider: 'openai',
      embeddingModel: 'openai/text-embedding-3-small',
    });
    const sql = queries.map((q) => q.sql).join('\n');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."agent349_docs"');
    expect(sql).toContain('embedding vector(3)');
    expect(sql).toContain("to_tsvector('spanish'");
    expect(sql).toMatch(/USING hnsw \(embedding vector_ip_ops\)/);
    expect(queries.at(-1)!.values).toEqual([
      'docs',
      'openai',
      'openai/text-embedding-3-small',
      3,
      'dot',
    ]);
  });

  it('skips the HNSW index above 2 000 dimensions', async () => {
    const { pool, queries } = fakePool();
    await new PgVectorAdapter({ pool }).createCollection('big', {
      dimensions: 3072,
      distanceMetric: 'cosine',
      embeddingProvider: 'openai',
      embeddingModel: 'openai/text-embedding-3-large',
    });
    expect(queries.some((q) => q.sql.includes('hnsw'))).toBe(false);
  });

  it('translates filters into a parameterised WHERE clause', async () => {
    const { pool, queries } = fakePool(withMeta);
    const store = new PgVectorAdapter({ pool });
    await store.search('docs', [0.1, 0.2], 5, {
      tenantId: 'acme',
      accessRoles: ['hr'],
      tags: ['a'],
      tagsAll: ['b'],
      documentId: 'doc-1',
      language: 'en',
      dateRange: { from: new Date(1000), to: new Date(2000) },
      metadata: { dept: 'hr' },
    });
    const search = queries.find((q) => q.sql.startsWith('SELECT id'))!;
    expect(search.sql).toContain('embedding <=> $1::vector');
    expect(search.sql).toContain('(cardinality(access_roles) = 0 OR access_roles && $4::text[])');
    expect(search.sql).toContain('tags @> $6::text[]');
    expect(search.sql).toContain('custom @> $11::jsonb');
    expect(search.values).toEqual([
      '[0.1,0.2]',
      5,
      'acme',
      ['hr', '*'],
      ['a'],
      ['b'],
      ['doc-1'],
      'en',
      1000,
      2000,
      '{"dept":"hr"}',
    ]);
  });

  it('maps cosine distance to a [0, 1] score', async () => {
    const { pool } = fakePool((sql) =>
      sql.includes('ORDER BY embedding')
        ? [
            {
              id: 'a',
              content: 'x',
              document_id: 'd',
              access_roles: [],
              tags: [],
              custom: {},
              distance: 0,
            },
          ]
        : withMeta(sql),
    );
    const [top] = await new PgVectorAdapter({ pool }).search('docs', [1], 1);
    expect(top!.score).toBe(1);
  });

  it('refuses unscoped bulk operations', async () => {
    const { pool } = fakePool();
    const store = new PgVectorAdapter({ pool });
    await expect(store.removeDocumentsByFilter('docs', {})).rejects.toThrow(RAGError);
    await expect(store.updateDocumentsMetadata('docs', {}, { tags: ['x'] })).rejects.toThrow(
      RAGError,
    );
  });

  it('quotes identifiers and rejects reserved or oversized names', async () => {
    const { pool, queries } = fakePool();
    const store = new PgVectorAdapter({ pool });
    await store.delete('a"; DROP TABLE x; --', ['1']);
    expect(queries[0]!.sql).toBe(
      'DELETE FROM "public"."agent349_a""; DROP TABLE x; --" WHERE id = ANY($1::text[])',
    );
    await expect(store.delete('collections', ['1'])).rejects.toThrow(/reserved/);
    await expect(store.delete('x'.repeat(60), ['1'])).rejects.toThrow(/63 bytes/);
  });

  it('never closes an injected pool', async () => {
    const { pool } = fakePool();
    await new PgVectorAdapter({ pool }).close();
    expect(pool.ended).toBe(false);
  });

  it('explains how to fix a missing pg install', async () => {
    vi.doMock('pg', () => {
      throw new Error("Cannot find module 'pg'");
    });
    onTestFinished(() => {
      vi.doUnmock('pg');
    });
    await expect(
      new PgVectorAdapter({ connectionString: 'postgres://x' }).collectionExists('docs'),
    ).rejects.toThrow(/npm install pg/);
  });
});
