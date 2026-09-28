import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSqlQueryTool } from '../../../../src/tools/builtin/sql/SqlQueryTool.js';
import { SqlDriver } from '../../../../src/tools/builtin/sql/SqlDriver.js';
import type {
  SqlQueryRequest,
  SqlQueryResult,
} from '../../../../src/tools/builtin/sql/SqlDriver.js';
import { PostgresDialect } from '../../../../src/tools/builtin/sql/dialects.js';
import { ConnectionManager } from '../../../../src/connections/ConnectionManager.js';
import type { ConnectionsConfig } from '../../../../src/connections/types.js';
import { ConfigCredentialProvider } from '../../../../src/credentials/ConfigCredentialProvider.js';
import { ValidationError } from '../../../../src/errors/index.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { CollectionResult, ExecutionContext } from '../../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
  metadata: { customerId: 4821 },
};

/** Captures what reached the driver and replays a canned answer. */
class RecordingDriver extends SqlDriver {
  override readonly name = 'postgres';
  override readonly dialect = new PostgresDialect();
  readonly calls: SqlQueryRequest[] = [];
  rows: Record<string, unknown>[] = [];
  failWith: Error | null = null;

  override async open(): Promise<unknown> {
    return { pool: true };
  }

  override async close(): Promise<void> {}

  override async query(_resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    this.calls.push(request);
    if (this.failWith !== null) throw this.failWith;
    return { rows: this.rows, fields: Object.keys(this.rows[0] ?? {}) };
  }

  /** The one request the tool issued. */
  get lastCall(): SqlQueryRequest {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error('the driver was never called');
    return call;
  }
}

const CONNECTIONS: ConnectionsConfig = {
  erp: {
    type: 'sql',
    driver: 'postgres',
    database: 'erp',
    readOnlyUser: true,
    limits: { maxRows: 3 },
    relations: [
      {
        name: 'v_sales',
        description: 'One row per confirmed sale.',
        columns: [{ name: 'amount', type: 'numeric', description: 'Net amount' }],
      },
      { name: 'v_customers' },
    ],
  },
};

let driver: RecordingDriver;
let emit: ReturnType<typeof vi.fn>;
let ctx: InternalToolContext;

beforeEach(() => {
  driver = new RecordingDriver();
  emit = vi.fn();

  const manager = new ConnectionManager({
    connections: CONNECTIONS,
    credentials: new ConfigCredentialProvider(),
    drivers: { postgres: driver },
  });

  ctx = {
    getRAGPipeline: () => {
      throw new Error('not used');
    },
    ragRetrievalDefaults: {},
    getConnection: (name) => manager.get(name),
    getCredential: () => Promise.resolve({ kind: 'none' }),
    emit,
  } as unknown as InternalToolContext;
});

