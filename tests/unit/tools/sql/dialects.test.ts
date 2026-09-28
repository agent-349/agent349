import { describe, it, expect } from 'vitest';
import {
  PostgresDialect,
  MySqlDialect,
  MsSqlDialect,
  OracleDialect,
  dialectFor,
} from '../../../../src/tools/builtin/sql/dialects.js';
import { ValidationError } from '../../../../src/errors/index.js';

const dialect = new PostgresDialect();

describe('PostgresDialect.prepare', () => {
  it('rewrites :name into $1-style markers', () => {
    const prepared = dialect.prepare('SELECT * FROM t WHERE a = :a AND b = :b');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(prepared.order).toEqual(['a', 'b']);
  });

  it('reuses one marker for a placeholder used twice', () => {
    const prepared = dialect.prepare('SELECT * FROM t WHERE a >= :d AND b <= :d');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a >= $1 AND b <= $1');
    expect(prepared.order).toEqual(['d']);
  });

  // Otherwise a time literal turns into a placeholder and the query breaks in
  // a way that is very hard to read.
  it('leaves a colon inside a string literal alone', () => {
    const prepared = dialect.prepare("SELECT * FROM t WHERE at = '12:30'");

    expect(prepared.text).toBe("SELECT * FROM t WHERE at = '12:30'");
    expect(prepared.order).toEqual([]);
  });

  it('leaves a colon inside a comment alone', () => {
    const prepared = dialect.prepare('SELECT 1 FROM t -- see :ticket\n');
    expect(prepared.order).toEqual([]);
  });

  it('returns no parameters for a statement that uses none', () => {
    expect(dialect.prepare('SELECT 1').order).toEqual([]);
  });
});

describe('PostgresDialect.applyLimit', () => {
  it('wraps the statement so an existing LIMIT or ORDER BY survives', () => {
    const wrapped = dialect.applyLimit('SELECT a FROM t ORDER BY a', 10);
    expect(wrapped).toBe('SELECT * FROM (SELECT a FROM t ORDER BY a) AS agent349_q LIMIT 10');
  });

  it('drops a trailing semicolon that would break the wrapper', () => {
    expect(dialect.applyLimit('SELECT 1;', 5)).toBe(
      'SELECT * FROM (SELECT 1) AS agent349_q LIMIT 5',
    );
  });

  // The limit is interpolated, so it must never come from anywhere but a
  // validated integer.
  it.each([[0], [-1], [1.5], [Number.NaN]])('rejects a non-positive-integer limit: %s', (limit) => {
    expect(() => dialect.applyLimit('SELECT 1', limit)).toThrow(ValidationError);
  });
});

describe('PostgresDialect.sessionGuards', () => {
  // This is the guarantee the syntactic checks lean on: the engine refuses the
  // write, whatever the statement says.
  it('opens a read-only transaction', () => {
    expect(dialect.sessionGuards(5000).before[0]).toBe('BEGIN READ ONLY');
  });

  it('bounds the statement with a local timeout', () => {
    expect(dialect.sessionGuards(5000).before[1]).toBe('SET LOCAL statement_timeout = 5000');
  });

  it('closes with a commit', () => {
    expect(dialect.sessionGuards(1000).after).toBe('COMMIT');
  });

  it('coerces a fractional or zero timeout into a usable one', () => {
    expect(dialect.sessionGuards(0.4).before[1]).toBe('SET LOCAL statement_timeout = 1');
  });
});

