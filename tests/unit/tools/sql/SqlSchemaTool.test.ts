import { describe, it, expect, beforeEach } from 'vitest';
import { createSqlSchemaTool } from '../../../../src/tools/builtin/sql/SqlSchemaTool.js';
import { ConnectionManager } from '../../../../src/connections/ConnectionManager.js';
import type { ConnectionsConfig } from '../../../../src/connections/types.js';
import { ConfigCredentialProvider } from '../../../../src/credentials/ConfigCredentialProvider.js';
import { ValidationError } from '../../../../src/errors/index.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

const CONNECTIONS: ConnectionsConfig = {
  erp: {
    type: 'sql',
    driver: 'postgres',
    database: 'erp',
    relations: [
      {
        name: 'v_sales',
        description: 'One row per confirmed sale. Excludes quotes and cancellations.',
        columns: [
          { name: 'date', type: 'date', description: 'Confirmation date' },
          { name: 'amount', type: 'numeric' },
        ],
      },
      { name: 'v_customers', description: 'Active customers.' },
    ],
  },
  bare: { type: 'sql', driver: 'postgres', database: 'x' },
};

let ctx: InternalToolContext;

function contextFor(connections: ConnectionsConfig): InternalToolContext {
  const manager = new ConnectionManager({
    connections,
    credentials: new ConfigCredentialProvider(),
  });
  return {
    getConnection: (name: string) => manager.get(name),
    emit: () => {},
  } as unknown as InternalToolContext;
}

beforeEach(() => {
  ctx = contextFor(CONNECTIONS);
});

describe('sql.schema', () => {
  it('serves the whole catalogue when nothing is asked for', async () => {
    const tool = createSqlSchemaTool({ name: 'erp.schema', connection: 'erp' }, ctx);
    const result = await tool.execute({}, CTX);
    const data = result.data as { relations: { name: string }[]; dialect: string };

    expect(result.success).toBe(true);
    expect(data.relations.map((relation) => relation.name)).toEqual(['v_sales', 'v_customers']);
    expect(data.dialect).toBe('postgres');
  });

  it('passes the descriptions through, since they are the grounding', async () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    const result = await tool.execute({}, CTX);
    const data = result.data as {
      relations: { description?: string; columns?: { description?: string }[] }[];
    };

    expect(data.relations[0]?.description).toMatch(/confirmed sale/);
    expect(data.relations[0]?.columns?.[0]?.description).toBe('Confirmation date');
  });

  it('filters to the requested relations', async () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    const result = await tool.execute({ relations: ['v_customers'] }, CTX);
    const data = result.data as { relations: { name: string }[] };

    expect(data.relations).toHaveLength(1);
    expect(data.relations[0]?.name).toBe('v_customers');
  });

  it('matches requested names case-insensitively', async () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    const result = await tool.execute({ relations: ['V_SALES'] }, CTX);

    expect((result.data as { relations: unknown[] }).relations).toHaveLength(1);
  });

  it('lists what exists when nothing matched', async () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    const result = await tool.execute({ relations: ['nope'] }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('v_sales');
  });

  it('names the available relations in its description', () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    expect(tool.description).toContain('v_sales');
  });

  // The catalogue doubles as the allowlist, so the model should understand it
  // as a boundary rather than a sample.
  it('tells the model the catalogue is exhaustive', async () => {
    const tool = createSqlSchemaTool({ connection: 'erp' }, ctx);
    const result = await tool.execute({}, CTX);

    expect((result.data as { notice: string }).notice).toMatch(/only relations/i);
  });

  it('refuses to build on a connection that declares no relations', () => {
    expect(() => createSqlSchemaTool({ connection: 'bare' }, ctx)).toThrow(ValidationError);
  });

  it('explains that relations are both allowlist and grounding', () => {
    expect(() => createSqlSchemaTool({ connection: 'bare' }, ctx)).toThrow(
      /allowlist and the grounding/,
    );
  });

  it('rejects a connection that is not a SQL one', () => {
    const local = contextFor({ api: { type: 'http', baseUrl: 'https://example.com' } });
    expect(() => createSqlSchemaTool({ connection: 'api' }, local)).toThrow(
      /needs a sql connection/,
    );
  });
});