/** Narrows a successful result's payload to the collection envelope. */
function rowsOf(data: unknown): CollectionResult<Record<string, unknown>> {
  return data as CollectionResult<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared mode
// ─────────────────────────────────────────────────────────────────────────────

describe('sql.query declared mode', () => {
  const declared = {
    name: 'sales.byCustomer',
    connection: 'erp',
    statement: 'SELECT amount FROM v_sales WHERE customer_id = :customerId AND date >= :from',
    params: {
      customerId: {
        from: 'context' as const,
        path: 'metadata.customerId' as const,
        required: true,
      },
      from: { from: 'model' as const, schema: { type: 'string' }, required: true },
    },
  };

  it('publishes only the model-supplied parameters to the LLM', () => {
    const tool = createSqlQueryTool(declared, ctx);
    const properties = tool.inputSchema['properties'] as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(['from']);
    expect(JSON.stringify(tool.inputSchema)).not.toContain('customerId');
  });

  // The identity a query is scoped to must come from the context, never from
  // the model's input, however insistently it is asked.
  it('binds the context value even when the model supplies its own', async () => {
    const tool = createSqlQueryTool(declared, ctx);
    await tool.execute({ from: '2026-01-01', customerId: 9999 }, CTX);

    expect(driver.lastCall.values).toEqual([4821, '2026-01-01']);
  });

  it('never puts values into the statement text', async () => {
    const tool = createSqlQueryTool(declared, ctx);
    await tool.execute({ from: '2026-01-01' }, CTX);

    expect(driver.lastCall.text).toContain('$1');
    expect(driver.lastCall.text).not.toContain('4821');
  });

  it('asks for one row beyond the cap so truncation can be detected', async () => {
    const tool = createSqlQueryTool(declared, ctx);
    await tool.execute({ from: '2026-01-01' }, CTX);

    expect(driver.lastCall.text).toMatch(/LIMIT 4$/);
  });

  it('returns the rows in the shared collection envelope', async () => {
    driver.rows = [{ amount: 10 }, { amount: 20 }];
    const tool = createSqlQueryTool(declared, ctx);
    const result = await tool.execute({ from: '2026-01-01' }, CTX);

    expect(result.success).toBe(true);
    expect(rowsOf(result.data).rowCount).toBe(2);
    expect(rowsOf(result.data).truncated).toBe(false);
  });

  it('flags truncation when the probe row comes back', async () => {
    driver.rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
    const tool = createSqlQueryTool(declared, ctx);
    const result = await tool.execute({ from: '2026-01-01' }, CTX);

    expect(rowsOf(result.data).truncated).toBe(true);
    expect(rowsOf(result.data).rowCount).toBe(3);
  });

  it('fails the call when a required context binding is missing', async () => {
    const tool = createSqlQueryTool(declared, ctx);
    const bare: ExecutionContext = { ...CTX };
    delete bare.metadata;

    await expect(tool.execute({ from: '2026-01-01' }, bare)).rejects.toThrow(ValidationError);
  });

  // Structure the model was never shown must not leak through an error string.
  it('hides the database error by default', async () => {
    driver.failWith = new Error('column "secret_col" does not exist');
    const tool = createSqlQueryTool(declared, ctx);
    const result = await tool.execute({ from: '2026-01-01' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('secret_col');
  });

  it('rejects a statement whose placeholder has no binding', () => {
    expect(() =>
      createSqlQueryTool(
        { name: 't', connection: 'erp', statement: 'SELECT 1 FROM v_sales WHERE a = :ghost' },
        ctx,
      ),
    ).toThrow(/no binding declares/);
  });

  it('rejects a declared tool with no statement', () => {
    expect(() => createSqlQueryTool({ name: 't', connection: 'erp' }, ctx)).toThrow(
      ValidationError,
    );
  });

  it('caps rows at the connection ceiling even when the tool asks for more', async () => {
    const tool = createSqlQueryTool({ ...declared, limits: { maxRows: 500 } }, ctx);
    await tool.execute({ from: '2026-01-01' }, CTX);

    expect(driver.lastCall.text).toMatch(/LIMIT 4$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Free-form mode
// ─────────────────────────────────────────────────────────────────────────────

describe('sql.query freeform mode', () => {
  const freeform = { name: 'erp.query', connection: 'erp', mode: 'freeform' as const };

  it('accepts SQL from the model and runs it capped', async () => {
    driver.rows = [{ n: 1 }];
    const tool = createSqlQueryTool(freeform, ctx);
    const result = await tool.execute({ sql: 'SELECT count(*) AS n FROM v_sales' }, CTX);

    expect(result.success).toBe(true);
    expect(driver.lastCall.text).toMatch(/LIMIT 4$/);
  });

  // Returned, not thrown: the model gets to correct itself on the next
  // iteration instead of the loop dying.
  it('returns a rejection as a failed result the model can act on', async () => {
    const tool = createSqlQueryTool(freeform, ctx);
    const result = await tool.execute({ sql: 'DELETE FROM v_sales' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/read/i);
    expect(driver.calls).toHaveLength(0);
  });

  it('emits tool.query.rejected naming the guard that fired', async () => {
    const tool = createSqlQueryTool(freeform, ctx);
    await tool.execute({ sql: 'SELECT * FROM salaries' }, CTX);

    expect(emit).toHaveBeenCalledWith(
      'tool.query.rejected',
      expect.objectContaining({ control: 'allowed-relations' }),
    );
  });

  it('tells the model which relations it may read', () => {
    const tool = createSqlQueryTool(freeform, ctx);
    expect(tool.description).toContain('v_sales');
  });

  // Knowing the dialect changes how often the model's first attempt runs.
  it('names the dialect in the description', () => {
    expect(createSqlQueryTool(freeform, ctx).description).toContain('postgres');
  });

  it('passes model-supplied placeholder values out of band', async () => {
    const tool = createSqlQueryTool(freeform, ctx);
    await tool.execute(
      { sql: 'SELECT * FROM v_sales WHERE amount > :min', params: { min: 100 } },
      CTX,
    );

    expect(driver.lastCall.values).toEqual([100]);
    expect(driver.lastCall.text).not.toContain('100');
  });

  it('asks for the missing value when a placeholder has none', async () => {
    const tool = createSqlQueryTool(freeform, ctx);
    const result = await tool.execute({ sql: 'SELECT * FROM v_sales WHERE a = :missing' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain(':missing');
    expect(driver.calls).toHaveLength(0);
  });

  // Here the model already knows the schema, so the engine's own message
  // reveals nothing new and is exactly what lets it fix the query.
  it('returns the database error verbatim by default', async () => {
    driver.failWith = new Error('column "amonut" does not exist');
    const tool = createSqlQueryTool(freeform, ctx);
    const result = await tool.execute({ sql: 'SELECT amonut FROM v_sales' }, CTX);

    expect(result.error).toContain('amonut');
  });

  it('warns at build time when the connection does not assert a read-only user', () => {
    const manager = new ConnectionManager({
      connections: { db: { type: 'sql', driver: 'postgres', database: 'x' } },
      credentials: new ConfigCredentialProvider(),
      drivers: { postgres: driver },
    });
    const local = { ...ctx, getConnection: (name: string) => manager.get(name) };

    createSqlQueryTool({ name: 't', connection: 'db', mode: 'freeform' }, local);

    expect(emit).toHaveBeenCalledWith(
      'security.sql.unrestricted',
      expect.objectContaining({ connection: 'db' }),
    );
  });

  it('stays quiet when the connection does assert a read-only user', () => {
    createSqlQueryTool(freeform, ctx);
    expect(emit).not.toHaveBeenCalledWith('security.sql.unrestricted', expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('sql.query wiring', () => {
  it('rejects a connection that is not a SQL one', () => {
    const manager = new ConnectionManager({
      connections: { api: { type: 'http', baseUrl: 'https://example.com' } },
      credentials: new ConfigCredentialProvider(),
    });
    const local = { ...ctx, getConnection: (name: string) => manager.get(name) };

    expect(() => createSqlQueryTool({ name: 't', connection: 'api' }, local)).toThrow(
      /needs a sql connection/,
    );
  });

  it('runs the statement inside the read-only transaction the dialect defines', () => {
    // The tool delegates the transaction to the driver; this asserts the
    // contract the driver is handed, since the guarantee lives there.
    expect(driver.dialect.sessionGuards(1000).before).toContain('BEGIN READ ONLY');
  });
});
