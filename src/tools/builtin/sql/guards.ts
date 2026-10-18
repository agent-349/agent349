import { QueryRejectedError } from '../../../errors/index.js';
import { stripTrailingSemicolon } from './dialects.js';
import {
  LEXICAL_VARIANTS,
  scanCteNames,
  scanRelations,
  tokenize,
  UnreadableSqlError,
  UnsupportedSqlError,
} from './sqlLexer.js';
import type { SqlToken } from './sqlLexer.js';

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
 * keywords, and every referenced relation on the allowlist. Each check runs
 * over the statement as every supported engine would tokenize it (strings,
 * escapes, comments and quoted names differ between engines; see
 * `sqlLexer.ts`), so text that is a harmless string under one engine's rules
 * but code under another's is still checked. Relations are read from every
 * item of a FROM list, JOIN/STRAIGHT_JOIN/APPLY and TABLE, at every nesting
 * level. What cannot be checked with certainty is rejected: an unterminated
 * literal under every engine's rules (`unparseable`), a FROM position holding
 * something other than a name or a subquery (`unparseable`), MySQL
 * executable comments and Oracle `q'…'` quoting (`unsupported-syntax`).
 *
 * ### What this is not
 * It is **not** the security boundary, and reading it as one is the mistake it
 * most invites. Relation extraction is a token scan, not a SQL parser:
 * function calls in the select list (e.g. a function that reads a file or
 * queries another server) are not relations and are not checked. The actual guarantees live one
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

  // 1. Tokenize under every engine's lexical rules (see sqlLexer.ts). The
  //    checks below run over each reading that tokenizes; a trick that hides
  //    a statement or a relation under one engine's rules shows under another.
  const readings: SqlToken[][] = [];
  for (const variant of LEXICAL_VARIANTS) {
    let tokens: SqlToken[] | undefined;
    try {
      tokens = tokenize(trimmed, variant);
    } catch (err) {
      if (err instanceof UnsupportedSqlError) {
        throw new QueryRejectedError('unsupported-syntax', err.message);
      }
      throw err;
    }
    if (tokens !== undefined) readings.push(stripTrailingSemicolonToken(tokens));
  }
  if (readings.length === 0) {
    throw new QueryRejectedError(
      'unparseable',
      'The query has an unterminated string, quoted name or comment. Close it and send a single SELECT.',
    );
  }

  // 2. One statement only.
  for (const tokens of readings) {
    if (tokens.some((t) => t.kind === 'punct' && t.value === ';')) {
      throw new QueryRejectedError(
        'single-statement',
        'Only one statement per call. Remove the extra `;` and send a single SELECT.',
      );
    }
  }

  // 3. A read prefix.
  for (const tokens of readings) {
    const first = tokens[0];
    if (
      first === undefined ||
      first.kind !== 'word' ||
      !READ_PREFIXES.has(first.value.toUpperCase())
    ) {
      throw new QueryRejectedError(
        'read-only',
        'Only read queries are allowed. The statement must start with SELECT or WITH.',
      );
    }
  }

  // 4. No forbidden keyword as a bare word (a column `t.delete` or a quoted
  //    name "insert" is not a statement).
  for (const tokens of readings) {
    tokens.forEach((t, i) => {
      if (t.kind !== 'word') return;
      const previous = tokens[i - 1];
      if (previous !== undefined && previous.kind === 'punct' && previous.value === '.') return;
      const keyword = t.value.toUpperCase();
      if (FORBIDDEN_SET.has(keyword)) {
        throw new QueryRejectedError(
          'read-only',
          `The statement uses ${keyword}, which is not allowed. Only read queries are permitted.`,
        );
      }
    });
  }

  // 5. Relations, per reading, minus the top-level CTE names; union of all.
  //    A reading whose table positions do not hold names (e.g. `FROM "t"`
  //    read as a string, as MySQL does by default) is one its engine cannot
  //    run either, so it is set aside; if no reading is left, the statement
  //    cannot be checked and is rejected.
  const referenced = new Set<string>();
  let unreadable: UnreadableSqlError | undefined;
  let checked = 0;
  for (const tokens of readings) {
    let relations: string[];
    try {
      relations = scanRelations(tokens);
    } catch (err) {
      if (err instanceof UnreadableSqlError) {
        unreadable = err;
        continue;
      }
      throw err;
    }
    checked += 1;
    const ctes = scanCteNames(tokens);
    for (const relation of relations) {
      if (!ctes.has(relation.toLowerCase())) referenced.add(relation);
    }
  }
  if (checked === 0) {
    throw new QueryRejectedError(
      'unparseable',
      `The query could not be checked: ${unreadable?.message ?? 'unreadable statement.'} ` +
        'Reference tables by name.',
    );
  }

  const allowed = options.allowedRelations ?? [];
  if (allowed.length > 0) {
    const allowedSet = new Set(allowed.map((name) => name.toLowerCase()));
    for (const relation of referenced) {
      // A schema-qualified spelling of an allowed bare name is the same relation
      // (declaring `v_sales` covers `public.v_sales`).
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

  return { sql: stripTrailingSemicolon(trimmed), relations: [...referenced] };
}

const READ_PREFIXES = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES']);
const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN);

function stripTrailingSemicolonToken(tokens: SqlToken[]): SqlToken[] {
  const last = tokens[tokens.length - 1];
  return last !== undefined && last.kind === 'punct' && last.value === ';'
    ? tokens.slice(0, -1)
    : tokens;
}

/** The PostgreSQL reading of `sql`, for the standalone helpers below. */
function postgresTokens(sql: string): SqlToken[] {
  try {
    return tokenize(sql, LEXICAL_VARIANTS[0]!) ?? [];
  } catch {
    return [];
  }
}

/**
 * Relation names read after FROM (every item of a comma list), JOIN and
 * TABLE, with schema qualifiers kept and whitespace removed. Deduplicated, in
 * order of first appearance. Uses PostgreSQL lexical rules; the guard itself
 * ({@link guardFreeformSql}) checks every engine's. A statement the scanner
 * cannot read yields no names.
 *
 * @param sql - Statement text (raw or scrubbed).
 */
export function extractRelations(sql: string): string[] {
  try {
    return scanRelations(postgresTokens(sql));
  } catch {
    return [];
  }
}

/**
 * Names declared by a leading WITH clause (lower-cased), so their uses are not
 * mistaken for relations. Only the top-level clause counts.
 *
 * @param sql - Statement text (raw or scrubbed).
 */
export function extractCteNames(sql: string): Set<string> {
  return scanCteNames(postgresTokens(sql));
}
