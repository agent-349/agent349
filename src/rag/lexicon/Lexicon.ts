import type { GlossaryEntry } from '../../types/index.js';
import { PROTECTED_WORDS, STOP_WORDS } from './stopwords.js';

export type { GlossaryEntry };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of {@link parseGlossary}. */
export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  /** Lines that could not be read, 1-based, with the reason. */
  errors: { line: number; text: string; reason: string }[];
}

/** Stop-word settings (`rag.lexicon` in the SDK configuration). */
export interface StopWordOptions {
  /**
   * `'auto'` — the built-in lists of {@link StopWordOptions.languages} (all
   * built-in languages when none is given); `false` — none; a list — exactly
   * those words.
   */
  stopWords?: 'auto' | false | string[];
  /** Languages whose built-in lists apply (ISO 639-1, `'es-UY'` counts as `'es'`). */
  languages?: string[];
  /** Words added to the lists. */
  extraStopWords?: string[];
  /** Words never removed, on top of the built-in protected words (negations, exclusions). */
  keepWords?: string[];
}

/** Result of {@link StopWords.keywordQuery}. */
export interface KeywordQuery {
  /** The text for the keyword component of the search. */
  text: string;
  /** How many words were removed. */
  removed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** Lower case without diacritics: the comparison key for words and terms. */
export function normaliseTerm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO 639-1 code of a language tag (`'es-UY'` → `'es'`). */
function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop words
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes stop words from the text sent to the keyword component of a search.
 *
 * Applied by the pipeline to the query only — never to the documents — so it
 * works the same on every vector store, needs no re-indexing and keeps no
 * per-index state. The vector component always gets the full question: there,
 * function words carry meaning.
 */
export class StopWords {
  readonly #fixed: Set<string> | undefined;
  readonly #rawFixed: string[] | undefined;
  readonly #rawExtra: string[];
  readonly #byLanguage: Map<string, Set<string>>;
  readonly #extra: Set<string>;
  readonly #keep: Set<string>;
  readonly #defaultLanguages: string[];
  readonly #enabled: boolean;

  constructor(options: StopWordOptions = {}) {
    const mode = options.stopWords ?? 'auto';
    this.#enabled = mode !== false;
    this.#fixed = Array.isArray(mode) ? new Set(mode.map(normaliseTerm)) : undefined;
    this.#rawFixed = Array.isArray(mode) ? [...mode] : undefined;
    this.#rawExtra = [...(options.extraStopWords ?? [])];
    this.#byLanguage = new Map(
      Object.entries(STOP_WORDS).map(([lang, words]) => [lang, new Set(words.map(normaliseTerm))]),
    );
    this.#extra = new Set((options.extraStopWords ?? []).map(normaliseTerm));
    this.#keep = new Set([...PROTECTED_WORDS, ...(options.keepWords ?? [])].map(normaliseTerm));
    this.#defaultLanguages = (options.languages ?? []).map(baseLanguage).filter(Boolean);
  }

  /** Whether stop words are removed at all. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** Languages with a built-in list. */
  static get languages(): string[] {
    return Object.keys(STOP_WORDS);
  }

