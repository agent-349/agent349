import { describe, it, expect } from 'vitest';
import {
  extractCteNames,
  extractRelations,
  guardFreeformSql,
} from '../../../../src/tools/builtin/sql/guards.js';
import { scrubSql, splitSql } from '../../../../src/tools/builtin/sql/dialects.js';
import { QueryRejectedError } from '../../../../src/errors/index.js';

const RELATIONS = ['v_sales', 'v_customers'];

/** Runs the guard chain and returns the control that rejected the statement. */
function rejectionControl(sql: string, allowed = RELATIONS): string {
  try {
    guardFreeformSql(sql, { allowedRelations: allowed });
  } catch (err) {
    if (err instanceof QueryRejectedError) return err.control;
    throw err;
  }
  throw new Error(`expected a rejection for: ${sql}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lexical scanning
// ─────────────────────────────────────────────────────────────────────────────

describe('splitSql', () => {
  it('reassembles into the original text', () => {
    const sql = `SELECT 'a''b', "Col" -- note\nFROM t /* c */ WHERE x = $tag$y$tag$`;
    expect(
      splitSql(sql)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(sql);
  });

  it('classifies string literals and comments as inert', () => {
    const kinds = splitSql(`SELECT 'x' -- c\nFROM t`).map((segment) => segment.kind);
    expect(kinds).toContain('inert');
  });

  it('classifies a double-quoted identifier as a name, not as inert', () => {
    const identifier = splitSql('SELECT * FROM "v_sales"').find(
      (segment) => segment.kind === 'identifier',
    );
    expect(identifier?.value).toBe('v_sales');
  });

  it('handles doubled quotes inside a literal', () => {
    const segments = splitSql("SELECT 'it''s fine' FROM t");
    expect(segments.filter((segment) => segment.kind === 'inert')).toHaveLength(1);
  });

  it('handles nested block comments', () => {
    const scrubbed = scrubSql('SELECT /* a /* b */ c */ 1 FROM t');
    expect(scrubbed).not.toContain('a');
    expect(scrubbed).toContain('FROM');
  });

  it('treats a dollar-quoted body as inert', () => {
    expect(scrubSql('SELECT $tag$ DELETE FROM x $tag$ FROM t')).not.toMatch(/DELETE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Statement shape
// ─────────────────────────────────────────────────────────────────────────────

describe('guardFreeformSql statement shape', () => {
  it('accepts a plain SELECT', () => {
    const result = guardFreeformSql('SELECT date, amount FROM v_sales', {
      allowedRelations: RELATIONS,
    });
    expect(result.relations).toEqual(['v_sales']);
  });

  it('accepts a WITH query', () => {
    expect(() =>
      guardFreeformSql('WITH r AS (SELECT * FROM v_sales) SELECT * FROM r', {
        allowedRelations: RELATIONS,
      }),
    ).not.toThrow();
  });

  it('rejects an empty statement', () => {
    expect(rejectionControl('   ')).toBe('empty');
  });

  // Stacked statements are how a second, unchecked query rides in behind the
  // first.
  it('rejects stacked statements', () => {
    expect(rejectionControl('SELECT 1 FROM v_sales; DROP TABLE users')).toBe('single-statement');
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() =>
      guardFreeformSql('SELECT 1 FROM v_sales;', { allowedRelations: RELATIONS }),
    ).not.toThrow();
  });

  it('strips the trailing semicolon so the statement can be wrapped', () => {
    const result = guardFreeformSql('SELECT 1 FROM v_sales;  ', { allowedRelations: RELATIONS });
    expect(result.sql.endsWith(';')).toBe(false);
  });

  it('rejects a statement that does not start with a read keyword', () => {
    expect(rejectionControl('DELETE FROM v_sales')).toBe('read-only');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write detection
// ─────────────────────────────────────────────────────────────────────────────

describe('guardFreeformSql write detection', () => {
  it.each([
    ['INSERT INTO v_sales VALUES (1)'],
    ['UPDATE v_sales SET amount = 0'],
    ['DROP TABLE v_sales'],
    ['ALTER TABLE v_sales ADD COLUMN x int'],
    ['TRUNCATE v_sales'],
    ['GRANT SELECT ON v_sales TO bob'],
    ['CREATE TABLE t AS SELECT 1'],
  ])('rejects %s', (sql) => {
    expect(rejectionControl(sql)).toBe('read-only');
  });

  // A write wearing a SELECT prefix, which the read-only prefix check alone
  // would wave through.
  it('rejects SELECT … INTO, which writes despite starting with SELECT', () => {
    expect(rejectionControl('SELECT * INTO new_table FROM v_sales')).toBe('read-only');
  });

  it('rejects a write hidden after a UNION', () => {
    expect(
      rejectionControl('SELECT 1 FROM v_sales UNION SELECT 1 FROM v_sales; DELETE FROM x'),
    ).toBe('single-statement');
  });

  // Noise the guard must not produce: a keyword inside a string is data.
  it('does not trip on a forbidden keyword inside a string literal', () => {
    expect(() =>
      guardFreeformSql("SELECT * FROM v_sales WHERE note = 'please delete me'", {
        allowedRelations: RELATIONS,
      }),
    ).not.toThrow();
  });

  it('does not trip on a keyword inside a comment', () => {
    expect(() =>
      guardFreeformSql('SELECT * FROM v_sales -- do not DROP anything\n', {
        allowedRelations: RELATIONS,
      }),
    ).not.toThrow();
  });

  it('does not trip on a column whose name contains a keyword', () => {
    expect(() =>
      guardFreeformSql('SELECT deleted_at, created_at FROM v_sales', {
        allowedRelations: RELATIONS,
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Relation allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe('guardFreeformSql relation allowlist', () => {
  it('rejects a relation outside the allowlist', () => {
    expect(rejectionControl('SELECT * FROM users')).toBe('allowed-relations');
  });

  it('names the relations the model may use in the rejection', () => {
    try {
      guardFreeformSql('SELECT * FROM users', { allowedRelations: RELATIONS });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('v_sales');
    }
  });

  it('accepts every relation in a join when all are allowed', () => {
    const result = guardFreeformSql(
      'SELECT * FROM v_sales JOIN v_customers ON v_sales.customer_id = v_customers.id',
      { allowedRelations: RELATIONS },
    );
    expect(result.relations.sort()).toEqual(['v_customers', 'v_sales']);
  });

  it('rejects a join that reaches one disallowed relation', () => {
    expect(rejectionControl('SELECT * FROM v_sales JOIN salaries ON true')).toBe(
      'allowed-relations',
    );
  });

  // The hole this closes: blanking a quoted identifier would hide the name and
  // let the query through unchecked.
  it('checks a relation written as a quoted identifier', () => {
    expect(rejectionControl('SELECT * FROM "salaries"')).toBe('allowed-relations');
  });

  it('accepts an allowed relation written as a quoted identifier', () => {
    expect(() =>
      guardFreeformSql('SELECT * FROM "v_sales"', { allowedRelations: RELATIONS }),
    ).not.toThrow();
  });

  it('accepts a schema-qualified spelling of an allowed relation', () => {
    expect(() =>
      guardFreeformSql('SELECT * FROM public.v_sales', { allowedRelations: RELATIONS }),
    ).not.toThrow();
  });

  it('matches relation names case-insensitively', () => {
    expect(() =>
      guardFreeformSql('SELECT * FROM V_Sales', { allowedRelations: RELATIONS }),
    ).not.toThrow();
  });

  it('enforces nothing when no allowlist is configured', () => {
    expect(() => guardFreeformSql('SELECT * FROM anything', {})).not.toThrow();
  });

  it('checks relations inside a subquery', () => {
    expect(rejectionControl('SELECT * FROM (SELECT * FROM salaries) AS s')).toBe(
      'allowed-relations',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTEs
// ─────────────────────────────────────────────────────────────────────────────

describe('CTE handling', () => {
  // Without exempting them, a query that names its own CTE would be rejected
  // for reading a relation no allowlist could ever contain.
  it('does not treat a CTE name as a relation', () => {
    expect(() =>
      guardFreeformSql('WITH recent AS (SELECT * FROM v_sales) SELECT * FROM recent', {
        allowedRelations: RELATIONS,
      }),
    ).not.toThrow();
  });

  it('exempts every CTE in a chain', () => {
    const sql =
      'WITH a AS (SELECT * FROM v_sales), b AS (SELECT * FROM a) SELECT * FROM b JOIN a ON true';
    expect(() => guardFreeformSql(sql, { allowedRelations: RELATIONS })).not.toThrow();
  });

  it('still checks real relations read inside a CTE body', () => {
    expect(rejectionControl('WITH x AS (SELECT * FROM salaries) SELECT * FROM x')).toBe(
      'allowed-relations',
    );
  });

  it('collects names from a RECURSIVE with-clause', () => {
    expect(extractCteNames('WITH RECURSIVE tree AS ( SELECT 1 ) SELECT * FROM tree')).toEqual(
      new Set(['tree']),
    );
  });

  it('collects a name declared with a column list', () => {
    expect(extractCteNames('WITH t (a, b) AS ( SELECT 1, 2 ) SELECT * FROM t')).toEqual(
      new Set(['t']),
    );
  });

  it('handles a CTE body containing nested parentheses', () => {
    const names = extractCteNames(
      'WITH a AS (SELECT (1 + (2 * 3)) FROM v_sales), b AS (SELECT 1) SELECT 1',
    );
    expect(names).toEqual(new Set(['a', 'b']));
  });

  it('returns nothing for a statement with no WITH clause', () => {
    expect(extractCteNames('SELECT * FROM v_sales').size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractRelations
// ─────────────────────────────────────────────────────────────────────────────

describe('extractRelations', () => {
  it('finds names after FROM and JOIN', () => {
    expect(extractRelations('SELECT * FROM a JOIN b ON true').sort()).toEqual(['a', 'b']);
  });

  it('keeps a schema qualifier', () => {
    expect(extractRelations('SELECT * FROM public.a')).toEqual(['public.a']);
  });

  it('yields no name for a subquery', () => {
    expect(extractRelations('SELECT * FROM (SELECT 1) AS t')).toEqual([]);
  });

  it('deduplicates repeated relations', () => {
    expect(extractRelations('SELECT * FROM a JOIN a ON true')).toEqual(['a']);
  });

  it('ignores LATERAL and UNNEST, which are not relations', () => {
    expect(extractRelations('SELECT * FROM LATERAL unnest(x)')).toEqual([]);
  });
});