describe('dialectFor', () => {
  it('resolves the postgres dialect', () => {
    expect(dialectFor('postgres').name).toBe('postgres');
  });

  it('lists what is available when a driver has no dialect', () => {
    // `db2` on purpose: an engine the SDK does not implement and is unlikely to
    // implement by accident, so this test keeps testing what it says it does.
    expect(() => dialectFor('db2')).toThrow(/no SQL dialect for driver 'db2'/);
    expect(() => dialectFor('db2')).toThrow(/Available: .*postgres/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MySQL / MariaDB
// ─────────────────────────────────────────────────────────────────────────────

const mysql = new MySqlDialect();
const mariadb = new MySqlDialect('mariadb');

describe('MySqlDialect.prepare', () => {
  it('rewrites :name into positional ? markers', () => {
    const prepared = mysql.prepare('SELECT * FROM t WHERE a = :a AND b = :b');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(prepared.order).toEqual(['a', 'b']);
  });

  // The one real difference from PostgreSQL: `?` is purely positional, so there
  // is no way to point two markers at one value. The name repeats, and the
  // caller sends the value twice.
  it('emits one marker per occurrence when a placeholder is used twice', () => {
    const prepared = mysql.prepare('SELECT * FROM t WHERE a >= :d AND b <= :d');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a >= ? AND b <= ?');
    expect(prepared.order).toEqual(['d', 'd']);
  });

  it('leaves a colon inside a string literal alone', () => {
    const prepared = mysql.prepare("SELECT * FROM t WHERE at = '12:30'");

    expect(prepared.text).toBe("SELECT * FROM t WHERE at = '12:30'");
    expect(prepared.order).toEqual([]);
  });

  it('leaves a colon inside a comment alone', () => {
    const prepared = mysql.prepare('SELECT 1 -- ver :nota\n');

    expect(prepared.order).toEqual([]);
  });
});

describe('MySqlDialect.applyLimit', () => {
  it('wraps the statement in an aliased derived table', () => {
    expect(mysql.applyLimit('SELECT a FROM t ORDER BY a', 50)).toBe(
      'SELECT * FROM (SELECT a FROM t ORDER BY a) AS agent349_q LIMIT 50',
    );
  });

  it('drops a trailing semicolon before wrapping', () => {
    expect(mysql.applyLimit('SELECT 1;', 10)).toBe(
      'SELECT * FROM (SELECT 1) AS agent349_q LIMIT 10',
    );
  });

  it('rejects a non-positive or fractional limit', () => {
    expect(() => mysql.applyLimit('SELECT 1', 0)).toThrow(ValidationError);
    expect(() => mysql.applyLimit('SELECT 1', 1.5)).toThrow(ValidationError);
  });
});

describe('MySqlDialect.sessionGuards', () => {
  // The guarantee that does not depend on reading the statement: MySQL refuses
  // the write itself (error 1792), whatever grants the connection holds.
  it('opens a read-only transaction and commits', () => {
    const guards = mysql.sessionGuards(15000);

    expect(guards.before).toContain('START TRANSACTION READ ONLY');
    expect(guards.after).toBe('COMMIT');
  });

  it('caps execution time in milliseconds on MySQL', () => {
    expect(mysql.sessionGuards(15000).before[0]).toBe('SET SESSION max_execution_time = 15000');
  });

  // MariaDB renamed the variable and changed its unit. Getting this wrong means
  // a 15-second budget silently becomes 15000 seconds.
  it('caps execution time in seconds on MariaDB', () => {
    expect(mariadb.sessionGuards(15000).before[0]).toBe('SET SESSION max_statement_time = 15');
  });

  it('sets the cap before opening the transaction', () => {
    const before = mysql.sessionGuards(1000).before;

    expect(before.findIndex((s) => s.includes('max_execution_time'))).toBeLessThan(
      before.indexOf('START TRANSACTION READ ONLY'),
    );
  });

  it('floors a sub-millisecond timeout to something the engine accepts', () => {
    expect(mysql.sessionGuards(0).before[0]).toBe('SET SESSION max_execution_time = 1');
  });
});

describe('dialectFor with MySQL flavours', () => {
  it('resolves mysql and mariadb to their dialects', () => {
    expect(dialectFor('mysql').name).toBe('mysql');
    expect(dialectFor('mariadb').name).toBe('mariadb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL Server
// ─────────────────────────────────────────────────────────────────────────────

const mssql = new MsSqlDialect();

describe('MsSqlDialect.prepare', () => {
  it('rewrites :name into @p1-style named markers', () => {
    const prepared = mssql.prepare('SELECT * FROM t WHERE a = :a AND b = :b');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a = @p1 AND b = @p2');
    expect(prepared.order).toEqual(['a', 'b']);
  });

  // Named parameters, so a repeated placeholder costs one value, not two.
  it('reuses one marker for a placeholder used twice', () => {
    const prepared = mssql.prepare('SELECT * FROM t WHERE a >= :d AND b <= :d');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a >= @p1 AND b <= @p1');
    expect(prepared.order).toEqual(['d']);
  });

  it('leaves a colon inside a string literal alone', () => {
    expect(mssql.prepare("SELECT * FROM t WHERE at = '12:30'").order).toEqual([]);
  });
});

describe('MsSqlDialect.applyLimit', () => {
  // The rule that breaks the obvious approach: T-SQL rejects ORDER BY inside a
  // derived table. Wrapping an ordinary analytical query would fail with
  // Msg 1033, so a top-level ORDER BY gets paging appended instead.
  it('appends OFFSET/FETCH when the statement ends in ORDER BY', () => {
    expect(mssql.applyLimit('SELECT a, SUM(b) t FROM v GROUP BY a ORDER BY t DESC', 100)).toBe(
      'SELECT a, SUM(b) t FROM v GROUP BY a ORDER BY t DESC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY',
    );
  });

  it('wraps with TOP when there is no ORDER BY', () => {
    expect(mssql.applyLimit('SELECT a FROM t', 50)).toBe(
      'SELECT TOP (50) * FROM (SELECT a FROM t) AS agent349_q',
    );
  });

  // An ORDER BY inside a subquery is not the statement's own: wrapping is legal.
  it('wraps when the only ORDER BY is inside parentheses', () => {
    const sql = 'SELECT a FROM t WHERE b IN (SELECT TOP (1) c FROM u ORDER BY c)';
    expect(mssql.applyLimit(sql, 10)).toBe(`SELECT TOP (10) * FROM (${sql}) AS agent349_q`);
  });

  it('is not fooled by ORDER BY inside a string literal', () => {
    const sql = "SELECT a FROM t WHERE nota = 'order by trampa'";
    expect(mssql.applyLimit(sql, 10)).toBe(`SELECT TOP (10) * FROM (${sql}) AS agent349_q`);
  });

  // Already paged: the derived table is legal because it carries FETCH.
  it('wraps a statement that already has OFFSET/FETCH', () => {
    const sql = 'SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY';
    expect(mssql.applyLimit(sql, 100)).toBe(`SELECT TOP (100) * FROM (${sql}) AS agent349_q`);
  });

  it('rejects a non-positive limit', () => {
    expect(() => mssql.applyLimit('SELECT 1', 0)).toThrow(ValidationError);
  });
});

describe('MsSqlDialect.sessionGuards', () => {
  // The transaction is the driver's job here: a raw BEGIN on a pool would leave
  // it on one connection while the statement ran on another.
  it('carries only session settings, not the transaction', () => {
    const guards = mssql.sessionGuards(15000);

    expect(guards.before).toEqual(['SET NOCOUNT ON']);
    expect(guards.before.join(' ')).not.toContain('BEGIN');
    expect(guards.after).not.toContain('ROLLBACK');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Oracle
// ─────────────────────────────────────────────────────────────────────────────

const oracle = new OracleDialect();

describe('OracleDialect.prepare', () => {
  it('rewrites :name into positional :1-style binds', () => {
    const prepared = oracle.prepare('SELECT * FROM t WHERE a = :a AND b = :b');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a = :1 AND b = :2');
    expect(prepared.order).toEqual(['a', 'b']);
  });

  it('reuses one bind for a placeholder used twice', () => {
    const prepared = oracle.prepare('SELECT * FROM t WHERE a >= :d AND b <= :d');

    expect(prepared.text).toBe('SELECT * FROM t WHERE a >= :1 AND b <= :1');
    expect(prepared.order).toEqual(['d']);
  });
});

describe('OracleDialect.applyLimit', () => {
  // Oracle rejects `AS` before a table alias — the one spelling trap here.
  it('wraps with FETCH FIRST and no AS before the alias', () => {
    expect(oracle.applyLimit('SELECT a FROM t ORDER BY a', 25)).toBe(
      'SELECT * FROM (SELECT a FROM t ORDER BY a) agent349_q FETCH FIRST 25 ROWS ONLY',
    );
  });

  it('does not emit an AS keyword', () => {
    expect(oracle.applyLimit('SELECT 1 FROM dual', 5)).not.toContain(') AS ');
  });

  it('rejects a fractional limit', () => {
    expect(() => oracle.applyLimit('SELECT 1 FROM dual', 2.5)).toThrow(ValidationError);
  });
});

describe('OracleDialect.sessionGuards', () => {
  // Engine-enforced, like PostgreSQL: a write inside fails with ORA-01456.
  it('opens a read-only transaction and commits', () => {
    const guards = oracle.sessionGuards(15000);

    expect(guards.before).toEqual(['SET TRANSACTION READ ONLY']);
    expect(guards.after).toBe('COMMIT');
  });
});

describe('dialectFor with the new engines', () => {
  it('resolves mssql and oracle', () => {
    expect(dialectFor('mssql').name).toBe('mssql');
    expect(dialectFor('oracle').name).toBe('oracle');
  });
});
