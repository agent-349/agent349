import { describe, it, expect, beforeEach, vi, onTestFinished } from 'vitest';
import { PostgresDriver } from '../../../../src/tools/builtin/sql/PostgresDriver.js';
import { ConnectionError } from '../../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for `pg`, which the SDK does not depend on
// ─────────────────────────────────────────────────────────────────────────────

/** Records every statement, in order, and can fail the payload query. */
class FakeClient {
  readonly statements: string[] = [];
  released = false;
  failOn: string | null = null;

  async query(
    text: string,
    _values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }> {
    this.statements.push(text);
    if (this.failOn !== null && text.includes(this.failOn)) {
      throw new Error('relation "ghost" does not exist');
    }
    return { rows: [{ n: 1 }], fields: [{ name: 'n' }] };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  readonly client = new FakeClient();
  ended = false;

  async connect(): Promise<FakeClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const REQUEST = { text: 'SELECT 1', values: [], timeoutMs: 5000 };

let driver: PostgresDriver;
let pool: FakePool;

beforeEach(() => {
  driver = new PostgresDriver();
  pool = new FakePool();
});

// ─────────────────────────────────────────────────────────────────────────────
// Query execution
// ─────────────────────────────────────────────────────────────────────────────

describe('PostgresDriver.query', () => {
  // This ordering is the actual write guarantee: PostgreSQL refuses the write
  // itself, whatever the statement says and whatever grants the user holds.
  it('opens a read-only transaction before running anything', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.client.statements[0]).toBe('BEGIN READ ONLY');
    expect(pool.client.statements[1]).toBe('SET LOCAL statement_timeout = 5000');
    expect(pool.client.statements[2]).toBe('SELECT 1');
  });

  it('commits after a successful query', async () => {
    await driver.query(pool, REQUEST);
    expect(pool.client.statements.at(-1)).toBe('COMMIT');
  });

  it('returns the rows and the column names', async () => {
    const result = await driver.query(pool, REQUEST);

    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.fields).toEqual(['n']);
  });

  // Leaving the transaction open would poison the pooled connection for
  // whoever picks it up next.
  it('rolls back when the query fails', async () => {
    pool.client.failOn = 'SELECT';

    await expect(driver.query(pool, REQUEST)).rejects.toThrow(/does not exist/);
    expect(pool.client.statements).toContain('ROLLBACK');
  });

  it('releases the client whether the query succeeds or fails', async () => {
    pool.client.failOn = 'SELECT';
    await expect(driver.query(pool, REQUEST)).rejects.toThrow();

    expect(pool.client.released).toBe(true);
  });

  it('lets the driver error through so the caller decides who sees it', async () => {
    pool.client.failOn = 'SELECT';
    await expect(driver.query(pool, REQUEST)).rejects.toThrow('relation "ghost" does not exist');
  });

  it('refuses a resource that is not a pool', async () => {
    await expect(driver.query({ nope: true }, REQUEST)).rejects.toThrow(ConnectionError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('PostgresDriver lifecycle', () => {
  it('ends the pool on close', async () => {
    await driver.close(pool);
    expect(pool.ended).toBe(true);
  });

  it('ignores a close on something that is not a pool', async () => {
    await expect(driver.close(undefined)).resolves.toBeUndefined();
  });

  it('rejects a non-sql connection', async () => {
    await expect(
      driver.open({ type: 'http', baseUrl: 'https://example.com' }, { kind: 'none' }),
    ).rejects.toThrow(ConnectionError);
  });

  // `pg` is deliberately not a dependency of the SDK, so the failure has to
  // say what to do about it.
  it('explains how to fix a missing pg install', async () => {
    // `pg` is a dev dependency (for the pgvector tests): simulate its absence.
    vi.doMock('pg', () => {
      throw new Error("Cannot find module 'pg'");
    });
    onTestFinished(() => {
      vi.doUnmock('pg');
    });
    await expect(
      driver.open({ type: 'sql', driver: 'postgres', database: 'x' }, { kind: 'none' }),
    ).rejects.toThrow(/npm install pg|inject an/);
  });

  it('carries the postgres dialect', () => {
    expect(driver.dialect.name).toBe('postgres');
  });
});
