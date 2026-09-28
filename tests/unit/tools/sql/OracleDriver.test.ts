import { describe, it, expect, beforeEach, vi, onTestFinished } from 'vitest';
import { OracleDriver } from '../../../../src/tools/builtin/sql/OracleDriver.js';
import { ConnectionError } from '../../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for `oracledb`, which is only an optional dependency
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  sql: string;
  binds?: unknown[];
}

class FakeConnection {
  readonly calls: Call[] = [];
  callTimeout: number | undefined;
  closed = false;
  failOn: string | null = null;

  async execute(
    sql: string,
    binds?: unknown[],
  ): Promise<{
    rows: Record<string, unknown>[];
    metaData: { name: string }[];
  }> {
    this.calls.push({ sql, ...(binds !== undefined && { binds }) });
    if (this.failOn !== null && sql.includes(this.failOn)) {
      throw new Error('ORA-00942: table or view does not exist');
    }
    return { rows: [{ N: 1 }], metaData: [{ name: 'N' }] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakePool {
  readonly connection = new FakeConnection();
  closed = false;

  async getConnection(): Promise<FakeConnection> {
    return this.connection;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const REQUEST = { text: 'SELECT 1 FROM dual', values: [], timeoutMs: 5000 };
const statements = (pool: FakePool): string[] => pool.connection.calls.map((c) => c.sql);

let driver: OracleDriver;
let pool: FakePool;

beforeEach(() => {
  driver = new OracleDriver();
  pool = new FakePool();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('OracleDriver identity', () => {
  it('answers to the oracle driver id and dialect', () => {
    expect(driver.name).toBe('oracle');
    expect(driver.dialect.name).toBe('oracle');
  });
});

describe('OracleDriver.query', () => {
  // Engine-enforced read-only, same guarantee as PostgreSQL.
  it('runs the read-only transaction, the statement, and commits, in order', async () => {
    await driver.query(pool, REQUEST);

    expect(statements(pool)).toEqual(['SET TRANSACTION READ ONLY', 'SELECT 1 FROM dual', 'COMMIT']);
  });

  it('opens the read-only transaction before the statement', async () => {
    await driver.query(pool, REQUEST);
    const seen = statements(pool);

    expect(seen.indexOf('SET TRANSACTION READ ONLY')).toBeLessThan(
      seen.indexOf('SELECT 1 FROM dual'),
    );
  });

  it('passes values as binds, never spliced into the statement', async () => {
    await driver.query(pool, { text: 'SELECT :1 FROM dual', values: [7], timeoutMs: 1000 });

    const payload = pool.connection.calls.find((c) => c.sql.includes(':1'));
    expect(payload?.binds).toEqual([7]);
  });

  // Oracle has no session statement timeout; callTimeout bounds each round trip.
  it('bounds the call with callTimeout', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.connection.callTimeout).toBe(5000);
  });

  it('returns rows and column names from the metadata', async () => {
    const result = await driver.query(pool, REQUEST);

    expect(result.rows).toEqual([{ N: 1 }]);
    expect(result.fields).toEqual(['N']);
  });

  // Leaving the read-only transaction open would carry its snapshot into
  // whatever runs next on this pooled connection.
  it('rolls back and releases the connection when the statement fails', async () => {
    pool.connection.failOn = 'ghost';

    await expect(
      driver.query(pool, { text: 'SELECT * FROM ghost', values: [], timeoutMs: 1000 }),
    ).rejects.toThrow(/ORA-00942/);

    expect(statements(pool)).toContain('ROLLBACK');
    expect(statements(pool)).not.toContain('COMMIT');
    expect(pool.connection.closed).toBe(true);
  });

  it('releases the connection on success too', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.connection.closed).toBe(true);
  });

  it('rejects a resource that is not an oracledb pool', async () => {
    await expect(driver.query({ nope: true }, REQUEST)).rejects.toThrow(ConnectionError);
  });
});

describe('OracleDriver lifecycle', () => {
  it('closes the pool', async () => {
    await driver.close(pool);
    expect(pool.closed).toBe(true);
  });

  it('ignores a resource it does not recognise on close', async () => {
    await expect(driver.close({ nope: true })).resolves.toBeUndefined();
  });

  it('refuses a connection that is not of type sql', async () => {
    await expect(
      driver.open({ type: 'http', baseUrl: 'https://x' }, { kind: 'none' }),
    ).rejects.toThrow(ConnectionError);
  });

  it('reports a missing oracledb install with an actionable message', async () => {
    // `oracledb` is an optional dependency and may be installed: simulate its absence.
    vi.doMock('oracledb', () => {
      throw new Error("Cannot find module 'oracledb'");
    });
    onTestFinished(() => {
      vi.doUnmock('oracledb');
    });
    await expect(
      driver.open({ type: 'sql', driver: 'oracle', host: 'h', database: 'ORCL' }, { kind: 'none' }),
    ).rejects.toThrow(/oracledb/);
  });
});
