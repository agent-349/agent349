/**
 * Engine-aware SQL tokenizer and relation scanner for the free-form guards.
 *
 * Which relations a statement reads depends on how the *engine* splits it into
 * strings, comments and identifiers, and engines disagree: MySQL escapes quotes
 * with a backslash and ends a block comment at the first `*\/`, PostgreSQL nests
 * block comments and has dollar quotes and `E'…'` strings, MySQL treats `#` as a
 * comment and `--` only when followed by a space, SQL Server quotes names with
 * brackets. A text that hides a relation inside a "string" under one set of
 * rules shows it as code under another.
 *
 * So the guards tokenize the statement once per engine family
 * ({@link LEXICAL_VARIANTS}) and take the union of what every variant that
 * could tokenize it reads. The engine that runs the statement lexes it like one
 * of those variants; if that variant cannot tokenize it (an unterminated string
 * under its rules), neither can the engine, and the statement fails there.
 * Constructs whose meaning no variant can model safely are rejected outright
 * ({@link UnsupportedSqlError}).
 */

/** Lexical rules of one engine family. */
export interface LexicalVariant {
  readonly name: string;
  /** `\'` escapes a quote inside string literals. */
  readonly backslashEscapes: boolean;
  /** `/* /* *\/ *\/` nests. */
  readonly nestedComments: boolean;
  /** `#` starts a line comment. */
  readonly hashComments: boolean;
  /** `--` is a comment only when followed by whitespace or the end (MySQL). */
  readonly dashCommentNeedsSpace: boolean;
  /** What `"…"` delimits. */
  readonly doubleQuote: 'identifier' | 'string';
  /** `$tag$ … $tag$` bodies (PostgreSQL). */
  readonly dollarQuotes: boolean;
  /** `E'…'` strings use backslash escapes (PostgreSQL). */
  readonly escapeStrings: boolean;
  /** `[name]` is a quoted identifier (SQL Server). */
  readonly bracketIdentifiers: boolean;
}

/** One lexical variant per engine family the SQL tools support. */
export const LEXICAL_VARIANTS: readonly LexicalVariant[] = [
  {
    name: 'postgres',
    backslashEscapes: false,
    nestedComments: true,
    hashComments: false,
    dashCommentNeedsSpace: false,
    doubleQuote: 'identifier',
    dollarQuotes: true,
    escapeStrings: true,
    bracketIdentifiers: false,
  },
  {
    name: 'mysql',
    backslashEscapes: true,
    nestedComments: false,
    hashComments: true,
    dashCommentNeedsSpace: true,
    doubleQuote: 'string',
    dollarQuotes: false,
    escapeStrings: false,
    bracketIdentifiers: false,
  },
  {
    name: 'mysql-ansi-quotes',
    backslashEscapes: true,
    nestedComments: false,
    hashComments: true,
    dashCommentNeedsSpace: true,
    doubleQuote: 'identifier',
    dollarQuotes: false,
    escapeStrings: false,
    bracketIdentifiers: false,
  },
  {
    name: 'mssql',
    backslashEscapes: false,
    nestedComments: true,
    hashComments: false,
    dashCommentNeedsSpace: false,
    doubleQuote: 'identifier',
    dollarQuotes: false,
    escapeStrings: false,
    bracketIdentifiers: true,
  },
  {
    name: 'oracle',
    backslashEscapes: false,
    nestedComments: false,
    hashComments: false,
    dashCommentNeedsSpace: false,
    doubleQuote: 'identifier',
    dollarQuotes: false,
    escapeStrings: false,
    bracketIdentifiers: false,
  },
];

export type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'param' | 'punct' | 'other';

/** A lexical token. Comments and whitespace are dropped. */
export interface SqlToken {
  readonly kind: TokenKind;
  /** Words and punctuation: the text; quoted identifiers: the unquoted name. */
  readonly value: string;
}

/** A construct no lexical variant can model safely; the statement must be rejected. */
export class UnsupportedSqlError extends Error {
  override readonly name = 'UnsupportedSqlError';
}

