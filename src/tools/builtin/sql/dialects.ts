import { ValidationError } from '../../../errors/index.js';

/** A statement with its placeholders rewritten for a specific driver. */
export interface PreparedStatement {
  /** SQL carrying the driver's own placeholder markers. */
  text: string;
  /** Parameter names, in the order the driver expects the values. */
  order: string[];
}

/**
 * Per-engine SQL differences that matter to the tools.
 *
 * Small on purpose. The dialect knows how to spell three things — placeholders,
 * row caps, session guards — and nothing about what a query means.
 */
export abstract class SqlDialect {
  /** Dialect id, surfaced to the model so it writes the right syntax. */
  abstract readonly name: string;

  /**
   * Rewrites `:name` placeholders into the driver's own markers.
   *
   * Values never enter the statement text: this returns the order in which the
   * driver expects them, and they travel separately. That is the whole defence
   * against injection, and it holds whether the statement came from a config
   * file or from the model.
   *
   * @param statement - SQL using `:name` placeholders.
   * @returns The rewritten statement and its parameter order.
   */
  abstract prepare(statement: string): PreparedStatement;

  /**
   * Wraps a `SELECT` so it returns at most `limit` rows.
   *
   * @param sql   - The statement to wrap.
   * @param limit - Maximum rows.
   */
  abstract applyLimit(sql: string, limit: number): string;

  /**
   * Statements that open a read-only, time-bounded transaction, and the one
   * that closes it.
   *
   * @param timeoutMs - Statement timeout in milliseconds.
   */
  abstract sessionGuards(timeoutMs: number): { before: string[]; after: string };
}

/** Identifier accepted as a `:name` placeholder. */
const PLACEHOLDER = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * PostgreSQL dialect: `$1`-style placeholders, `LIMIT n`, and a read-only
 * transaction with `SET LOCAL statement_timeout`.
 */
export class PostgresDialect extends SqlDialect {
  override readonly name = 'postgres';

  override prepare(statement: string): PreparedStatement {
    const order: string[] = [];
    const text = splitSql(statement)
      .map((segment) => {
        if (segment.kind !== 'code') return segment.text;
        return segment.text.replace(PLACEHOLDER, (_match, rawName: string) => {
          let index = order.indexOf(rawName);
          if (index === -1) {
            order.push(rawName);
            index = order.length - 1;
          }
          // A placeholder used twice reuses its marker instead of duplicating
          // the value, so `:from` appearing twice stays one parameter.
          return `$${index + 1}`;
        });
      })
      .join('');
    return { text, order };
  }

  override applyLimit(sql: string, limit: number): string {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('limit', `row limit must be a positive integer, got ${limit}`);
    }
    // Wrapping rather than appending: the statement may already carry its own
    // LIMIT, an ORDER BY, or be a UNION, none of which tolerate a suffix.
    return `SELECT * FROM (${stripTrailingSemicolon(sql)}) AS agent349_q LIMIT ${limit}`;
  }

  override sessionGuards(timeoutMs: number): { before: string[]; after: string } {
    const ms = Math.max(1, Math.trunc(timeoutMs));
    return {
      // READ ONLY is enforced by the engine: a write fails even when the
      // connection authenticates as a user allowed to perform it. It is the
      // one guard here that does not depend on reading the statement, and so
      // the only one an adversary cannot phrase their way around.
      before: ['BEGIN READ ONLY', `SET LOCAL statement_timeout = ${ms}`],
      after: 'COMMIT',
    };
  }
}

/**
 * MySQL dialect: `?` placeholders, `LIMIT n`, and a read-only transaction with
 * a session-scoped execution cap.
 *
 * MariaDB is the same engine family with two differences that matter here, both
 * covered by `flavor`: the timeout variable is named `max_statement_time` and
 * is expressed in **seconds**, not milliseconds.
 */
export class MySqlDialect extends SqlDialect {
  override readonly name: string;
  readonly #mariadb: boolean;

  /**
   * @param flavor - `'mysql'` (default) or `'mariadb'`.
   */
  constructor(flavor: 'mysql' | 'mariadb' = 'mysql') {
    super();
    this.name = flavor;
    this.#mariadb = flavor === 'mariadb';
  }

