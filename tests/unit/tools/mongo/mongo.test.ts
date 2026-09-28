import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMongoQueryTool } from '../../../../src/tools/builtin/mongo/MongoQueryTool.js';
import { createMongoSchemaTool } from '../../../../src/tools/builtin/mongo/MongoSchemaTool.js';
import { MongoQueryDriver } from '../../../../src/tools/builtin/mongo/MongoDriver.js';
import type {
  MongoQueryRequest,
  MongoQueryResult,
} from '../../../../src/tools/builtin/mongo/MongoDriver.js';
import {
  fillMongoTemplate,
  guardCollection,
  guardFilter,
  guardPipeline,
} from '../../../../src/tools/builtin/mongo/guards.js';
import { ConnectionManager } from '../../../../src/connections/ConnectionManager.js';
import type { ConnectionsConfig } from '../../../../src/connections/types.js';
import { ConfigCredentialProvider } from '../../../../src/credentials/ConfigCredentialProvider.js';
import { QueryRejectedError, ValidationError } from '../../../../src/errors/index.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { CollectionResult, ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
  metadata: { organisation: 'org-7' },
};

class RecordingDriver extends MongoQueryDriver {
  override readonly name = 'mongo';
  readonly calls: MongoQueryRequest[] = [];
  rows: Record<string, unknown>[] = [];

  override async open(): Promise<unknown> {
    return { client: true };
  }

  override async close(): Promise<void> {}

  override async query(_resource: unknown, request: MongoQueryRequest): Promise<MongoQueryResult> {
    this.calls.push(request);
    return { rows: this.rows };
  }

  get lastCall(): MongoQueryRequest {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error('the driver was never called');
    return call;
  }
}

const CONNECTIONS: ConnectionsConfig = {
  ops: {
    type: 'mongo',
    url: 'mongodb://localhost:27017',
    database: 'ops',
    readOnlyUser: true,
    limits: { maxRows: 3 },
    relations: [
      {
        name: 'tickets',
        description: 'One document per support ticket.',
        columns: [{ name: 'status', type: 'string', description: 'open | closed' }],
      },
      { name: 'areas' },
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
    drivers: { mongo: driver },
  });
  ctx = {
    getConnection: (name: string) => manager.get(name),
    emit,
  } as unknown as InternalToolContext;
});

