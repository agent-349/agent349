import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../../src/config/ConfigLoader.js';
import { createSqlQueryTool } from '../../../../src/tools/builtin/sql/SqlQueryTool.js';
import { SqlDriver } from '../../../../src/tools/builtin/sql/SqlDriver.js';
import type {
  SqlQueryRequest,
  SqlQueryResult,
} from '../../../../src/tools/builtin/sql/SqlDriver.js';
import { PostgresDialect } from '../../../../src/tools/builtin/sql/dialects.js';
import { INTERNAL_TOOL_IDS } from '../../../../src/tools/internalTools.js';
import type { ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
  metadata: { customerId: 7 },
};

class StubDriver extends SqlDriver {
  override readonly name = 'postgres';
  override readonly dialect = new PostgresDialect();
  readonly calls: SqlQueryRequest[] = [];

  override async open(): Promise<unknown> {
    return { pool: true };
  }

  override async close(): Promise<void> {}

  override async query(_resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    this.calls.push(request);
    return { rows: [{ amount: 42 }], fields: ['amount'] };
  }
}

const CONFIG = {
  connections: {
    erp: {
      type: 'sql',
      driver: 'postgres',
      database: 'erp',
      readOnlyUser: true,
      relations: [{ name: 'v_sales', columns: [{ name: 'amount' }] }],
    },
  },
  tools: {
    definitions: [
      {
        name: 'sales.byCustomer',
        kind: 'internal',
        ref: 'sql.query',
        config: {
          connection: 'erp',
          statement: 'SELECT amount FROM v_sales WHERE customer_id = :customerId',
          params: {
            customerId: { from: 'context', path: 'metadata.customerId', required: true },
          },
        },
      },
      {
        name: 'erp.schema',
        kind: 'internal',
        ref: 'sql.schema',
        config: { connection: 'erp' },
      },
    ],
  },
};

describe('SQL tools registered declaratively', () => {
  it('exposes sql.query and sql.schema as internal refs', () => {
    expect(INTERNAL_TOOL_IDS).toContain('sql.query');
    expect(INTERNAL_TOOL_IDS).toContain('sql.schema');
  });

  it('builds both tools from the config file', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from(CONFIG as never).get());

    expect(orch.toolRegistry.get('sales.byCustomer')).toBeDefined();
    expect(orch.toolRegistry.get('erp.schema')).toBeDefined();

    await orch.shutdown();
  });

  it('keeps the declared tool name rather than the ref', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from(CONFIG as never).get());
    expect(orch.toolRegistry.get('sql.query')).toBeUndefined();
    await orch.shutdown();
  });

  it('runs end to end through the declared tool', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from(CONFIG as never).get());
    const driver = new StubDriver();
    orch.connections.registerDriver(driver);

    const tool = orch.toolRegistry.get('sales.byCustomer');
    const result = await tool?.execute({}, CTX);

    expect(result?.success).toBe(true);
    expect(driver.calls[0]?.values).toEqual([7]);

    await orch.shutdown();
  });

  // The programmatic and declarative paths must build the same thing: one
  // implementation, two entry points.
  it('produces the same input schema as the programmatic factory', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from(CONFIG as never).get());

    const declared = orch.toolRegistry.get('sales.byCustomer');
    const programmatic = createSqlQueryTool(
      {
        name: 'sales.byCustomer',
        connection: 'erp',
        statement: 'SELECT amount FROM v_sales WHERE customer_id = :customerId',
        params: { customerId: { from: 'context', path: 'metadata.customerId', required: true } },
      },
      orch.toolServices,
    );

    expect(declared?.inputSchema).toEqual(programmatic.inputSchema);

    await orch.shutdown();
  });

  // A connection renamed in the config must fail while the tool is built, not
  // months later on the first query.
  it('fails to load when the tool points at an unknown connection', async () => {
    const broken = {
      ...CONFIG,
      tools: {
        definitions: [
          {
            name: 't',
            kind: 'internal',
            ref: 'sql.query',
            config: { connection: 'ghost', statement: 'SELECT 1 FROM v_sales' },
          },
        ],
      },
    };

    await expect(Orchestrator.fromConfig(ConfigLoader.from(broken as never).get())).rejects.toThrow(
      /ghost/,
    );
  });
});
