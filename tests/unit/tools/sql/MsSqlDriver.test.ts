import { describe, it, expect, beforeEach, vi, onTestFinished } from 'vitest';
import { MsSqlDriver } from '../../../../src/tools/builtin/sql/MsSqlDriver.js';
import { ConnectionError } from '../../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for `mssql`, which is only an optional dependency
// ─────────────────────────────────────────────────────────────────────────────

class FakeRequest {
  timeout: number | undefined;
  readonly inputs: Record<string, unknown> = {};
  constructor(private readonly tx: FakeTransaction) {}

  input(name: string, value: unknown): FakeRequest {
    this.inputs[name] = value;
    return this;
  }

  async query(text: string): Promise<{ recordset: Record<string, unknown>[] }> {
    // Registrado por sentencia: cada Request es nuevo, así que guardar sólo el
    // último dejaría los binds del payload pisados por el guard siguiente.
    this.tx.calls.push({ sql: text, inputs: { ...this.inputs } });
    if (this.tx.failOn !== null && text.includes(this.tx.failOn)) {
      throw new Error("Invalid object name 'ghost'.");
    }
    return { recordset: [{ n: 1 }] };
  }
}

class FakeTransaction {
  readonly calls: { sql: string; inputs: Record<string, unknown> }[] = [];
  begun = false;
  rolledBack = false;
  committed = false;
  failOn: string | null = null;

  get statements(): string[] {
    return this.calls.map((c) => c.sql);
  }

  inputsFor(sql: string): Record<string, unknown> {
    return this.calls.find((c) => c.sql === sql)?.inputs ?? {};
  }

  async begin(): Promise<void> {
    this.begun = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  request(): FakeRequest {
    return new FakeRequest(this);
  }
}

class FakePool {
  readonly tx = new FakeTransaction();
  closed = false;

  transaction(): FakeTransaction {
    return this.tx;
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

const REQUEST = { text: 'SELECT 1', values: [], timeoutMs: 5000 };

let driver: MsSqlDriver;
let pool: FakePool;

beforeEach(() => {
  driver = new MsSqlDriver();
  pool = new FakePool();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MsSqlDriver identity', () => {
  it('answers to the mssql driver id and dialect', () => {
    expect(driver.name).toBe('mssql');
    expect(driver.dialect.name).toBe('mssql');
  });
});

describe('MsSqlDriver.query', () => {
  it('opens a transaction, runs the guards and the statement', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.tx.begun).toBe(true);
    expect(pool.tx.statements).toEqual(['SET NOCOUNT ON', 'SELECT 1', 'SET NOCOUNT OFF']);
  });

  // The core of this driver: T-SQL has no read-only transaction, so the
  // guarantee is that whatever ran is undone. Always, not only on error.
  it('always rolls back, even on success', async () => {
    await driver.query(pool, REQUEST);

    expect(pool.tx.rolledBack).toBe(true);
    expect(pool.tx.committed).toBe(false);
  });

  it('rolls back when the statement fails', async () => {
    pool.tx.failOn = 'ghost';

    await expect(
      driver.query(pool, { text: 'SELECT * FROM ghost', values: [], timeoutMs: 1000 }),
    ).rejects.toThrow(/ghost/);

    expect(pool.tx.rolledBack).toBe(true);
  });

  it('binds values as named @p parameters, never in the statement text', async () => {
    await driver.query(pool, { text: 'SELECT @p1, @p2', values: [7, 'x'], timeoutMs: 1000 });

    expect(pool.tx.inputsFor('SELECT @p1, @p2')).toEqual({ p1: 7, p2: 'x' });
    expect(pool.tx.statements).toContain('SELECT @p1, @p2');
  });

  // T-SQL has no session statement timeout: the client cancels the request.
  it('applies the timeout to the payload request', async () => {
    let seen: number | undefined;
    const original = pool.tx.request.bind(pool.tx);
    pool.tx.request = () => {
      const r = original();
      const query = r.query.bind(r);
      r.query = async (text: string) => {
        if (text === 'SELECT 1') seen = r.timeout;
        return query(text);
      };
      return r;
    };

    await driver.query(pool, REQUEST);

    expect(seen).toBe(5000);
  });

  it('returns rows and column names', async () => {
    const result = await driver.query(pool, REQUEST);

    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.fields).toEqual(['n']);
  });

  it('rejects a resource that is not a connected mssql pool', async () => {
    await expect(driver.query({ nope: true }, REQUEST)).rejects.toThrow(ConnectionError);
  });
});

describe('MsSqlDriver lifecycle', () => {
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

  it('reports a missing mssql install with an actionable message', async () => {
    // `mssql` is an optional dependency and may be installed: simulate its absence.
    vi.doMock('mssql', () => {
      throw new Error("Cannot find module 'mssql'");
    });
    onTestFinished(() => {
      vi.doUnmock('mssql');
    });
    await expect(
      driver.open({ type: 'sql', driver: 'mssql', host: 'h', database: 'erp' }, { kind: 'none' }),
    ).rejects.toThrow(/mssql/);
  });
});