  override prepare(statement: string): PreparedStatement {
    const order: string[] = [];
    const text = splitSql(statement)
      .map((segment) => {
        if (segment.kind !== 'code') return segment.text;
        return segment.text.replace(PLACEHOLDER, (_match, rawName: string) => {
          // Unlike PostgreSQL's `$n`, `?` markers are purely positional: there
          // is no way to point two of them at one value, so a placeholder used
          // twice contributes its name twice and the value travels twice.
          order.push(rawName);
          return '?';
        });
      })
      .join('');
    return { text, order };
  }

  override applyLimit(sql: string, limit: number): string {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('limit', `row limit must be a positive integer, got ${limit}`);
    }
    // Same wrapping rationale as PostgreSQL. MySQL requires the derived table
    // to be aliased, which this already does.
    return `SELECT * FROM (${stripTrailingSemicolon(sql)}) AS agent349_q LIMIT ${limit}`;
  }

  override sessionGuards(timeoutMs: number): { before: string[]; after: string } {
    const ms = Math.max(1, Math.trunc(timeoutMs));
    // There is no SET LOCAL in MySQL, so the cap is session-scoped and outlives
    // the transaction on a pooled connection. Harmless in practice because it is
    // re-applied before every statement, but worth knowing when reading a
    // connection's state.
    const timeout = this.#mariadb
      ? `SET SESSION max_statement_time = ${ms / 1000}`
      : `SET SESSION max_execution_time = ${ms}`;
    return {
      // READ ONLY is enforced by the engine (error 1792), exactly like
      // PostgreSQL: a write fails regardless of the statement's wording and of
      // the grants the connection holds.
      before: [timeout, 'START TRANSACTION READ ONLY'],
      after: 'COMMIT',
    };
  }
}

/**
 * SQL Server dialect: `@p1` placeholders, a two-case row cap, and a transaction
 * that is **rolled back** rather than committed.
 *
 * ### No read-only transaction
 * T-SQL has no `BEGIN READ ONLY`, so the guarantee PostgreSQL, MySQL and Oracle
 * get from the engine is simply not available. What is available is the next
 * best thing: every statement runs inside a transaction that always ends in
 * `ROLLBACK`. A read is unaffected; a write that slipped past every other guard
 * is undone. It is weaker — a rollback cannot undo a side effect that was never
 * transactional — so on this engine the database user's grants carry more of
 * the weight than on any other, and `readOnlyUser` deserves to be verified
 * rather than assumed.
 */
export class MsSqlDialect extends SqlDialect {
  override readonly name = 'mssql';

  override prepare(statement: string): PreparedStatement {
    const order: string[] = [];
    const text = splitSql(statement)
      .map((segment) => {
        if (segment.kind !== 'code') return segment.text;
        return segment.text.replace(PLACEHOLDER, (_match, rawName: string) => {
          // Named parameters, so a placeholder used twice reuses its marker —
          // same economy as PostgreSQL, different spelling.
          let index = order.indexOf(rawName);
          if (index === -1) {
            order.push(rawName);
            index = order.length - 1;
          }
          return `@p${index + 1}`;
        });
      })
      .join('');
    return { text, order };
  }

