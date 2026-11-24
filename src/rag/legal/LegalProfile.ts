import { LEGAL_LANGUAGES, LEGAL_PACKS } from './packs.js';
import type { LegalPack, RelationTypeName } from './packs.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** An installation's own kind of reference. */
export interface LegalReferenceConfig {
  /** Key prefix (`circular`, `policy`…). */
  kind: string;
  /** Words that name it (regex fragments, case-insensitive): an identifier follows them. */
  words?: string[];
  /** Or a full regular expression whose capture groups form the identifier. */
  pattern?: string;
  /** `roman` also accepts Roman numerals. */
  id?: 'number' | 'roman';
  /** Order of two-part identifiers. Default: `number/year`. */
  order?: IdOrder;
}

/**
 * How a document's own identity is found (`rag.legal.identity`): which norm
 * the document is, so that references and relations from other documents
 * reach it.
 */
export interface LegalIdentityConfig {
  /**
   * Also read the document's own designation from the beginning of its text
   * (the heading line before the preamble: "DECRETO N° 120/015", "Real
   * Decreto 123/2020, de…"). The title wins over the heading for the same
   * kind of reference. Default: true.
   */
  header?: boolean;
  /**
   * Ask a model for the designation when neither the title nor the heading
   * gives one. Off by default; one call per unidentified document.
   */
  llm?: {
    /** `off` (default) or `fallback`. */
    mode?: 'off' | 'fallback';
    llmProvider?: string;
    model?: string;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    /** Characters of the beginning of the text sent to the model. Default: 2000. */
    maxChars?: number;
    /** Abort after this many milliseconds. Default: 20000. */
    timeoutMs?: number;
  };
}