/** A statement the scanner cannot read with certainty; it must be rejected. */
export class UnreadableSqlError extends Error {
  override readonly name = 'UnreadableSqlError';
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[\w$\u0080-￿]/;

/**
 * Tokenizes `sql` under `variant`. Returns `undefined` when the text has an
 * unterminated string, quoted identifier or comment under these rules.
 *
 * @throws {@link UnsupportedSqlError} for MySQL executable comments (`/*!`)
 *         and Oracle alternative quoting (`q'…'`).
 */
export function tokenize(sql: string, variant: LexicalVariant): SqlToken[] | undefined {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // ── Comments ──────────────────────────────────────────────────────────
    if (ch === '-' && next === '-') {
      const after = sql[i + 2];
      if (!variant.dashCommentNeedsSpace || after === undefined || /\s/.test(after)) {
        const end = sql.indexOf('\n', i);
        i = end === -1 ? n : end;
        continue;
      }
    }
    if (ch === '#' && variant.hashComments) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      if (sql[i + 2] === '!') {
        throw new UnsupportedSqlError(
          'MySQL executable comments (/*! … */) are not allowed: MySQL runs their content as SQL.',
        );
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (variant.nestedComments && sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) return undefined;
      i = j;
      continue;
    }

    // ── Dollar-quoted bodies ──────────────────────────────────────────────
    if (ch === '$' && variant.dollarQuotes) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag !== null) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) return undefined;
        tokens.push({ kind: 'string', value: '' });
        i = end + tag[0].length;
        continue;
      }
    }

    // ── Quoted text ───────────────────────────────────────────────────────
    if (ch === "'" || (ch === '"' && variant.doubleQuote === 'string')) {
      const previous = tokens[tokens.length - 1];
      const prefixed =
        previous !== undefined && previous.kind === 'word' && i > 0 && WORD_PART.test(sql[i - 1]!);
      if (prefixed && /^n?q$/i.test(previous.value)) {
        throw new UnsupportedSqlError("Oracle alternative quoting (q'…') is not allowed.");
      }
      const escapes =
        variant.backslashEscapes ||
        (variant.escapeStrings && prefixed && /^e$/i.test(previous.value));
      const end = closeQuote(sql, i, ch, escapes);
      if (end === -1) return undefined;
      if (prefixed) tokens.pop(); // N'…', E'…', X'…', B'…' prefixes belong to the literal
      tokens.push({ kind: 'string', value: '' });
      i = end;
      continue;
    }
    if (ch === '"' || ch === '`' || (ch === '[' && variant.bracketIdentifiers)) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let name = '';
      let closed = false;
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            name += close;
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        name += sql[j];
        j += 1;
      }
      if (!closed) return undefined;
      tokens.push({ kind: 'ident', value: name });
      i = j;
      continue;
    }

    // ── Words, numbers, parameters, punctuation ───────────────────────────
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const numeric = /^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/.exec(sql.slice(i))![0];
      let j = i + numeric.length;
      if (j < n && WORD_PART.test(sql[j]!)) {
        // MySQL accepts identifiers that start with a digit (`2fa_codes`).
        while (j < n && WORD_PART.test(sql[j]!)) j += 1;
        tokens.push({ kind: 'word', value: sql.slice(i, j) });
      } else {
        tokens.push({ kind: 'number', value: numeric });
      }
      i = j;
      continue;
    }
    if (ch === '#' && variant.bracketIdentifiers && next !== undefined && /[#\w]/.test(next)) {
      // SQL Server temporary tables: #local, ##global.
      let j = i + 1;
      while (j < n && (sql[j] === '#' || WORD_PART.test(sql[j]!))) j += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === ':' && next !== undefined && /[A-Za-z_]/.test(next) && sql[i - 1] !== ':') {
      let j = i + 1;
      while (j < n && /\w/.test(sql[j]!)) j += 1;
      tokens.push({ kind: 'param', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if ('(),.;[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    tokens.push({ kind: 'other', value: ch });
    i += 1;
  }
  return tokens;
}

/** Index just past the closing quote of the literal opened at `start`, or -1 if unterminated. */
function closeQuote(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashEscapes && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relation scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words that end a FROM list at its nesting level: after them no engine
 * accepts another table reference. (`FOR` is deliberately absent: SQL Server's
 * `FROM t FOR SYSTEM_TIME AS OF …, u` continues the list.)
 */
const FROM_LIST_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'WINDOW',
  'QUALIFY',
  'CONNECT',
  'START',
  'RETURNING',
  'INTO',
]);

/** Words after which a table reference follows. */
const JOIN_WORDS = new Set(['JOIN', 'STRAIGHT_JOIN', 'APPLY']);

/** Functions whose argument syntax uses FROM without reading a table. */
const FROM_FUNCTIONS = new Set(['EXTRACT', 'SUBSTRING', 'SUBSTR', 'TRIM', 'OVERLAY']);

/** Table-reference prefixes that are not themselves relations. */
const REFERENCE_PREFIXES = new Set(['LATERAL', 'ONLY']);

/** Table functions that read no relation of their own. */
const NOT_RELATIONS = new Set(['select', 'lateral', 'unnest', 'only', 'values', 'table']);

/** Pseudo-tables that hold no data (Oracle, MySQL). */
const PSEUDO_TABLES = new Set(['dual']);

interface Frame {
  /** Inside a FROM list: a top-level comma starts another table reference. */
  fromList: boolean;
  /** Upper-cased word right before the opening parenthesis, if any. */
  opener: string | null;
}

/**
 * Relations a tokenized statement reads: every reference after FROM (each
 * item of a comma list), JOIN/STRAIGHT_JOIN/APPLY and TABLE, at every nesting
 * level. Qualified names keep their qualifier (`schema.table`).
 *
 * @throws {@link UnreadableSqlError} when a table position holds something
 *         that is not a name or a parenthesized subquery, or parentheses do
 *         not balance — the statement cannot be checked with certainty.
 */
export function scanRelations(tokens: readonly SqlToken[]): string[] {
  const found = new Set<string>();
  const frames: Frame[] = [{ fromList: false, opener: null }];
  let expectAt = -1; // nesting level at which a table reference is due

  const isWord = (t: SqlToken | undefined): t is SqlToken => t !== undefined && t.kind === 'word';
  const isName = (t: SqlToken | undefined): t is SqlToken =>
    t !== undefined && (t.kind === 'word' || t.kind === 'ident');
  const isPunct = (t: SqlToken | undefined, value: string): boolean =>
    t !== undefined && t.kind === 'punct' && t.value === value;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const depth = frames.length - 1;
    const frame = frames[depth]!;
    const afterDot = isPunct(tokens[i - 1], '.');

    if (expectAt === depth && !isPunct(t, '(')) {
      if (isWord(t) && REFERENCE_PREFIXES.has(t.value.toUpperCase())) continue;
      const shown = t.value === '' ? t.kind : t.value;
      if (!isName(t)) {
        throw new UnreadableSqlError(
          `Expected a table name or a parenthesized subquery, found '${shown}'.`,
        );
      }
      let name = t.value;
      let last = t.value;
      while (isPunct(tokens[i + 1], '.') && isName(tokens[i + 2])) {
        last = tokens[i + 2]!.value;
        name += '.' + last;
        i += 2;
      }
      const isFunction = isPunct(tokens[i + 1], '(');
      const pseudo = !isFunction && name === last && PSEUDO_TABLES.has(name.toLowerCase());
      if (!pseudo && (!isFunction || !NOT_RELATIONS.has(last.toLowerCase()))) found.add(name);
      expectAt = -1;
      continue;
    }

    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[') {
        if (expectAt === depth) expectAt = -1; // derived table: its own FROMs are scanned inside
        const before = tokens[i - 1];
        frames.push({
          fromList: false,
          opener: isWord(before) ? before.value.toUpperCase() : null,
        });
        continue;
      }
      if (t.value === ')' || t.value === ']') {
        if (frames.length === 1) throw new UnreadableSqlError('Unbalanced parentheses.');
        if (expectAt === depth) throw new UnreadableSqlError('A table reference is missing.');
        frames.pop();
        continue;
      }
      if (t.value === ',' && frame.fromList) {
        expectAt = depth;
      }
      continue;
    }

    if (t.kind !== 'word' || afterDot) continue;
    const word = t.value.toUpperCase();

    if (word === 'FROM') {
      if (frame.opener !== null && FROM_FUNCTIONS.has(frame.opener)) continue;
      const prev = tokens[i - 1];
      const prevPrev = tokens[i - 2];
      if (
        isWord(prev) &&
        prev.value.toUpperCase() === 'DISTINCT' &&
        isWord(prevPrev) &&
        ['IS', 'NOT'].includes(prevPrev.value.toUpperCase())
      ) {
        continue; // a IS [NOT] DISTINCT FROM b
      }
      frame.fromList = true;
      expectAt = depth;
    } else if (JOIN_WORDS.has(word)) {
      frame.fromList = true;
      expectAt = depth;
    } else if (word === 'TABLE' && isName(tokens[i + 1])) {
      expectAt = depth;
    } else if (FROM_LIST_END.has(word)) {
      frame.fromList = false;
    }
  }

  if (frames.length !== 1) throw new UnreadableSqlError('Unbalanced parentheses.');
  if (expectAt !== -1) throw new UnreadableSqlError('A table reference is missing.');
  return [...found];
}