  /**
   * Caps rows, working around the one T-SQL rule that breaks the obvious
   * approach: **`ORDER BY` is illegal inside a derived table** unless the
   * subquery also carries `TOP`, `OFFSET/FETCH` or `FOR XML`. Wrapping a
   * perfectly ordinary `SELECT … GROUP BY … ORDER BY` would fail with
   * "The ORDER BY clause is invalid in views, inline functions, derived
   * tables…", which is exactly the shape an analytical query has.
   *
   * So there are two cases:
   * - a top-level `ORDER BY` with no paging yet → append `OFFSET/FETCH`, which
   *   is legal there and needs no wrapper;
   * - anything else → wrap in `SELECT TOP (n) * FROM (…) AS q`, which is legal
   *   because the inner statement has no bare `ORDER BY`.
   */
  override applyLimit(sql: string, limit: number): string {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('limit', `row limit must be a positive integer, got ${limit}`);
    }
    const clean = stripTrailingSemicolon(sql);
    const tail = topLevelTail(clean);
    if (tail.hasOrderBy && !tail.hasPaging) {
      return `${clean} OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
    }
    return `SELECT TOP (${limit}) * FROM (${clean}) AS agent349_q`;
  }

  /**
   * Only session settings live here. Two things this dialect *cannot* express
   * as statements, and that the driver does instead:
   *
   * - **The transaction**, opened through the client's own API. A raw
   *   `BEGIN TRANSACTION` on a pool is worthless: the next statement may land
   *   on a different connection, leaving an orphaned transaction behind and a
   *   query running outside it. Only the client library can pin a connection.
   * - **The statement timeout**, which T-SQL has no session variable for. The
   *   driver sets it per request, and that does cancel server-side.
   */
  override sessionGuards(_timeoutMs: number): { before: string[]; after: string } {
    return {
      // NOCOUNT keeps "n rows affected" messages from arriving as extra result
      // sets and confusing the row mapping.
      before: ['SET NOCOUNT ON'],
      after: 'SET NOCOUNT OFF',
    };
  }
}

/**
 * Oracle dialect: native `:name` binds, `FETCH FIRST n ROWS ONLY`, and a real
 * read-only transaction.
 *
 * The closest of the four to PostgreSQL in guarantees, with two spelling traps:
 * a derived table takes **no `AS`** before its alias, and the row cap is
 * `FETCH FIRST` (12c and later).
 */
export class OracleDialect extends SqlDialect {
  override readonly name = 'oracle';

  override prepare(statement: string): PreparedStatement {
    const order: string[] = [];
    const text = splitSql(statement)
      .map((segment) => {
        if (segment.kind !== 'code') return segment.text;
        return segment.text.replace(PLACEHOLDER, (_match, rawName: string) => {
          // Rewritten to `:1`-style positional binds even though Oracle would
          // accept the names: the driver contract carries values as an array,
          // and positional binds are what an array maps onto unambiguously.
          let index = order.indexOf(rawName);
          if (index === -1) {
            order.push(rawName);
            index = order.length - 1;
          }
          return `:${index + 1}`;
        });
      })
      .join('');
    return { text, order };
  }

  override applyLimit(sql: string, limit: number): string {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('limit', `row limit must be a positive integer, got ${limit}`);
    }
    // No `AS` before the alias: Oracle rejects it for table aliases.
    return `SELECT * FROM (${stripTrailingSemicolon(sql)}) agent349_q FETCH FIRST ${limit} ROWS ONLY`;
  }

  override sessionGuards(_timeoutMs: number): { before: string[]; after: string } {
    return {
      // Engine-enforced, like PostgreSQL: a write inside fails with ORA-01456.
      // The time bound is the driver's `callTimeout`; Oracle has no session
      // statement timeout that applies to a single call.
      before: ['SET TRANSACTION READ ONLY'],
      after: 'COMMIT',
    };
  }
}

/**
 * Locates the top-level tail clauses of a statement, ignoring anything inside
 * parentheses, string literals or comments.
 *
 * Used by {@link MsSqlDialect.applyLimit}, where the difference between an
 * `ORDER BY` that belongs to the statement and one buried in a subquery decides
 * whether the statement can be wrapped at all.
 */
export function topLevelTail(sql: string): { hasOrderBy: boolean; hasPaging: boolean } {
  let depth = 0;
  let hasOrderBy = false;
  let hasPaging = false;

  for (const segment of splitSql(sql)) {
    if (segment.kind !== 'code') continue;
    // Walk the segment tracking depth so `(SELECT … ORDER BY x)` does not count.
    const text = segment.text;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0) {
        const rest = text.slice(i);
        if (/^order\s+by\b/i.test(rest)) {
          hasOrderBy = true;
          i += 5;
          continue;
        }
        if (/^(offset\b|fetch\s+(first|next)\b|top\s*\()/i.test(rest)) {
          hasPaging = true;
          i += 4;
          continue;
        }
      }
      i += 1;
    }
  }
  return { hasOrderBy, hasPaging };
}

/** Dialects the SDK ships, keyed by driver id. */
export const SQL_DIALECTS: Readonly<Record<string, () => SqlDialect>> = {
  postgres: () => new PostgresDialect(),
  mysql: () => new MySqlDialect('mysql'),
  mariadb: () => new MySqlDialect('mariadb'),
  mssql: () => new MsSqlDialect(),
  oracle: () => new OracleDialect(),
};

/**
 * Returns the dialect for a driver id.
 *
 * @param driver - Driver id from the connection config.
 * @throws {@link ValidationError} when the SDK has no dialect for it.
 */
export function dialectFor(driver: string): SqlDialect {
  const factory = SQL_DIALECTS[driver];
  if (factory === undefined) {
    throw new ValidationError(
      'connection.driver',
      `no SQL dialect for driver '${driver}'. Available: ${Object.keys(SQL_DIALECTS).join(', ')}`,
    );
  }
  return factory();
}

/** Drops a trailing `;` and surrounding whitespace so a statement can be wrapped. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Lexical scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a run of SQL text is.
 *
 * - `code` — executable SQL: keywords, operators, bare identifiers.
 * - `inert` — string literals and comments: never executable, and never a
 *   relation name.
 * - `identifier` — a double-quoted identifier: not executable, but it **is** a
 *   name, so it has to stay visible to relation extraction.
 */
export type SegmentKind = 'code' | 'inert' | 'identifier';

/** A run of SQL text with its role. */
export interface SqlSegment {
  /** The raw text, exactly as it appeared. */
  text: string;
  /** For `identifier`, the name with its quoting removed. */
  value?: string;
  kind: SegmentKind;
}

/**
 * Splits SQL into executable code, inert regions, and quoted identifiers.
 *
 * The three-way split is what makes the free-form guards trustworthy. Two
 * failure modes it exists to avoid, one noisy and one dangerous:
 * `SELECT 'delete me'` must not trip the keyword guard, and
 * `SELECT * FROM "secret"` must still be checked against the relation
 * allowlist — treating a quoted identifier as inert would hide the name and
 * wave the query through.
 *
 * @param sql - Raw SQL.
 * @returns Ordered segments whose `text` concatenates back to `sql`.
 */
export function splitSql(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer !== '') {
      segments.push({ text: buffer, kind: 'code' });
      buffer = '';
    }
  };

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment: -- to end of line.
    if (rest.startsWith('--')) {
      flush();
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      segments.push({ text: sql.slice(i, stop), kind: 'inert' });
      i = stop;
      continue;
    }

    // Block comment: /* … */, which PostgreSQL allows to nest.
    if (rest.startsWith('/*')) {
      flush();
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      segments.push({ text: sql.slice(i, j), kind: 'inert' });
      i = j;
      continue;
    }

    // Dollar-quoted string: $tag$ … $tag$.
    const dollar = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(rest);
    if (dollar !== null) {
      flush();
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      segments.push({ text: sql.slice(i, stop), kind: 'inert' });
      i = stop;
      continue;
    }

    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      flush();
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === quote) {
          // The quote character is escaped by doubling it.
          if (sql[j + 1] === quote) {
            inner += quote;
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        inner += sql[j];
        j += 1;
      }
      const text = sql.slice(i, j);
      segments.push(
        quote === '"' && closed
          ? { text, kind: 'identifier', value: inner }
          : { text, kind: 'inert' },
      );
      i = j;
      continue;
    }

    buffer += sql[i];
    i += 1;
  }

  flush();
  return segments;
}

/**
 * Returns `sql` with literals and comments blanked out and quoted identifiers
 * unquoted, ready to be scanned for keywords and relation names.
 *
 * @param sql - Raw SQL.
 */
export function scrubSql(sql: string): string {
  return splitSql(sql)
    .map((segment) => {
      switch (segment.kind) {
        case 'code':
          return segment.text;
        case 'identifier':
          // Kept as a bare name so `FROM "v_sales"` is still seen as naming
          // `v_sales`. Spaces around it preserve token boundaries.
          return ` ${segment.value ?? ''} `;
        case 'inert':
          return ' ';
      }
    })
    .join('');
}