/** Legal language configuration (`rag.legal`). */
export interface LegalConfig {
  /** Built-in language packs to use. Default: all (`es`, `pt`, `en`, `fr`, `it`, `de`). */
  packs?: LegalPack['language'][];
  /**
   * Two-digit years up to this value are read as 20YY, above it as 19YY
   * ("120/15" → 2015, "45/98" → 1998). Default: the current two-digit year + 1.
   */
  yearPivot?: number;
  /**
   * A title like "30 - ANEXO - …" (number, annex word, no identifier of its
   * own) identifies `annex:30`. Default: false.
   */
  numberedTitles?: boolean;
  /** Additional kinds of references. */
  references?: LegalReferenceConfig[];
  /** Additional operative verbs. */
  relations?: { type: RelationTypeName; words: string[] }[];
  /** Additional preamble words (regex fragments), merged with the packs'. */
  preamble?: string[];
  /** How a document's own identity is found. */
  identity?: LegalIdentityConfig;
  /** Additional structure words (regex fragments), merged with the packs'. */
  structure?: {
    article?: string[];
    paragraph?: string[];
    division?: string[];
    repealed?: string[];
    wording?: string[];
    internal?: string[];
    external?: string[];
    unitWords?: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compiled pieces
// ─────────────────────────────────────────────────────────────────────────────

/** Order of a two-part identifier: "120/15" (number/year) or "78-17" (year/number, France). */
export type IdOrder = 'number/year' | 'year/number';

/** A compiled reference pattern. */
export interface CompiledReference {
  kind: string;
  re: RegExp;
  /** `number`: groups (date, dateYear, euPrefix, id, euSuffix); `roman`: group id; `citation`: every group. */
  id: 'number' | 'roman' | 'citation';
  yearFirst?: boolean;
  /** Identifier order of the pack the words come from. */
  order?: IdOrder;
  /** Words after which a bare four-digit year is part of a title ("Companies Act 2006"), not an identifier. */
  titleYear?: RegExp;
}

const EU_MARK = '(?:UE|EU|CE|EC|EG|EWG|EEC|CEE)';

/** Optional "number" marker before an identifier: N°, Nº, No., Nro., Nr., núm., n.º, #. */
export const NUM = String.raw`(?:(?:n(?:[°º]|o\.?|ro\.?|r\.?|\.º|[uú]m\.?)|n\.|n(?=\s+\d))\s*|#\s*)?`;

/**
 * The number of an identifier: thousands separators ("12.345", "1,234,567")
 * or a compound written with dots or commas ("21.0070", "21,0070", "2024.15").
 */
const NUMBER = String.raw`\d{1,5}(?:(?:[.,]\d{3})+(?!\d|[.,]\d)|(?:[.,]\d{1,6})+)?`;

/**
 * A norm identifier: an optional series letter ("A 7000"), a number (see
 * {@link NUMBER}), an optional year or second number ("120/15", "2016/679",
 * "120-2015") and an optional bis/ter.
 */
const ID = String.raw`(?:[A-Z][\s-]?)?${NUMBER}(?:\s*[/-]\s*\d{1,5})?(?:[\s-]?(?:bis|ter|quater))?`;

/**
 * Canonical form of a number written with dots or commas: thousands
 * separators are dropped when every group after the first has three digits
 * and the first has one to three ("19.889", "12,345" → `19889`, `12345`);
 * otherwise the dots or commas separate the parts of a compound number, kept
 * without leading zeros and always joined with a dot ("21.0070" and
 * "21,0070" → `21.70`).
 */
function canonicalNumber(raw: string): string | undefined {
  if (/^\d{1,5}$/.test(raw)) return String(Number(raw));
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return String(Number(raw.replace(/[.,]/g, '')));
  if (/^\d{1,5}(?:[.,]\d{1,6})+$/.test(raw)) return raw.split(/[.,]/).map(Number).join('.');
  return undefined;
}

const ROMAN_ID = String.raw`[IVXLCDM]{1,8}|\d{1,4}`;

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const alt = (xs: string[]): string => uniq(xs).join('|');

/**
 * A legal language profile: the built-in packs chosen in `rag.legal.packs`
 * plus the installation's own words, compiled once and shared by the
 * reference, relation and structure extractors. Also owns the
 * normalisation of identifiers, so that "Decreto 120/15", "Decreto N°
 * 120/2015" and "Decreto 120-015" share a key.
 */
export class LegalProfile {
  readonly languages: LegalPack['language'][];
  readonly numberedTitles: boolean;
  readonly references: CompiledReference[];
  readonly relationVerbs: { type: RelationTypeName; re: RegExp }[];
  readonly partial: RegExp;
  /** A line that opens the preamble or enacting formula ("VISTO:", "WHEREAS,"). */
  readonly preamble: RegExp;
  /** A line that opens an article ("Artículo 1", "Art. 2º", "§ 3"). */
  readonly articleLine: RegExp;
  /** `rag.legal.identity.header` (default true). */
  readonly identityFromHeader: boolean;
  /** "artículo 5", "arts. 5 y 7", "§ 5", "Section 5(a)" — group 1: the numbers. */
  readonly articleRef: RegExp;
  readonly structure: {
    article: string;
    sole: string;
    first: string;
    paragraph: string;
    division: string;
    repealed: RegExp;
    wording: RegExp;
    internal: string;
    external: string;
    previous: string;
    next: string;
    unitWords: string;
    /** Some active pack reads a line-start "§" inside an article as a paragraph (Brazil). */
    signAsParagraph: boolean;
  };
  readonly annexWords: string;
  readonly #yearPivot: number;
  readonly #articleWords: string;

  constructor(config: LegalConfig = {}) {
    this.languages = (config.packs ?? LEGAL_LANGUAGES).filter((l) => LEGAL_PACKS[l] !== undefined);
    const packs = this.languages.map((l) => LEGAL_PACKS[l]);
    this.numberedTitles = config.numberedTitles === true;
    this.#yearPivot = config.yearPivot ?? (new Date().getFullYear() % 100) + 1;

    // References: one pattern per kind and identifier order (a pack's own
    // order — France writes year-number), then citations, then custom.
    type Group = {
      kind: string;
      words: string[];
      id: 'number' | 'roman';
      order: IdOrder;
      titleYear?: string[];
    };
    const groups = new Map<string, Group>();
    const addWords = (
      kind: string,
      ws: string[],
      id: 'number' | 'roman',
      order: IdOrder,
      titleYear?: string[],
      first = false,
    ): void => {
      const k = `${kind}|${id === 'roman' ? 'roman' : order}`;
      const cur = groups.get(k) ?? {
        kind,
        words: [],
        id,
        order,
        ...(titleYear !== undefined && { titleYear: [] }),
      };
      if (first) cur.words.unshift(...ws);
      else cur.words.push(...ws);
      if (titleYear !== undefined) cur.titleYear = uniq([...(cur.titleYear ?? []), ...titleYear]);
      groups.set(k, cur);
    };
    const custom = config.references ?? [];
    for (const c of custom) {
      if (c.words !== undefined && c.words.length > 0) {
        addWords(c.kind, c.words, c.id ?? 'number', c.order ?? 'number/year', undefined, true);
      }
    }
    for (const p of packs) {
      for (const r of p.references) {
        addWords(
          r.kind,
          r.words,
          r.id ?? 'number',
          r.order ?? p.idOrder ?? 'number/year',
          p.titleYear,
        );
      }
    }
    const refs: CompiledReference[] = [];
    for (const g of groups.values()) {
      // Longer words first, so "real decreto" wins over "decreto".
      const ws = alt([...g.words].sort((a, b) => b.length - a.length));
      if (g.id === 'roman') {
        refs.push({
          kind: g.kind,
          re: new RegExp(String.raw`(?<![\p{L}\d-])(?:${ws})\s+${NUM}(${ROMAN_ID})\b`, 'giu'),
          id: 'roman',
        });
        continue;
      }
      refs.push({
        kind: g.kind,
        // Groups: 1 date, 2 its year ("30 giugno 2003, n. 196"), 3 EU prefix, 4 id, 5 EU suffix.
        re: new RegExp(
          String.raw`(?<![\p{L}\d-])(?:${ws})\s+(\d{1,2}\s+\p{L}{3,12}\s+(\d{4}),?\s+(?=n))?(\(${EU_MARK}\)\s*)?${NUM}(${ID})(\/${EU_MARK}\b)?(?![\d/])`,
          'giu',
        ),
        id: 'number',
        order: g.order,
        ...(g.titleYear !== undefined &&
          g.titleYear.length > 0 && {
            titleYear: new RegExp(String.raw`^(?:${alt(g.titleYear)})(?![\p{L}])`, 'iu'),
          }),
      });
    }
    for (const p of packs) {
      for (const c of p.citations ?? []) {
        refs.push({
          kind: c.kind,
          re: new RegExp(c.pattern, 'giu'),
          id: 'citation',
          ...(c.yearFirst === true && { yearFirst: true }),
        });
      }
    }
    for (const c of custom) {
      if (c.pattern !== undefined)
        refs.push({ kind: c.kind, re: new RegExp(c.pattern, 'giu'), id: 'citation' });
    }
    this.references = refs;

    // Relations.
    const verbs: Record<RelationTypeName, string[]> = {
      derogates: [],
      modifies: [],
      regulates: [],
    };
    for (const p of packs) {
      for (const t of Object.keys(verbs) as RelationTypeName[]) verbs[t].push(...p.relations[t]);
    }
    for (const c of config.relations ?? []) verbs[c.type].push(...c.words);
    this.relationVerbs = (Object.keys(verbs) as RelationTypeName[])
      .filter((t) => verbs[t].length > 0)
      .map((t) => ({
        type: t,
        re: new RegExp(`(?<![\\p{L}])(?:${alt(verbs[t])})(?![\\p{L}])`, 'iu'),
      }));
    this.partial = new RegExp(
      `(?<![\\p{L}])(?:${alt(packs.flatMap((p) => p.partial)) || '(?!)'})(?![\\p{L}])`,
      'iu',
    );
    const preamble =
      alt([...packs.flatMap((p) => p.preamble), ...(config.preamble ?? [])]) || '(?!)';
    this.preamble = new RegExp(String.raw`^\s*(?:${preamble})(?![\p{L}])`, 'iu');
    this.identityFromHeader = config.identity?.header !== false;
    const articleWords = alt(packs.flatMap((p) => p.articleWords)) || '(?!)';
    this.#articleWords = articleWords;
    const num = String.raw`\d{1,4}[a-z]?(?:\.\d{1,3})*(?:\([a-z0-9]{1,3}\))*\s*[°º]?`;
    this.articleRef = new RegExp(
      String.raw`(?<![\p{L}\d])(?:${articleWords})\s*(${num}(?:\s*(?:,|y|e|and|et|und|a|al|to|bis|–|-)\s*${num})*)`,
      'iu',
    );

    // Structure.
    const s = config.structure ?? {};
    const pick = (k: keyof LegalPack['structure']): string[] =>
      packs.flatMap((p) => p.structure[k] as string[]);
    const repealed = alt([...pick('repealed'), ...(s.repealed ?? [])]) || '(?!)';
    const wording = alt([...pick('wording'), ...(s.wording ?? [])]) || '(?!)';
    this.structure = {
      article: alt([...(s.article ?? []), ...pick('article')]) || '(?!)',
      sole: alt(pick('sole')) || '(?!)',
      first: alt(pick('first')) || '(?!)',
      paragraph: alt([...(s.paragraph ?? []), ...pick('paragraph')]) || '(?!)',
      division: alt([...(s.division ?? []), ...pick('division')]) || '(?!)',
      repealed: new RegExp(String.raw`[(\[]\s*(?:${repealed})(?![\p{L}])[^)\]]*[)\]]`, 'iu'),
      wording: new RegExp(String.raw`[(\[]\s*(?:${wording})\s+([^)\]]{2,120})[)\]]`, 'iu'),
      internal: alt([...(s.internal ?? []), ...pick('internal')]) || '(?!)',
      external: alt([...(s.external ?? []), ...pick('external')]) || '(?!)',
      previous: alt(pick('previous')) || '(?!)',
      next: alt(pick('next')) || '(?!)',
      unitWords: alt([...(s.unitWords ?? []), ...pick('unitWords')]) || '(?!)',
      signAsParagraph: packs.some((p) => p.structure.sectionSign === 'paragraph'),
    };
    this.articleLine = new RegExp(
      String.raw`^\s*(?:(?:${this.structure.article})\s*(?:\d|${this.structure.sole}|${this.structure.first})|§\s*\d)`,
      'iu',
    );
    this.annexWords =
      alt(
        packs.flatMap((p) =>
          p.references.filter((r) => r.kind === 'annex').flatMap((r) => r.words),
        ),
      ) || '(?!)';
  }

  /** The kinds of reference this profile knows (`law`, `decree`, `annex`…, plus custom). */
  kinds(): string[] {
    return uniq(this.references.map((r) => r.kind));
  }

  /** Words naming an article-level unit in a reference (regex alternation). */
  articleRefWords(): string {
    return this.#articleWords;
  }

  /** Four-digit year of a written year ("15" → 2015, "009" → 2009, "1998" → 1998). */
  year(written: string): string {
    if (written.length === 4) return written;
    const yy = Number(written.slice(-2));
    return String(yy <= this.#yearPivot ? 2000 + yy : 1900 + yy);
  }

  /**
   * Normalised identifier of a number-style reference, or undefined when it
   * is not a valid one.
   *
   * @param raw       - The identifier as written ("N° 120/015", "2016/679", "A 7000").
   * @param yearFirst - The context marks a year/number order (EU "(UE) 2016/679", "2006/48/CE").
   */
  normaliseNumber(
    raw: string,
    yearFirst = false,
    order: IdOrder = 'number/year',
    dateYear?: string,
  ): string | undefined {
    let s = raw.trim();
    let series = '';
    const letter = /^([A-Za-z])[\s-]?(?=\d)/.exec(s);
    if (letter !== null) {
      // Only an upper-case letter is a series ("Comunicación A 7000").
      if (letter[1] === letter[1]!.toUpperCase()) series = `${letter[1].toLowerCase()}-`;
      s = s.slice(letter[0].length);
    }
    let suffix = '';
    const sx = /[\s-]?(bis|ter|quater)$/i.exec(s);
    if (sx !== null) {
      suffix = `-${sx[1]!.toLowerCase()}`;
      s = s.slice(0, sx.index);
    }
    const pair = /^(\d{1,5}(?:[.,]\d{1,6})*)\s*[/-]\s*(\d{1,5})$/.exec(s);
    if (pair === null) {
      const n = canonicalNumber(s);
      if (n === undefined) return undefined;
      const year = dateYear !== undefined ? `/${dateYear}` : '';
      return `${series}${n}${year}${suffix}`;
    }
    const first = canonicalNumber(pair[1]!);
    if (first === undefined) return undefined;
    // A compound first part ("21.0070/2021") keeps its form; the year/number
    // checks below apply to plain numbers only.
    if (first.includes('.')) {
      const second = pair[2]!;
      return second.length >= 2 && second.length <= 4
        ? `${series}${first}/${this.year(second)}${suffix}`
        : `${series}${first}-${Number(second)}${suffix}`;
    }
    let [a, b] = [first, pair[2]!];
    const isYear = (x: string): boolean => x.length === 4 && Number(x) >= 1800 && Number(x) <= 2199;
    // Year/number ("2016/679", "2018/293", "2018/5"): marked by the context
    // (EU), or by the shape — a four-digit year first, then a number that
    // cannot be a year (one digit, three digits without a leading zero, five
    // digits, or four digits out of range). "120/15", "120/015" and
    // "120/2015" stay number/year.
    const yearShaped = b.length === 2 || (b.length === 3 && b.startsWith('0')) || isYear(b);
    if (isYear(a) && (yearFirst || !yearShaped)) [a, b] = [b, a];
    // A pack that writes year-number ("Loi n° 78-17", "décret n° 2004-374").
    else if (order === 'year/number' && (a.length === 2 || isYear(a))) [a, b] = [b, a];
    if (b.length >= 2 && b.length <= 4 && (b.length !== 4 || isYear(b))) {
      return `${series}${Number(a)}/${this.year(b)}${suffix}`;
    }
    // Not a year: a compound number ("1234-5").
    return `${series}${Number(a)}-${Number(b)}${suffix}`;
  }

  /**
   * Re-normalises a stored key written with an earlier format (two-digit
   * years: `decree:120/15` → `decree:120/2015`). Keys already current are
   * returned unchanged.
   */
  normaliseKey(key: string): string {
    const m = /^([^:]+):(.+)$/.exec(key);
    if (m === null) return key;
    const y = /^(.*\d)\/(\d{2,3})(-[a-z]+)?$/.exec(m[2]!);
    if (y === null) return key;
    return `${m[1]}:${y[1]}/${this.year(y[2]!)}${y[3] ?? ''}`;
  }
}

/** Arabic value of a canonical Roman numeral, or undefined ("IIII", "VX"). */
export function fromRoman(text: string): number | undefined {
  const V: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const s = text.toUpperCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = V[s[i]!];
    const next = V[s[i + 1] ?? ''] ?? 0;
    if (v === undefined) return undefined;
    total += v < next ? -v : v;
  }
  return toRoman(total) === s ? total : undefined;
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  for (const [v, r] of table)
    while (n >= v) {
      out += r;
      n -= v;
    }
  return out;
}

/** The default profile (every built-in pack), shared by extractors created without one. */
let defaultProfile: LegalProfile | undefined;
export function defaultLegalProfile(): LegalProfile {
  defaultProfile ??= new LegalProfile();
  return defaultProfile;
}
