import { describe, it, expect } from 'vitest';
import {
  mysqlClock,
  normalizeZonelessColumns,
} from '../../../../src/tools/builtin/sql/SqlDriver.js';
import { PostgresDriver } from '../../../../src/tools/builtin/sql/PostgresDriver.js';
import { MySqlDriver } from '../../../../src/tools/builtin/sql/MySqlDriver.js';
import { MsSqlDriver } from '../../../../src/tools/builtin/sql/MsSqlDriver.js';
import { OracleDriver } from '../../../../src/tools/builtin/sql/OracleDriver.js';

// pg, mysql2 and oracledb build a zoneless value from the local clock of the
// process; mssql (useUTC) from UTC. Built the same way here, so the tests hold
// in any TZ.
const LOCAL = new Date(2026, 0, 2, 3, 4, 5);
const LOCAL_MIDNIGHT = new Date(2026, 0, 2);
const UTC = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const INSTANT = new Date('2026-01-02T03:04:05.000Z');
const REQUEST = { text: 'SELECT ...', values: [], timeoutMs: 1000 };

describe('normalizeZonelessColumns', () => {
  it('writes dates back as stored, with the clock the driver used', () => {
    const rows: Record<string, unknown>[] = [
      { ts: LOCAL, d: LOCAL_MIDNIGHT, at: INSTANT, n: 1 },
      { ts: null, d: 'kept', at: null, n: 2 },
    ];
    normalizeZonelessColumns(
      rows,
      new Map([
        ['ts', 'datetime'],
        ['d', 'date'],
      ]),
      { kind: 'local' },
    );
    expect(rows[0]).toEqual({ ts: '2026-01-02T03:04:05', d: '2026-01-02', at: INSTANT, n: 1 });
    expect(rows[1]).toEqual({ ts: null, d: 'kept', at: null, n: 2 });

    const offset = [{ ts: new Date(Date.UTC(2026, 0, 2, 1, 4, 5, 120)) }];
    normalizeZonelessColumns(offset, new Map([['ts', 'datetime']]), {
      kind: 'offset',
      minutes: 120,
    });
    expect(offset[0]?.ts).toBe('2026-01-02T03:04:05.120');
  });

  it('reads the mysql2 timezone option', () => {
    expect(mysqlClock('local')).toEqual({ kind: 'local' });
    expect(mysqlClock(undefined)).toEqual({ kind: 'local' });
    expect(mysqlClock('Z')).toEqual({ kind: 'offset', minutes: 0 });
    expect(mysqlClock('-03:00')).toEqual({ kind: 'offset', minutes: -180 });
    expect(mysqlClock('+0530')).toEqual({ kind: 'offset', minutes: 330 });
  });
});

describe('SQL drivers — zoneless date-time columns', () => {
  it('postgres: timestamp and date as stored, timestamptz untouched', async () => {
    const client = {
      query: async (text: string) =>
        text === REQUEST.text
          ? {
              rows: [{ ts: LOCAL, d: LOCAL_MIDNIGHT, tz: INSTANT }],
              fields: [
                { name: 'ts', dataTypeID: 1114 },
                { name: 'd', dataTypeID: 1082 },
                { name: 'tz', dataTypeID: 1184 },
              ],
            }
          : { rows: [] },
      release: () => undefined,
    };
    const result = await new PostgresDriver().query(
      { connect: async () => client, end: async () => undefined },
      REQUEST,
    );
    expect(result.rows[0]).toEqual({ ts: '2026-01-02T03:04:05', d: '2026-01-02', tz: INSTANT });
  });

  it('mysql: DATETIME and DATE as stored, TIMESTAMP untouched, honouring the pool timezone', async () => {
    const pool = (timezone?: string) => ({
      ...(timezone !== undefined && { pool: { config: { connectionConfig: { timezone } } } }),
      getConnection: async () => ({
        query: async () => [[], []],
        execute: async () => [
          [{ ts: timezone === 'Z' ? UTC : LOCAL, d: LOCAL_MIDNIGHT, at: INSTANT }],
          [
            { name: 'ts', columnType: 12 },
            { name: 'd', columnType: 10 },
            { name: 'at', columnType: 7 },
          ],
        ],
        release: () => undefined,
      }),
    });
    expect((await new MySqlDriver().query(pool(), REQUEST)).rows[0]).toEqual({
      ts: '2026-01-02T03:04:05',
      d: '2026-01-02',
      at: INSTANT,
    });
    expect(((await new MySqlDriver().query(pool('Z'), REQUEST)).rows[0] as { ts: string }).ts).toBe(
      '2026-01-02T03:04:05',
    );
  });

  it('mssql: datetime2 and date read as UTC wall clock, datetimeoffset untouched', async () => {
    const recordset = Object.assign([{ ts: UTC, d: new Date(Date.UTC(2026, 0, 2)), tz: INSTANT }], {
      columns: {
        ts: { type: { declaration: 'datetime2' } },
        d: { type: { declaration: 'date' } },
        tz: { type: { declaration: 'datetimeoffset' } },
      },
    });
    const request = {
      input: () => request,
      query: async (text: string) => (text === REQUEST.text ? { recordset } : {}),
    };
    const pool = {
      connect: async () => undefined,
      close: async () => undefined,
      transaction: () => ({
        begin: async () => undefined,
        rollback: async () => undefined,
        request: () => request,
      }),
    };
    expect((await new MsSqlDriver().query(pool, REQUEST)).rows[0]).toEqual({
      ts: '2026-01-02T03:04:05',
      d: '2026-01-02',
      tz: INSTANT,
    });
  });

  it('oracle: DATE keeps its time of day, TIMESTAMP as stored, TIMESTAMP WITH TIME ZONE untouched', async () => {
    const connection = {
      callTimeout: 0,
      execute: async (text: string) =>
        text === REQUEST.text
          ? {
              rows: [{ TS: LOCAL, D: LOCAL_MIDNIGHT, TZ: INSTANT }],
              metaData: [
                { name: 'TS', dbTypeName: 'TIMESTAMP' },
                { name: 'D', dbTypeName: 'DATE' },
                { name: 'TZ', dbTypeName: 'TIMESTAMP WITH TIME ZONE' },
              ],
            }
          : {},
      close: async () => undefined,
    };
    const result = await new OracleDriver().query(
      { getConnection: async () => connection, close: async () => undefined },
      REQUEST,
    );
    expect(result.rows[0]).toEqual({
      TS: '2026-01-02T03:04:05',
      D: '2026-01-02T00:00:00',
      TZ: INSTANT,
    });
  });
});
