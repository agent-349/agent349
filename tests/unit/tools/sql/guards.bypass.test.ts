/**
 * Regressions for the relation allowlist of guardFreeformSql.
 *
 * The previous scanner was one regular expression (`FROM|JOIN <name>`), so it
 * only saw the first item of a FROM list and knew nothing of backticks,
 * brackets, `TABLE x`, or the lexical rules under which one engine reads as a
 * string what another reads as code. Each case below read a relation outside
 * the allowlist and passed.
 */
import { describe, it, expect } from 'vitest';
import { guardFreeformSql } from '../../../../src/tools/builtin/sql/guards.js';
import { QueryRejectedError } from '../../../../src/errors/index.js';

const ALLOWED = { allowedRelations: ['products'] };

function controlOf(sql: string, options = ALLOWED): string | undefined {
  try {
    guardFreeformSql(sql, options);
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(QueryRejectedError);
    return (err as QueryRejectedError).control;
  }
}

describe('guardFreeformSql — allowlist bypasses are rejected', () => {
  const bypasses: Array<[string, string]> = [
    ['second item of a comma join', 'SELECT * FROM products, salaries'],
    ['third item of a comma join', 'SELECT * FROM products p, products q, salaries s'],
    [
      'comma after a JOIN … ON',
      'SELECT * FROM products p JOIN products q ON p.id = q.id, salaries',
    ],
    ['MySQL backtick identifier', 'SELECT * FROM `salaries`'],
    ['qualified backtick identifier', 'SELECT * FROM `hr`.`salaries`'],
    ['SQL Server bracket identifier', 'SELECT * FROM [dbo].[salaries]'],
    ['TABLE statement', 'TABLE salaries'],
    ['TABLE after UNION', 'SELECT * FROM products UNION TABLE salaries'],
    ['MySQL STRAIGHT_JOIN', 'SELECT * FROM products STRAIGHT_JOIN salaries'],
    [
      'SQL Server CROSS APPLY subquery',
      'SELECT * FROM products p CROSS APPLY (SELECT * FROM salaries) s',
    ],
    ['derived table followed by a comma item', 'SELECT * FROM (SELECT 1 AS x) t, salaries'],
    ['LATERAL prefix', 'SELECT * FROM products p, LATERAL salaries s'],
    [
      "MySQL backslash escape (\\') hiding the rest in a 'string'",
      "SELECT 'x\\'' AS a, s.* FROM products p JOIN salaries s ON 1 = 1 -- '",
    ],
    [
      "PostgreSQL E'…' string hiding the rest",
      "SELECT E'\\'' AS a, $$'$$ AS b, s.* FROM products p JOIN salaries s ON true --'",
    ],
    ['MySQL "--x" is not a comment', 'SELECT 1 --1 FROM salaries'],
    ['MySQL ends a block comment at the first */', 'SELECT * FROM products /* /* */ , salaries */'],
    [
      'SQL Server temporal FOR … AS OF before a comma item',
      "SELECT * FROM products FOR SYSTEM_TIME AS OF '2020-01-01', salaries",
    ],
    [
      'a CTE name declared inside a subquery does not cover the outer relation',
      'SELECT * FROM (WITH salaries AS (SELECT 1 AS x) SELECT * FROM salaries) t, salaries',
    ],
    ['digit-leading MySQL identifier', 'SELECT * FROM 2fa_codes'],
    ['SQL Server global temporary table', 'SELECT * FROM ##snapshot'],
  ];

  for (const [label, sql] of bypasses) {
    it(label, () => {
      expect(controlOf(sql)).toBe('allowed-relations');
    });
  }

  it('reports every relation of a comma join (SmartSQL relies on it)', () => {
    expect(guardFreeformSql('SELECT * FROM products, salaries s').relations).toEqual([
      'products',
      'salaries',
    ]);
    expect(guardFreeformSql('SELECT * FROM `hr`.`salaries`').relations).toEqual(['hr.salaries']);
  });
});

describe('guardFreeformSql — what cannot be checked is rejected', () => {
  it('MySQL executable comments', () => {
    expect(controlOf('SELECT * FROM products /*!50000 , salaries */')).toBe('unsupported-syntax');
  });

  it("Oracle q'…' quoting", () => {
    expect(controlOf("SELECT q'[it's]' FROM products")).toBe('unsupported-syntax');
  });

  it('a placeholder, a literal or an ODBC escape in a table position', () => {
    expect(controlOf('SELECT * FROM :table')).toBe('unparseable');
    expect(controlOf("SELECT * FROM products, 'salaries'")).toBe('unparseable');
    expect(controlOf('SELECT * FROM {oj products LEFT OUTER JOIN salaries ON 1 = 1}')).toBe(
      'unparseable',
    );
  });

  it('unbalanced parentheses and literals unterminated under every engine', () => {
    expect(controlOf('SELECT * FROM (SELECT * FROM products')).toBe('unparseable');
    expect(controlOf("SELECT 'open FROM products")).toBe('unparseable');
  });

  it('a statement hidden after a backslash-escaped quote is still a second statement', () => {
    expect(controlOf("SELECT 'a\\'; DELETE FROM products; -- '")).toBe('single-statement');
  });
});

describe('guardFreeformSql — legitimate queries still pass', () => {
  const legitimate: string[] = [
    'SELECT EXTRACT(YEAR FROM created_at) AS y FROM products',
    'SELECT SUBSTRING(name FROM 1 FOR 3) FROM products',
    "SELECT TRIM(BOTH ' ' FROM name) FROM products",
    'SELECT * FROM products WHERE price IS DISTINCT FROM list_price',
    'SELECT * FROM products WHERE price IS NOT DISTINCT FROM list_price',
    "SELECT * FROM products WHERE name = 'O''Brien'",
    "SELECT * FROM products WHERE name = 'O\\'Brien'",
    'SELECT price::numeric, ARRAY[1, 2] FROM products WHERE id = ANY(ARRAY[1, 2, 3])',
    'SELECT a, b FROM products GROUP BY a, b ORDER BY a, b',
    'SELECT * FROM products LIMIT 10, 20',
    'SELECT * FROM products p JOIN products q ON p.id = q.parent_id, products r',
    "SELECT * FROM products FOR SYSTEM_TIME AS OF '2020-01-01'",
    'WITH s AS (SELECT * FROM products) SELECT * FROM s, products',
    'SELECT * FROM `products`',
    'SELECT * FROM [dbo].[products]',
    'SELECT * FROM public.products',
    'SELECT 1 FROM DUAL',
    'SELECT * FROM products WHERE id = :id',
    'SELECT * FROM products /* a comment, salaries */',
    'SELECT * FROM products -- , salaries',
  ];

  for (const sql of legitimate) {
    it(sql, () => {
      expect(controlOf(sql)).toBeUndefined();
    });
  }

  it('a digit-leading relation passes when it is allowed', () => {
    expect(
      controlOf('SELECT * FROM 2fa_codes', { allowedRelations: ['2fa_codes'] }),
    ).toBeUndefined();
  });
});
