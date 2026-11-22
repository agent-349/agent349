import { ReferenceExtractor } from './ReferenceExtractor.js';
import { LegalProfile, defaultLegalProfile } from '../legal/LegalProfile.js';

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

/** Options of {@link RelationExtractor}. */
export interface RelationExtractorOptions {
  /** Legal language profile (`rag.legal`): verbs, partial words, article words. Default: every built-in pack. */
  profile?: LegalProfile;
  /** Extractor of the references the relations point to. Default: one over the same profile. */
  references?: ReferenceExtractor;
}

/** Sentence boundaries; abbreviations used before numbers ("N°.", "Nro.", "art.", "Sec.", "Abs.") do not end a sentence. */
const SENTENCE =
  /(?<!\b(?:[Nn]ro|[Nn]o|[Nn]r|[Nn]|[Aa]rtt?s?|[Ii]nc|[Ll]it|[Nn][uú]m|[Nn]º|[Nn]°|[Ss]ecs?|[Aa]bs|[Pp]ub|[Ll]|[Cc]f|[Pp]ar|[Pp]ara))\.\s+(?=[\p{Lu}"“(])|;\s+|\n+/u;

/** Articles of the passive subject ("El Decreto…", "Law…", "Le décret…", "Il decreto…", "Das Gesetz…"). */
const SUBJECT_ARTICLE = /^(?:el|la|los|las|the|o|a|os|as|le|les|l'|il|lo|gli|der|die|das)\s*/iu;

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
 * them. Verbs come from the legal language profile (`rag.legal`): built-in
 * packs for Spanish, Portuguese, English, French, Italian and German, plus
 * the installation's own (`rag.legal.relations`).
 */
export class RelationExtractor {
  readonly #references: ReferenceExtractor;
  readonly #profile: LegalProfile;
  readonly #heading: RegExp;

  constructor(options: RelationExtractorOptions = {}) {
    this.#profile = options.profile ?? options.references?.profile ?? defaultLegalProfile();
    this.#references = options.references ?? new ReferenceExtractor({ profile: this.#profile });
    // "Artículo 3°.-", "Art. 2:", "§ 4", "Section 5." at the start of a sentence.
    this.#heading = new RegExp(
      String.raw`^\s*(?:(?:${this.#profile.structure.article})\s*|§\s*)\d{1,4}[a-z]?\s*[°º]?\s*[.\-–—:)]*\s*`,
      'iu',
    );
  }

  /** The sentence without its article heading ("Art. 4º O art. 5º…" → "O art. 5º…"); "Section 5 of the Act…" has none. */
  #stripHeading(sentence: string): string {
    const m = this.#heading.exec(sentence);
    if (m === null) return sentence;
    const rest = sentence.slice(m[0].length);
    return /^\p{Ll}/u.test(rest) ? sentence : rest;
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
      for (const { type, re } of this.#profile.relationVerbs) {
        // The verb and its document are read without the article heading
        // ("Art. 4º O art. 5º da Lei…": the article affected is the 5th).
        const opening = this.#stripHeading(sentence);
        const verb = re.exec(opening);
        if (verb === null) continue;
        let after = opening.slice(verb.index + verb[0].length);
        let refs = this.#references.extract(after);
        let explicit = refs.length === 1 && verb.index === 0;
        if (refs.length === 0) {
          // Passive voice: "El Decreto 732/019 queda derogado", "Law 123 is hereby repealed".
          after = opening.slice(0, verb.index);
          refs = this.#references.extract(after);
          if (refs.length === 0) continue;
          const subject = opening.replace(SUBJECT_ARTICLE, '').toLowerCase();
          explicit = refs.length === 1 && subject.startsWith(refs[0]!.label.toLowerCase());
        }
        // Articles named before the first reference belong to it.
        const firstRefAt = after.search(escapeRe(refs[0]!.label));
        const head = firstRefAt >= 0 ? after.slice(0, firstRefAt) : '';
        const art = this.#profile.articleRef.exec(head);
        const articles = art !== null ? (art[1]!.match(/\d{1,4}[a-z]?(?:\.\d{1,3})*/g) ?? []) : [];
        refs.forEach((ref, i) => {
          const own = i === 0 ? articles : [];
          const partial =
            type === 'modifies' || own.length > 0 || this.#profile.partial.test(sentence);
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
