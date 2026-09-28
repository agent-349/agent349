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