/**
 * Names declared by a leading `WITH [RECURSIVE] name [(cols)] AS [NOT]
 * [MATERIALIZED] (…) [, …]` clause, lower-cased. Only the top-level clause
 * counts: a name declared inside a subquery is not visible outside it, so it
 * must not exempt a same-named relation elsewhere.
 */
export function scanCteNames(tokens: readonly SqlToken[]): Set<string> {
  const names = new Set<string>();
  const word = (i: number, value?: string): boolean => {
    const t = tokens[i];
    return (
      t !== undefined &&
      t.kind === 'word' &&
      (value === undefined || t.value.toUpperCase() === value)
    );
  };
  const punct = (i: number, value: string): boolean => {
    const t = tokens[i];
    return t !== undefined && t.kind === 'punct' && t.value === value;
  };
  const skipGroup = (i: number): number => {
    let depth = 0;
    for (let j = i; j < tokens.length; j += 1) {
      if (punct(j, '(')) depth += 1;
      else if (punct(j, ')')) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return tokens.length;
  };

  if (!word(0, 'WITH')) return names;
  let i = 1;
  if (word(i, 'RECURSIVE')) i += 1;
  for (;;) {
    const name = tokens[i];
    if (name === undefined || (name.kind !== 'word' && name.kind !== 'ident')) return names;
    i += 1;
    if (punct(i, '(')) i = skipGroup(i);
    if (!word(i, 'AS')) return names;
    i += 1;
    if (word(i, 'NOT')) i += 1;
    if (word(i, 'MATERIALIZED')) i += 1;
    if (!punct(i, '(')) return names;
    names.add(name.value.toLowerCase());
    i = skipGroup(i);
    if (!punct(i, ',')) return names;
    i += 1;
  }
}
