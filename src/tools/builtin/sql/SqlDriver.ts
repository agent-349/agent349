import { ConnectionDriver } from '../../../connections/types.js';
import type { SqlDialect } from './dialects.js';

/** One query to run against a SQL connection. */
export interface SqlQueryRequest {
  /** Statement carrying driver-native placeholder markers. */
  text: string;
  /** Values, in the order the markers expect them. */
  values: unknown[];
  /** Statement timeout in milliseconds. */
  timeoutMs: number;
}

/** What a SQL query returned. */
export interface SqlQueryResult {
  /** Rows as plain objects, keyed by column name. */
  rows: Record<string, unknown>[];
  /** Column names in selection order, for callers that need the shape. */
  fields: string[];
}

/**
 * A {@link ConnectionDriver} that can also run queries.
 *
 * Querying lives on the driver rather than in the tool for a reason that only
 * shows up with injected connections: when the host hands the SDK an already-open
 * pool, the resource is opaque, and the driver is the only thing that knows how
 * to talk to it.
 *
 * Implementations must run every statement inside the read-only, time-bounded
 * transaction their dialect describes. That transaction — not the syntactic
 * guards — is what actually stops a write.
 */
export abstract class SqlDriver extends ConnectionDriver<unknown> {
  /** Dialect describing this engine's placeholders, row caps and guards. */
  abstract readonly dialect: SqlDialect;

  /**
   * Runs one statement.
   *
   * @param resource - Pool or client, from `open()` or injected by the host.
   * @param request  - Statement, values and timeout.
   * @returns The rows and column names.
   * @throws The driver's own error, so the caller can decide whether the model
   *         is allowed to see it.
   */
  abstract query(resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult>;
}

/** Whether `driver` can run SQL queries. */
export function isSqlDriver(driver: ConnectionDriver): driver is SqlDriver {
  return typeof (driver as SqlDriver).query === 'function';
}

// ─────────────────────────────────────────────────────────────────────────────
// Date-time columns without a time zone
// ─────────────────────────────────────────────────────────────────────────────

/** A column type that carries no time zone: a calendar date, or a date and a time of day. */
export type ZonelessKind = 'date' | 'datetime';

/**
 * How a driver turned a zoneless value into a `Date`: from the local
 * components of the Node process (`pg`, `oracledb`, `mysql2` by default), or
 * as if the value were at a fixed UTC offset (`mssql` with `useUTC`,
 * `mysql2` with `timezone: 'Z'` or `'+02:00'`).
 */
export type DriverClock = { kind: 'local' } | { kind: 'offset'; minutes: number };

/**
 * Rewrites the `Date` values of zoneless columns as the text stored in the
 * database (`2026-01-02T03:04:05`, `2026-01-02`).
 *
 * Without this a `TIMESTAMP` or `DATETIME` of 03:04 read by a Node process in
 * UTC-3 reached the model as `2026-01-02T06:04:05.000Z`: an instant that was
 * never stored, three hours off. Reading the `Date` back with the same clock
 * the driver built it with recovers the stored value exactly (to the
 * millisecond, the precision of a `Date`). Values that are not `Date`s (a host
 * pool configured with `dateStrings`, a custom type parser) are left alone.
 *
 * @param rows    - Rows as the driver returned them; changed in place.
 * @param columns - Zoneless columns by name.
 * @param clock   - How the driver built the dates.
 */
export function normalizeZonelessColumns(
  rows: Record<string, unknown>[],
  columns: Map<string, ZonelessKind>,
  clock: DriverClock,
): void {
  if (columns.size === 0) return;
  for (const row of rows) {
    for (const [name, kind] of columns) {
      const value = row[name];
      if (value instanceof Date && !Number.isNaN(value.getTime()))
        row[name] = zonelessText(value, kind, clock);
    }
  }
}

function zonelessText(value: Date, kind: ZonelessKind, clock: DriverClock): string {
  const local = clock.kind === 'local';
  const date = local ? value : new Date(value.getTime() + clock.minutes * 60_000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const year = local ? date.getFullYear() : date.getUTCFullYear();
  const day =
    `${pad(year, 4)}-${pad((local ? date.getMonth() : date.getUTCMonth()) + 1)}-` +
    pad(local ? date.getDate() : date.getUTCDate());
  if (kind === 'date') return day;
  const ms = local ? date.getMilliseconds() : date.getUTCMilliseconds();
  return (
    `${day}T${pad(local ? date.getHours() : date.getUTCHours())}:` +
    `${pad(local ? date.getMinutes() : date.getUTCMinutes())}:` +
    `${pad(local ? date.getSeconds() : date.getUTCSeconds())}` +
    (ms > 0 ? `.${pad(ms, 3)}` : '')
  );
}

/** Minutes east of UTC of a `mysql2` `timezone` option (`'local'` and anything unreadable are local). */
export function mysqlClock(timezone: unknown): DriverClock {
  if (timezone === 'Z' || timezone === 'z') return { kind: 'offset', minutes: 0 };
  const match = typeof timezone === 'string' ? /^([+-])(\d{2}):?(\d{2})$/.exec(timezone) : null;
  if (match === null) return { kind: 'local' };
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return { kind: 'offset', minutes: match[1] === '-' ? -minutes : minutes };
}
