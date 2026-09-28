import { QueryRejectedError } from '../../../errors/index.js';
import { scrubSql, stripTrailingSemicolon } from './dialects.js';

/**
 * Statements that write, change structure, grant rights, or run code.
 *
 * `INTO` is here for `SELECT … INTO new_table`, which is a write wearing a
 * `SELECT` prefix and would otherwise sail past the read-only check.
 */
const FORBIDDEN = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COPY',
  'CALL',
  'EXEC',
  'EXECUTE',
  'DO',
  'VACUUM',
  'REINDEX',
  'LISTEN',
  'NOTIFY',
  'INTO',
] as const;

/** Options for {@link guardFreeformSql}. */
export interface FreeformGuardOptions {
  /**
   * Relations the query may reference, from `connection.relations`.
   * An empty list means no allowlist is enforced.
   */
  allowedRelations?: string[];
}

/** What a guard pass concluded. */
export interface GuardResult {
  /** The statement with any trailing semicolon removed, ready to be wrapped. */
  sql: string;
  /** Relation names the statement reads, excluding CTE names. */
  relations: string[];
}

/**
 * Runs the free-form guard chain over a model-authored statement.
 *
 * The chain, in order: one statement only, a read-only prefix, no forbidden
 * keywords, and every referenced relation on the allowlist.
 *
 * ### What this is not
 * It is **not** the security boundary, and reading it as one is the mistake it
 * most invites. Relation extraction is identifier scanning, not a SQL parser,
 * and a determined adversary gets past it. The actual guarantees live one
 * layer down and do not depend on understanding the statement: the read-only
 * transaction the dialect opens, and a database user whose grants stop at the
 * exposed relations. These checks exist to catch honest mistakes early, to
 * give the model a correctable message, and to keep the obvious cases from
 * ever reaching the engine.
 *
 * @param sql     - The statement written by the model.
 * @param options - Allowlist to enforce.
 * @returns The cleaned statement and the relations it reads.
 * @throws {@link QueryRejectedError} naming the guard that fired, in wording
 *         the model can act on.
 */
export function guardFreeformSql(sql: string, options: FreeformGuardOptions = {}): GuardResult {
  const trimmed = sql.trim();
  if (trimmed === '') {
    throw new QueryRejectedError('empty', 'The query is empty.');
  }

  const scrubbed = scrubSql(trimmed);

  // 1 — One statement. Stacked statements are how a second, unchecked query
  //     rides along behind the first.
  const withoutTrailing = scrubbed.trim().replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new QueryRejectedError(
      'single-statement',
      'Only one statement per call. Remove the extra `;` and send a single SELECT.',
    );
  }

  // 2 — Read-only shape.
  if (!/^\s*(?:select|with|table|values)\b/i.test(withoutTrailing)) {
    throw new QueryRejectedError(
      'read-only',
      'Only read queries are allowed. The statement must start with SELECT or WITH.',
    );
  }

  // 3 — Forbidden keywords, matched on whole words in executable text only.
  for (const keyword of FORBIDDEN) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(withoutTrailing)) {
      throw new QueryRejectedError(
        'read-only',
        `The statement uses ${keyword}, which is not allowed. Only read queries are permitted.`,
      );
    }
  }

  // 4 — Relation allowlist, with CTE names exempted: they are defined by the
  //     query itself, not tables it is reaching into.
  const cteNames = extractCteNames(withoutTrailing);
  const referenced = extractRelations(withoutTrailing).filter(
    (relation) => !cteNames.has(relation.toLowerCase()),
  );

  const allowed = options.allowedRelations ?? [];
  if (allowed.length > 0) {
    const allowedSet = new Set(allowed.map((name) => name.toLowerCase()));
    for (const relation of referenced) {
      // A schema-qualified name matches either spelling, so declaring
      // `v_sales` covers `public.v_sales`.
      const bare = relation.includes('.')
        ? relation.slice(relation.lastIndexOf('.') + 1)
        : relation;
      if (!allowedSet.has(relation.toLowerCase()) && !allowedSet.has(bare.toLowerCase())) {
        throw new QueryRejectedError(
          'allowed-relations',
          `Relation '${relation}' is not available. You can query: ${allowed.join(', ')}.`,
        );
      }
    }
  }

  return { sql: stripTrailingSemicolon(trimmed), relations: referenced };
}

/** Matches a relation name after FROM or JOIN, optionally schema-qualified. */
const RELATION = /\b(?:from|join)\s+((?:[a-zA-Z_][\w$]*)(?:\s*\.\s*[a-zA-Z_][\w$]*)*)/gi;

/** Keywords that can follow FROM but are not relation names. */
const NOT_RELATIONS = new Set(['select', 'lateral', 'unnest', 'only', 'values', 'table']);

/**
 * Extracts the relation names a scrubbed statement reads.
 *
 * Identifier scanning, not parsing: a subquery (`FROM (SELECT …)`) yields no
 * name because the next token is a parenthesis, and that is correct — the
 * relations inside it are matched by their own FROM clauses.
 *
 * @param scrubbed - SQL already passed through `scrubSql`.
 */
export function extractRelations(scrubbed: string): string[] {
  const found = new Set<string>();
  for (const match of scrubbed.matchAll(RELATION)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const name = raw.replace(/\s+/g, '');
    if (NOT_RELATIONS.has(name.toLowerCase())) continue;
    found.add(name);
  }
  return [...found];
}

/**
 * Collects the names bound by a leading `WITH` clause.
 *
 * Without this, `WITH recent AS (SELECT …) SELECT * FROM recent` would be
 * rejected for reading a relation called `recent` that no allowlist could ever
 * contain — the query defines it itself.
 *
 * Parsing is deliberately narrow: it walks the `name AS ( … )` list from the
 * start of the statement with balanced parentheses, and stops at the first
 * thing that does not fit. A name it fails to collect costs a false rejection,
 * never a false approval.
 *
 * @param scrubbed - SQL already passed through `scrubSql`.
 * @returns Lower-cased CTE names.
 */
export function extractCteNames(scrubbed: string): Set<string> {
  const names = new Set<string>();
  const start = /^\s*with\s+(recursive\s+)?/i.exec(scrubbed);
  if (start === null) return names;

  let i = start[0].length;
  for (;;) {
    const head =
      /^\s*([a-zA-Z_][\w$]*)\s*(\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/i.exec(
        scrubbed.slice(i),
      );
    if (head === null) return names;

    const name = head[1];
    if (name === undefined) return names;
    names.add(name.toLowerCase());

    // Skip the CTE body, tracking nesting so an inner subquery does not end it.
    let depth = 1;
    let j = i + head[0].length;
    while (j < scrubbed.length && depth > 0) {
      const ch = scrubbed[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }

    const next = /^\s*,\s*/.exec(scrubbed.slice(j));
    if (next === null) return names;
    i = j + next[0].length;
  }
}
