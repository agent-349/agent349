import { ReferenceExtractor } from './ReferenceExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** How one document affects another. */
export type RelationType = 'derogates' | 'modifies' | 'regulates';

/** A relation found in a document's text: this document `type`s the `target`. */
export interface ExtractedRelation {
  type: RelationType;
  /** Reference key of the affected document (`decree:732/19`). */
  target: string;
  /** The reference as written (`Decreto N° 732/019`). */
  label: string;
  /** `'total'` or `'partial'` (articles, or "parcialmente"). Modifications are partial. */
  scope: 'total' | 'partial';
  /** Articles affected, when the text names them (`['5', '7']`). */
  articles?: string[];
  /**
   * `'explicit'`: the sentence opens with the operative verb and names a
   * single document ("Derógase el Decreto N° 732/019"). `'inferred'`: any
   * other match — several documents, or the verb in the middle of the sentence.
   */
  strength: 'explicit' | 'inferred';
  /** The sentence that states the relation (up to 300 characters). */
  evidence: string;
}

/** A custom relation verb pattern. */
export interface RelationPattern {
  type: RelationType;
  /** Regular expression matching the operative verb, e.g. `'\\bwird aufgehoben\\b'`. Case-insensitive. */
  pattern: string;
}

/** Options of {@link RelationExtractor}. */
export interface RelationExtractorOptions {
  /** Extractor of the references the relations point to. Default: built-in patterns. */
  references?: ReferenceExtractor;
  /** Use the built-in verbs (es/en/pt). Default: true. */
  builtin?: boolean;
  /** Additional verbs. */
  patterns?: RelationPattern[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in verbs: operative forms only (imperative / present / "queda …"), so
// that narratives in the past ("el Decreto X derogó…") are not taken as the
// document's own relations.
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN: { type: RelationType; re: string }[] = [
  {
    type: 'derogates',
    re: [
      String.raw`der[oó]g(?:a|an)se`,
      String.raw`se\s+der[oó]ga(?:n)?`,
      String.raw`qu[eé]da(?:n)?\s+derogad[oa]s?`,
      String.raw`d[eé]ja(?:n)?se\s+sin\s+efecto`,
      String.raw`se\s+deja(?:n)?\s+sin\s+efecto`,
      String.raw`abr[oó]g(?:a|an)se`,
      String.raw`(?:is|are)\s+(?:hereby\s+)?(?:repealed|revoked|rescinded)`,
      String.raw`hereby\s+(?:repeals?|revokes?)`,
      String.raw`revoga(?:m)?-se`,
      String.raw`fica(?:m)?\s+revogad[oa]s?`,
    ].join('|'),
  },
  {
    type: 'modifies',
    re: [
      String.raw`modif[ií]ca(?:n)?se`,
      String.raw`se\s+modifica(?:n)?`,
      String.raw`sustit[uú]ye(?:n)?se`,
      String.raw`se\s+sustituye(?:n)?`,
      String.raw`reempl[aá]za(?:n)?se`,
      String.raw`agr[eé]ga(?:n)?se`,
      String.raw`incorp[oó]ra(?:n)?se`,
      String.raw`qu[eé]da(?:n)?\s+(?:redactad|modificad)[oa]s?`,
      String.raw`(?:is|are)\s+(?:hereby\s+)?(?:amended|replaced)`,
      String.raw`hereby\s+amends?`,
      String.raw`altera(?:m)?-se`,
      String.raw`fica(?:m)?\s+alterad[oa]s?`,
      String.raw`substitui-se`,
    ].join('|'),
  },
  {
    type: 'regulates',
    re: [
      String.raw`regl[aá]m[eé]nta(?:n)?se`,
      String.raw`se\s+reglamenta(?:n)?`,
      String.raw`hereby\s+(?:implements|regulates)`,
      String.raw`regulamenta(?:m)?-se`,
      String.raw`fica(?:m)?\s+regulamentad[oa]s?`,
    ].join('|'),
  },
];

/** Sentence boundaries; abbreviations used before numbers ("N°.", "Nro.", "art.") do not end a sentence. */
const SENTENCE =
  /(?<!\b(?:[Nn]ro|[Nn]o|[Nn]|[Aa]rts?|[Ii]nc|[Ll]it|[Nn][uú]m|[Nn]º|[Nn]°))\.\s+(?=[A-ZÁÉÍÓÚÑ"“(])|;\s+|\n+/u;

/** "artículo 5", "arts. 5 y 7", "article 3", "artigos 2 e 4". */
const ARTICLES =
  /\b(?:art[ií]culos?|arts?\.|articles?|artigos?)\s+((?:\d{1,4}[°º]?(?:\s*(?:,|y|e|and|to|al|a)\s*)?)+)/iu;

/** "Artículo 3°.-", "Art. 2:" at the start of a sentence. */
const ARTICLE_HEADING =
  /^\s*(?:art[ií]culo|art\.?|article|artigo)\s*\d{1,4}\s*[°º]?\s*[.\-–—:)]*\s*/iu;

/** "parcialmente", "partially", "parcialmente" (pt). */
const PARTIAL = /\b(?:parcialmente|partially|in\s+part)\b/iu;

// ─────────────────────────────────────────────────────────────────────────────
// RelationExtractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds what a document does to others: repeals (`derogates`), amends
 * (`modifies`) or regulates (`regulates`) them, from the operative wording of
 * legal and administrative texts ("Derógase el Decreto N° 732/019",
 * "Modifícase el artículo 5 del Decreto 654/018", "Law 123 is hereby repealed").
 *
 * The result is a proposal: wording varies, so a host that acts on relations
 * (excluding repealed documents, for instance) should let a person confirm
 * them. Built-in verbs cover Spanish, English and Portuguese.
 */
export class RelationExtractor {
  readonly #references: ReferenceExtractor;
  readonly #verbs: { type: RelationType; re: RegExp }[];

  constructor(options: RelationExtractorOptions = {}) {
    this.#references = options.references ?? new ReferenceExtractor();
    this.#verbs = [
      ...(options.builtin === false ? [] : BUILTIN),
      ...(options.patterns ?? []).map((p) => ({ type: p.type, re: p.pattern })),
    ].map((v) => ({ type: v.type, re: new RegExp(`(?:${v.re})`, 'iu') }));
  }

  /**
   * The relations stated in `text`, one per type and target (an explicit
   * statement wins over an inferred one; articles are merged).
   *
   * @param text - Document text.
   */
  extract(text: string): ExtractedRelation[] {
    const found = new Map<string, ExtractedRelation>();
    for (const raw of text.split(SENTENCE)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
      if (sentence.length < 8) continue;
      for (const { type, re } of this.#verbs) {
        const verb = re.exec(sentence);
        if (verb === null) continue;
        const opening = sentence.replace(ARTICLE_HEADING, '');
        let after = sentence.slice(verb.index + verb[0].length);
        let refs = this.#references.extract(after);
        let explicit = refs.length === 1 && opening.toLowerCase().startsWith(verb[0].toLowerCase());
        if (refs.length === 0) {
          // Passive voice: "El Decreto 732/019 queda derogado", "Law 123 is hereby repealed".
          after = sentence.slice(0, verb.index);
          refs = this.#references.extract(after);
          if (refs.length === 0) continue;
          const subject = opening
            .replace(/^(?:el|la|los|las|the|o|a|os|as)\s+/iu, '')
            .toLowerCase();
          explicit = refs.length === 1 && subject.startsWith(refs[0]!.label.toLowerCase());
        }
        // Articles named before the first reference belong to it.
        const firstRefAt = after.search(escapeRe(refs[0]!.label));
        const head = firstRefAt >= 0 ? after.slice(0, firstRefAt) : '';
        const art = ARTICLES.exec(head);
        const articles = art !== null ? (art[1]!.match(/\d{1,4}/g) ?? []) : [];
        refs.forEach((ref, i) => {
          const own = i === 0 ? articles : [];
          const partial = type === 'modifies' || own.length > 0 || PARTIAL.test(sentence);
          const rel: ExtractedRelation = {
            type,
            target: ref.key,
            label: ref.label,
            scope: partial ? 'partial' : 'total',
            ...(own.length > 0 && { articles: own }),
            strength: explicit ? 'explicit' : 'inferred',
            evidence: sentence.slice(0, 300),
          };
          const key = `${type}|${ref.key}`;
          const prev = found.get(key);
          found.set(key, prev === undefined ? rel : merge(prev, rel));
        });
        break; // one relation type per sentence: the first operative verb
      }
    }
    return [...found.values()];
  }
}

function merge(a: ExtractedRelation, b: ExtractedRelation): ExtractedRelation {
  const best = a.strength === 'explicit' || b.strength !== 'explicit' ? a : b;
  const articles = [...new Set([...(a.articles ?? []), ...(b.articles ?? [])])];
  // A total repeal anywhere in the text wins over partial ones.
  const scope = a.scope === 'total' || b.scope === 'total' ? 'total' : 'partial';
  const out: ExtractedRelation = { ...best, scope };
  if (articles.length > 0 && scope === 'partial') out.articles = articles;
  else delete out.articles;
  return out;
}

function escapeRe(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'iu');
}
