import { describe, it, expect, beforeEach } from 'vitest';
import { MySqlDriver } from '../../../../src/tools/builtin/sql/MySqlDriver.js';
import { ConnectionError } from '../../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for `mysql2/promise`, which is only an optional dependency
// ─────────────────────────────────────────────────────────────────────────────

/** One call recorded, kept apart by the method that made it. */
interface Call {
  via: 'query' | 'execute';
  sql: string;
  values?: unknown[];
}

/** Records every statement, in order, and can fail the payload statement. */
class FakeConnection {
  readonly calls: Call[] = [];
  released = false;
  failOnExecute = false;

  async query(sql: string, values?: unknown[]): Promise<[unknown, { name: string }[]]> {
    this.calls.push({ via: 'query', sql, ...(values !== undefined && { values }) });
    return [[], []];
  }

  async execute(sql: string, values?: unknown[]): Promise<[unknown, { name: string }[]]> {
    this.calls.push({ via: 'execute', sql, ...(values !== undefined && { values }) });
    if (this.failOnExecute) throw new Error("Table 'db.ghost' doesn't exist");
    return [[{ n: 1 }], [{ name: 'n' }]];
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  readonly connection = new FakeConnection();
  ended = false;

  async getConnection(): Promise<FakeConnection> {
    return this.connection;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const REQUEST = { text: 'SELECT 1', values: [], timeoutMs: 5000 };

/** Just the SQL of every call, in order. */
const statements = (pool: FakePool): string[] => pool.connection.calls.map((c) => c.sql);

let driver: MySqlDriver;
let pool: FakePool;

beforeEach(() => {
  driver = new MySqlDriver();
  pool = new FakePool();
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe('MySqlDriver identity', () => {
  it('defaults to the mysql flavour', () => {
    expect(driver.name).toBe('mysql');
    expect(driver.dialect.name).toBe('mysql');
  });

  // The driver id is what a connection's `driver` field is matched against, so
  // the flavour has to change both the id and the dialect together.
  it('carries the mariadb id and dialect when asked for it', () => {
    const maria = new MySqlDriver('mariadb');

    expect(maria.name).toBe('mariadb');
    expect(maria.dialect.name).toBe('mariadb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Query execution
// ─────────────────────────────────────────────────────────────────────────────

describe('MySqlDriver.query', () => {
  it('runs the session guards, the statement, and the commit, in order', async () => {
    await driver.query(pool, REQUEST);

    expect(statements(pool)).toEqual([
      'SET SESSION max_execution_time = 5000',
      'START TRANSACTION READ ONLY',
      'SELECT 1',
      'COMMIT',
    ]);
  });

  // The guarantee that does not depend on reading the statement.
  it('opens a read-only transaction before the statement', async () => {
    await driver.query(pool, REQUEST);
    const seen = statements(pool);

    expect(seen.indexOf('START TRANSACTION READ ONLY')).toBeLessThan(seen.indexOf('SELECT 1'));
  });

  // Values must be bound by the engine, never spliced into the SQL text — which
  // is what `execute()` gives and `query()` does not.
  it('sends the payload through execute() and the guards through query()', async () => {
    await driver.query(pool, { text: 'SELECT ?', values: [7], timeoutMs: 1000 });

    const payload = pool.connection.calls.find((c) => c.sql === 'SELECT ?');
    expect(payload?.via).toBe('execute');
    expect(payload?.values).toEqual([7]);
    for (const call of pool.connection.calls) {
      if (call.sql !== 'SELECT ?') expect(call.via).toBe('query');
    }
  });

  it('returns rows and column names', async () => {
    const result = await driver.query(pool, REQUEST);

    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.fields).toEqual(['n']);
  });

  it('uses the MariaDB timeout variable and unit for that flavour', async () => {
    await new MySqlDriver('mariadb').query(pool, REQUEST);

    expect(statements(pool)[0]).toBe('SET SESSION max_statement_time = 5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe('MySqlDriver.query failures', () => {
  // Leaving the transaction open would poison the pooled connection for whoever
  // picks it up next.
  it('rolls back and releases when the statement fails', async () => {
    pool.connection.failOnExecute = true;

    await expect(driver.query(pool, REQUEST)).rejects.toThrow(/ghost/);

    expect(statements(pool)).toContain('ROLLBACK');
    expect(statements(pool)).not.toContain('COMMIT');
    expect(pool.connection.released).toBe(true);
  });

  it('releases the connection on success too', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.connection.released).toBe(true);
  });

  it('rejects a resource that is not a mysql2 pool', async () => {
    await expect(driver.query({ nope: true }, REQUEST)).rejects.toThrow(ConnectionError);
  });

  // An OkPacket instead of an array means a non-SELECT slipped through. The
  // guards make it unreachable; an empty result is the truthful answer if not.
  it('returns no rows when the driver hands back a non-array result', async () => {
    pool.connection.execute = async () => [{ affectedRows: 0 }, []];

    const result = await driver.query(pool, REQUEST);

    expect(result.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('MySqlDriver lifecycle', () => {
  it('ends the pool on close', async () => {
    await driver.close(pool);

    expect(pool.ended).toBe(true);
  });

  // close() runs during shutdown, where throwing would block the rest of it.
  it('ignores a resource it does not recognise on close', async () => {
    await expect(driver.close({ nope: true })).resolves.toBeUndefined();
  });

  it('refuses to open a connection that is not of type sql', async () => {
    await expect(
      driver.open({ type: 'http', baseUrl: 'https://x' }, { kind: 'none' }),
    ).rejects.toThrow(ConnectionError);
  });

  // Building the pool must not contact the server: a data source whose host is
  // down has to be declarable, and the connection opens on first real use.
  it('builds a pool from the config without connecting', async () => {
    const resource = await driver.open(
      { type: 'sql', driver: 'mysql', host: '203.0.113.1', database: 'erp', pool: { max: 3 } },
      { kind: 'basic', username: 'ro', password: 'pw' },
    );

    expect(typeof (resource as { getConnection?: unknown }).getConnection).toBe('function');
    await driver.close(resource);
  });
});