  /**
   * The keyword text for `query`: the query without stop words. When every
   * word is a stop word, the query is returned unchanged.
   *
   * @param query     - The search text.
   * @param languages - Languages of the collection (overrides the configured ones).
   */
  keywordQuery(query: string, languages?: string[]): KeywordQuery {
    if (!this.#enabled) return { text: query, removed: 0 };
    const words = this.#wordsFor(languages);
    const tokens = query.split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    for (const token of tokens) {
      // Strip punctuation around the word ("¿qué", "falsos?") but keep inner
      // symbols ("U$S", "e-mail").
      const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (core.length === 0) continue;
      const key = normaliseTerm(core);
      if (!this.#keep.has(key) && words.has(key)) continue;
      kept.push(core);
    }
    if (kept.length === 0) return { text: query, removed: 0 };
    const removed = tokens.length - kept.length;
    return { text: removed > 0 ? kept.join(' ') : query, removed };
  }

  /**
   * The stop words for `languages`, for engines that apply them natively:
   * each word as written and without accents (engines differ in whether they
   * fold accents), lower-case, without protected or kept words, sorted.
   * Empty when stop words are off.
   *
   * @param languages - Languages of the collection (overrides the configured ones).
   */
  list(languages?: string[]): string[] {
    if (!this.#enabled) return [];
    let raw: string[];
    if (this.#rawFixed !== undefined) {
      raw = [...this.#rawFixed, ...this.#rawExtra];
    } else {
      const requested = (languages ?? []).map(baseLanguage).filter(Boolean);
      const langs = requested.length > 0 ? requested : this.#defaultLanguages;
      const lists = langs.length > 0 ? langs : Object.keys(STOP_WORDS);
      raw = [...this.#rawExtra, ...lists.flatMap((l) => [...(STOP_WORDS[l] ?? [])])];
    }
    const out = new Set<string>();
    for (const word of raw) {
      const key = normaliseTerm(word);
      if (key.length === 0 || this.#keep.has(key)) continue;
      out.add(word.trim().toLowerCase());
      out.add(key);
    }
    return [...out].sort();
  }

  #wordsFor(languages: string[] | undefined): Set<string> {
    if (this.#fixed !== undefined) return new Set([...this.#fixed, ...this.#extra]);
    const requested = (languages ?? []).map(baseLanguage).filter(Boolean);
    const langs = requested.length > 0 ? requested : this.#defaultLanguages;
    const lists = langs.length > 0 ? langs : [...this.#byLanguage.keys()];
    const out = new Set(this.#extra);
    for (const lang of lists) for (const w of this.#byLanguage.get(lang) ?? []) out.add(w);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Glossary
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LINE = 1000;
const MAX_ENTRIES = 5000;

/**
 * Reads a glossary in its text format, one entry per line:
 *
 * ```text
 * # comments start with '#'
 * KPI = key performance indicator            (term = meaning)
 * HR, human resources = staff and payroll    (several terms, one meaning)
 * PTO, annual leave, vacation                (equivalent terms, at least two)
 * ```
 *
 * Never throws: unreadable lines are reported in `errors`.
 */
export function parseGlossary(text: string): GlossaryParseResult {
  const entries: GlossaryEntry[] = [];
  const errors: GlossaryParseResult['errors'] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const fail = (reason: string): void => {
      errors.push({ line: i + 1, text: line.slice(0, 120), reason });
    };
    if (line.length > MAX_LINE) return fail(`longer than ${MAX_LINE} characters`);
    if (entries.length >= MAX_ENTRIES) return fail(`more than ${MAX_ENTRIES} entries`);
    const eq = line.indexOf('=');
    const left = eq >= 0 ? line.slice(0, eq) : line;
    const definition = eq >= 0 ? line.slice(eq + 1).trim() : undefined;
    const terms = [
      ...new Set(
        left
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    if (terms.length === 0) return fail('no term before "="');
    if (eq >= 0 && (definition === undefined || definition.length === 0)) {
      return fail('nothing after "="');
    }
    if (eq < 0 && terms.length < 2) {
      return fail('a single term needs a meaning ("term = meaning") or equivalents ("a, b")');
    }
    entries.push({ terms, ...(definition !== undefined && { definition }) });
  });
  return { entries, errors };
}

/**
 * Merges glossaries, later ones first: an entry of a later glossary replaces
 * the entries of earlier ones that share a term with it (a collection's
 * glossary overrides the installation's).
 */
export function mergeGlossaries(...glossaries: (GlossaryEntry[] | undefined)[]): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (let g = glossaries.length - 1; g >= 0; g--) {
    for (const entry of glossaries[g] ?? []) {
      const keys = entry.terms.map(normaliseTerm);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      out.push(entry);
    }
  }
  return out;
}

/**
 * The entries whose terms occur in any of `texts`, as whole words or phrases
 * (case and accent insensitive), at most `max`.
 */
export function matchGlossary(
  entries: GlossaryEntry[],
  texts: string[],
  max = 20,
): GlossaryEntry[] {
  return matchGlossaryTerms(entries, texts, max).map((m) => m.entry);
}

/**
 * Like {@link matchGlossary}, also returning the term of each entry that was
 * found (the one the user wrote, for traces).
 */
export function matchGlossaryTerms(
  entries: GlossaryEntry[],
  texts: string[],
  max = 20,
): { entry: GlossaryEntry; term: string }[] {
  if (entries.length === 0) return [];
  const haystack = texts.map(normaliseTerm).join('\n');
  if (haystack.length === 0) return [];
  const found: { entry: GlossaryEntry; term: string }[] = [];
  for (const entry of entries) {
    if (found.length >= max) break;
    const term = entry.terms.find((t) => {
      const key = normaliseTerm(t);
      if (key.length === 0) return false;
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'u',
      );
      return re.test(haystack);
    });
    if (term !== undefined) found.push({ entry, term });
  }
  return found;
}

/** Glossary entries as prompt lines. */
export function formatGlossary(entries: GlossaryEntry[]): string {
  return entries
    .map((e) =>
      e.definition !== undefined
        ? `- ${e.terms.join(' / ')}: ${e.definition}`
        : `- ${e.terms.join(' = ')} (same thing)`,
    )
    .join('\n');
}