function rowsOf(data: unknown): CollectionResult<Record<string, unknown>> {
  return data as CollectionResult<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

describe('mongo guards', () => {
  // These operators take a function body: remote code execution wearing a
  // filter's clothes.
  it.each([['$where'], ['$function'], ['$accumulator']])('refuses %s in a filter', (operator) => {
    expect(() => guardFilter({ [operator]: 'return true' })).toThrow(QueryRejectedError);
  });

  it('finds a code operator nested deep in a filter', () => {
    expect(() => guardFilter({ a: { b: [{ $where: 'x' }] } })).toThrow(/code-operator|\$where/);
  });

  it('allows an ordinary filter', () => {
    expect(() => guardFilter({ status: 'open', age: { $gt: 3 } })).not.toThrow();
  });

  // The reason "an aggregation is read-only" is false.
  it.each([['$out'], ['$merge']])('refuses the write stage %s', (stage) => {
    expect(() => guardPipeline([{ [stage]: 'other' }])).toThrow(/writes to the database/);
  });

  it('allows a read pipeline', () => {
    expect(() =>
      guardPipeline([{ $match: { status: 'open' } }, { $group: { _id: '$area' } }]),
    ).not.toThrow();
  });

  // Without this, a lookup reads a collection the query was never allowed to
  // name.
  it('refuses a $lookup reaching outside the allowlist', () => {
    expect(() =>
      guardPipeline([{ $lookup: { from: 'salaries' } }], { allowedCollections: ['tickets'] }),
    ).toThrow(/salaries/);
  });

  it('allows a $lookup into an allowed collection', () => {
    expect(() =>
      guardPipeline([{ $lookup: { from: 'areas' } }], {
        allowedCollections: ['tickets', 'areas'],
      }),
    ).not.toThrow();
  });

  it('refuses a pipeline that is not an array', () => {
    expect(() => guardPipeline({ $match: {} })).toThrow(/array of stages/);
  });

  it('refuses a collection outside the allowlist', () => {
    expect(() => guardCollection('salaries', { allowedCollections: ['tickets'] })).toThrow(
      /not available/,
    );
  });

  it('enforces nothing when no allowlist is configured', () => {
    expect(() => guardCollection('anything')).not.toThrow();
  });
});

describe('fillMongoTemplate', () => {
  it('substitutes markers by value, not by splicing text', () => {
    expect(fillMongoTemplate({ area: ':a', n: ':n' }, { a: 'SUPPORT', n: 3 })).toEqual({
      area: 'SUPPORT',
      n: 3,
    });
  });

  it('leaves ordinary strings alone', () => {
    expect(fillMongoTemplate({ status: 'open' }, {})).toEqual({ status: 'open' });
  });

  it('walks nested structures', () => {
    expect(fillMongoTemplate([{ $match: { a: ':x' } }], { x: 1 })).toEqual([{ $match: { a: 1 } }]);
  });

  it('yields null for a marker with no value', () => {
    expect(fillMongoTemplate({ a: ':missing' }, {})).toEqual({ a: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Declared mode
// ─────────────────────────────────────────────────────────────────────────────

describe('mongo.query declared mode', () => {
  const declared = {
    name: 'tickets.openByArea',
    connection: 'ops',
    collection: 'tickets',
    filter: { status: 'open', area: ':area', org: ':org' },
    sort: { created: -1 },
    params: {
      area: { from: 'model' as const, schema: { type: 'string' }, required: true },
      org: { from: 'context' as const, path: 'metadata.organisation' as const, required: true },
    },
  };

  it('publishes only the model parameters', () => {
    const properties = createMongoQueryTool(declared, ctx).inputSchema['properties'] as Record<
      string,
      unknown
    >;
    expect(Object.keys(properties)).toEqual(['area']);
  });

  it('binds the context value over anything the model sends', async () => {
    await createMongoQueryTool(declared, ctx).execute({ area: 'SUPPORT', org: 'org-999' }, CTX);

    expect(driver.lastCall.filter).toEqual({
      status: 'open',
      area: 'SUPPORT',
      org: 'org-7',
    });
  });

  it('asks for one document beyond the cap so truncation is detectable', async () => {
    await createMongoQueryTool(declared, ctx).execute({ area: 'SUPPORT' }, CTX);
    expect(driver.lastCall.limit).toBe(4);
  });

  it('returns documents in the shared envelope', async () => {
    driver.rows = [{ id: 1 }, { id: 2 }];
    const result = await createMongoQueryTool(declared, ctx).execute({ area: 'SUPPORT' }, CTX);

    expect(rowsOf(result.data).rowCount).toBe(2);
    expect(rowsOf(result.data).truncated).toBe(false);
  });

  it('flags truncation and calls the records documents', async () => {
    driver.rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
    const result = await createMongoQueryTool(declared, ctx).execute({ area: 'SUPPORT' }, CTX);

    expect(rowsOf(result.data).truncated).toBe(true);
    expect(rowsOf(result.data).notice).toContain('documents');
  });

  it('refuses a declared collection outside the allowlist', () => {
    expect(() => createMongoQueryTool({ ...declared, collection: 'salaries' }, ctx)).toThrow(
      /not available/,
    );
  });

  it('refuses a declared template using a code operator', () => {
    expect(() => createMongoQueryTool({ ...declared, filter: { $where: 'true' } }, ctx)).toThrow(
      QueryRejectedError,
    );
  });

  it('requires a collection', () => {
    expect(() => createMongoQueryTool({ name: 't', connection: 'ops' }, ctx)).toThrow(
      ValidationError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Free-form mode
// ─────────────────────────────────────────────────────────────────────────────

describe('mongo.query freeform mode', () => {
  const freeform = { name: 'ops.query', connection: 'ops', mode: 'freeform' as const };

  it('runs a model-supplied filter', async () => {
    driver.rows = [{ id: 1 }];
    const result = await createMongoQueryTool(freeform, ctx).execute(
      { collection: 'tickets', filter: { status: 'open' } },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(driver.lastCall.filter).toEqual({ status: 'open' });
  });

  it('runs a model-supplied pipeline', async () => {
    await createMongoQueryTool(freeform, ctx).execute(
      { collection: 'tickets', pipeline: [{ $match: { status: 'open' } }] },
      CTX,
    );

    expect(driver.lastCall.pipeline).toEqual([{ $match: { status: 'open' } }]);
  });

  it('returns a rejection the model can act on, without querying', async () => {
    const result = await createMongoQueryTool(freeform, ctx).execute(
      { collection: 'tickets', filter: { $where: 'true' } },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(driver.calls).toHaveLength(0);
  });

  it('emits tool.query.rejected naming the control', async () => {
    await createMongoQueryTool(freeform, ctx).execute({ collection: 'salaries' }, CTX);

    expect(emit).toHaveBeenCalledWith(
      'tool.query.rejected',
      expect.objectContaining({ control: 'allowed-collections' }),
    );
  });

  it('lists the readable collections in its description', () => {
    expect(createMongoQueryTool(freeform, ctx).description).toContain('tickets');
  });

  it('warns when the connection asserts no read-only user', () => {
    const manager = new ConnectionManager({
      connections: { db: { type: 'mongo', url: 'mongodb://x', database: 'd' } },
      credentials: new ConfigCredentialProvider(),
      drivers: { mongo: driver },
    });
    const local = { ...ctx, getConnection: (name: string) => manager.get(name) };

    createMongoQueryTool({ name: 't', connection: 'db', mode: 'freeform' }, local);

    expect(emit).toHaveBeenCalledWith(
      'security.sql.unrestricted',
      expect.objectContaining({ engine: 'mongo' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

describe('mongo.schema', () => {
  it('serves the curated catalogue', async () => {
    const result = await createMongoSchemaTool({ connection: 'ops' }, ctx).execute({}, CTX);
    const data = result.data as { collections: { name: string }[] };

    expect(data.collections.map((entry) => entry.name)).toEqual(['tickets', 'areas']);
  });

  it('passes field descriptions through', async () => {
    const result = await createMongoSchemaTool({ connection: 'ops' }, ctx).execute({}, CTX);
    const data = result.data as { collections: { fields?: { description?: string }[] }[] };

    expect(data.collections[0]?.fields?.[0]?.description).toBe('open | closed');
  });

  it('filters to the requested collections', async () => {
    const result = await createMongoSchemaTool({ connection: 'ops' }, ctx).execute(
      { collections: ['areas'] },
      CTX,
    );
    expect((result.data as { collections: unknown[] }).collections).toHaveLength(1);
  });

  it('refuses to build on a connection with no declared collections', () => {
    const manager = new ConnectionManager({
      connections: { bare: { type: 'mongo', url: 'mongodb://x' } },
      credentials: new ConfigCredentialProvider(),
    });
    const local = { ...ctx, getConnection: (name: string) => manager.get(name) };

    expect(() => createMongoSchemaTool({ connection: 'bare' }, local)).toThrow(ValidationError);
  });
});
