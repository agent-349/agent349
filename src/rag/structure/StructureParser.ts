import type { ChunkSection } from '../../types/index.js';
import { LegalProfile, defaultLegalProfile } from '../legal/LegalProfile.js';
import { ReferenceExtractor } from '../references/ReferenceExtractor.js';

export type { ChunkSection };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A structural unit of a document. */
export interface DocumentSection {
  /**
   * `article` — the unit of citation and amendment (Artículo, Artigo, Article,
   * Section, §, Articolo, Artikel…); `paragraph` — a part of an article
   * ("§ 1º" and "Parágrafo único" in Brazilian drafting); `section` — a
   * numbered part of a manual or procedure ("3.4.6", "IV.3.4"); `chapter` —
   * a grouping heading (chapter, title, part, book).
   */
  kind: 'article' | 'paragraph' | 'section' | 'chapter';
  /** Normalised identifier: `12.2`, `5a`, `57 bis` (article), `3.4.6` / `IV.3.4` (section), `II` (chapter), `5§2` (paragraph 2 of article 5). */
  id: string;
  /** The heading line as written (up to 120 characters). */
  label: string;
  /** Character offset where the heading starts. */
  start: number;
  /** The heading says the unit was repealed ("Artículo 70 (DEROGADO)", "[Repealed]"). */
  derogated?: boolean;
  /** The text that gave the article its current wording ("(Redacción dada por …)", or a closing source line). */
  amendedBy?: string;
}

/** An internal reference: a pointer to another unit of the same document. */
export interface InternalReference {
  /** What it names: an article, a numbered section, a paragraph, a "§" (article or paragraph by context), or the previous / next article. */
  unit: 'article' | 'section' | 'paragraph' | 'sign' | 'previous' | 'next';
  /** The identifier as normalised (empty for previous / next). */
  id: string;
  /** As written ("ver punto 4.2", "conforme o § 2º", "el artículo anterior"). */
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic patterns (language-neutral)
// ─────────────────────────────────────────────────────────────────────────────

/** Numbered section at the start of a line with at least two levels: "3.4.6 Autorización", "4.2. Envíos". */
const SECTION = /^[ \t]*(\d{1,2}(?:\.\d{1,3}){1,4})\.?[ \t]+(?=[\p{Lu}"“(])[^\n]*/gmu;

/** Roman-numbered section: "IV.3.4 Uniformes", "IV. DISPOSICIONES GENERALES", "II - Ámbito". */
const ROMAN_SECTION =
  /^[ \t]*([IVXLC]{1,6}(?:\.\d{1,3}){0,4})(?:\.|[ \t]*[-–—])[ \t]*(?=[\p{Lu}"“(])[^\n]*/gmu;

/** Table-of-contents entry: dot leaders, or a title ending in a page number. */
const TOC_LINE = /(?:\.{4,}|…{2,}|·{3,}|_{4,})|\s\d{1,3}\s*$/u;
const LEADERS = /\.{4,}|…{2,}|·{3,}|_{4,}/u;

/** Upper-case letters of any Latin script, for the "starts like a title" lookahead. */
const TITLE_START = String.raw`[(.\-–—:)\]]|\p{Lu}|$`;

/** Arabic ids lose leading zeros; Roman ids are upper-cased; letters stay lower-case. */
function normaliseId(raw: string): string {
  return raw
    .split('.')
    .map((p) => {
      const m = /^(\d+)([a-z]?)$/i.exec(p);
      if (m !== null) return String(Number(m[1])) + m[2]!.toLowerCase();
      return p.toUpperCase();
    })
    .join('.');
}

const strip = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// StructureParser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the structure of legal and administrative documents — articles,
 * paragraphs, numbered sections, chapters — so each chunk can say which
 * units it covers, relations can apply to the articles they name, and
 * internal references ("ver punto 4.2", "conforme o § 2º", "see section 5")
 * can be followed. Headings are recognised at the start of a line with the
 * words of the legal language profile (`rag.legal`).
 */
export class StructureParser {
  readonly profile: LegalProfile;
  readonly #article: RegExp;
  readonly #sign: RegExp;
  readonly #paragraph: RegExp;
  readonly #division: RegExp;
  readonly #internal: RegExp;
  readonly #relative: RegExp;
  readonly #references: ReferenceExtractor;
  readonly #soleOrFirst: RegExp;

  constructor(profile: LegalProfile = defaultLegalProfile()) {
    this.profile = profile;
    const s = profile.structure;
    // A letter that is not an ordinal indicator (º and ª are letters in Unicode).
    const L = String.raw`(?:(?![ºª])\p{L})`;
    const num = String.raw`(\d{1,4}(?:\.\d{1,3}){0,3}(?:[a-np-z](?!${L}))?)(?:[ \t]*(?:ro|do|er|ero|re|to|vo|no|mo)(?!${L}))?|(${s.sole}|${s.first})`;
    const suffix = String.raw`[ \t]*[-–]?[ \t]*(bis|ter|quater|quinquies|sexies)?(?!${L})[ \t]*[°ºª*%]?`;
    // A heading is followed by punctuation, a title in capitals or the end of
    // the line; "Artículo 302 del Código" (a citation) is not.
    this.#article = new RegExp(
      String.raw`^[ \t]*(?:${s.article})[ \t]*(?:n[°º.]?[ \t]*)?(?:${num})${suffix}(?=[ \t]*(?:${TITLE_START}))([^\n]*)`,
      'gimu',
    );
    this.#sign = new RegExp(
      String.raw`^[ \t]*§[ \t]*(\d{1,4}(?:\.\d{1,3}){0,3}[a-z]?)${suffix}(?=[ \t]*(?:${TITLE_START}))([^\n]*)`,
      'gimu',
    );
    this.#paragraph = new RegExp(
      String.raw`^[ \t]*(?:${s.paragraph})[ \t]+(?:(\d{1,3})[ \t]*[°ºª]?|(${s.sole}))(?=[ \t]*(?:${TITLE_START}))([^\n]*)`,
      'gimu',
    );
    this.#division = new RegExp(
      String.raw`^[ \t]*(?:${s.division})[ \t]+([IVXLC]{1,6}|\d{1,3})(?![\p{L}\d])([^\n]*)`,
      'gimu',
    );
    const unit = String.raw`(?:${profile.articleRefWords()})|(?:${s.unitWords})|(?:${s.paragraph})`;
    const det = String.raw`(?:(?:el|la|lo|al|los|las|the|o|a|os|as|le|les|l'|il|lo|gli|der|die|das|dem|den)[ \t]+)?`;
    this.#internal = new RegExp(
      String.raw`(?<![\p{L}])(?:${s.internal})[ \t]+${det}(${unit}|§)[ \t]*(\d{1,4}(?:\.\d{1,3}){0,4}[a-z]?|[IVXLC]{1,6}(?:\.\d{1,3}){1,4})[ \t]*[°º]?(?![\d.]*[ \t]*(?:${s.external})(?![\p{L}]))`,
      'giu',
    );
    this.#relative = new RegExp(
      String.raw`(?<![\p{L}])(?:${profile.articleRefWords()})[ \t]+(${s.previous}|${s.next})(?![\p{L}])`,
      'giu',
    );
    this.#soleOrFirst = new RegExp(String.raw`^(?:${s.sole}|${s.first})$`, 'iu');
    this.#references = new ReferenceExtractor({ profile });
  }

  /**
   * The units of `text`, in order of appearance.
   *
   * @param text - Document text.
   */
  parse(text: string): DocumentSection[] {
    type Raw = DocumentSection & { sign?: boolean };
    const out: Raw[] = [];
    const add = (
      kind: DocumentSection['kind'],
      re: RegExp,
      id: (m: RegExpMatchArray) => string | undefined,
      accept?: (m: RegExpMatchArray, line: string) => boolean,
      sign = false,
    ): void => {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const line = m[0].trim();
        // "Section 5 of the Act", "Artículo 302 del Código": a citation, not a
        // heading (checked here: under the i flag \p{Lu} also matches lower case).
        if (kind !== 'section' && /^[ \t]*\p{Ll}/u.test(m[m.length - 1] ?? '')) continue;
        if (accept !== undefined && !accept(m, line)) continue;
        const unitId = id(m);
        if (unitId === undefined) continue;
        const wording = this.profile.structure.wording.exec(line);
        out.push({
          kind,
          id: unitId,
          label: line.slice(0, 120),
          start: (m.index ?? 0) + (m[0].length - m[0].trimStart().length),
          ...(this.profile.structure.repealed.test(line) && { derogated: true }),
          ...(wording !== null && { amendedBy: wording[1]!.replace(/\s+/g, ' ').trim() }),
          ...(sign && { sign: true }),
        });
      }
    };
    const withSuffix = (base: string, sfx: string | undefined): string =>
      sfx !== undefined ? `${base} ${sfx.toLowerCase()}` : base;
    add('article', this.#article, (m) =>
      withSuffix(
        m[1] !== undefined ? normaliseId(m[1]) : this.#soleOrFirst.test(m[2] ?? '') ? '1' : '',
        m[3],
      ),
    );
    add('article', this.#sign, (m) => withSuffix(normaliseId(m[1]!), m[2]), undefined, true);
    add('paragraph', this.#paragraph, (m) => (m[1] !== undefined ? String(Number(m[1])) : 'unico'));
    add('section', SECTION, (m) => normaliseId(m[1]!));
    add(
      'section',
      ROMAN_SECTION,
      (m) => normaliseId(m[1]!),
      (m, line) => {
        // A single-level Roman numeral ("IV.") is a section only with a title in
        // capitals ("IV. DISPOSICIONES GENERALES"); "XXXVI - Insumos…" is usually a list item.
        if (m[1]!.includes('.')) return true;
        const title = line.replace(/^[IVXLC]+\s*[.\-–—]\s*/u, '');
        const letters = title.replace(/[^\p{L}]/gu, '');
        const upper = letters.replace(/[^\p{Lu}]/gu, '');
        return letters.length > 0 && upper.length / letters.length >= 0.8;
      },
    );
    add('chapter', this.#division, (m) => normaliseId(m[1]!));
    out.sort((a, b) => a.start - b.start);
    // One unit per line (a Roman section can also be a chapter): keep the first kind.
    const unique = out.filter((s, i) => i === 0 || s.start !== out[i - 1]!.start);

    // A line-start "§" inside an article is a paragraph where a pack drafts
    // that way (Brazil); elsewhere ("§ 5" in a code or a German law) an article.
    let currentArticle: string | undefined;
    for (const s of unique) {
      if (s.kind === 'chapter') currentArticle = undefined;
      else if (s.kind === 'article' && s.sign !== true) currentArticle = s.id;
      else if (
        s.kind === 'article' &&
        s.sign === true &&
        this.profile.structure.signAsParagraph &&
        currentArticle !== undefined &&
        // Paragraphs are numbered with small integers ("§ 1º", "§ 2º");
        // "§ 1026.5" under a section is a unit of its own.
        /^\d{1,2}$/.test(s.id)
      ) {
        s.kind = 'paragraph';
      }
      if (s.kind === 'paragraph') {
        if (currentArticle === undefined) s.kind = 'article';
        else s.id = `${currentArticle}§${s.id.split(' ')[0]}`;
      }
      delete s.sign;
    }

    // Table of contents: an entry with dot leaders, or one ending in a page
    // number whose unit appears again later, is not where the unit starts.
    const last = new Map<string, number>();
    unique.forEach((s, i) => last.set(`${s.kind}:${s.id}`, i));
    const body: DocumentSection[] = unique.filter((s, i) => {
      if (!TOC_LINE.test(s.label)) return true;
      if (LEADERS.test(s.label)) return false;
      return last.get(`${s.kind}:${s.id}`) === i;
    });

    // Source line at the end of each article: a line holding only a norm and
    // its date ("Circular 1234 de 15/03/2021", "(Ley 12.345 de 10/05/2010)").
    body.forEach((s, i) => {
      if (s.kind !== 'article' || s.amendedBy !== undefined || s.derogated === true) return;
      const end = body.slice(i + 1).find((x) => x.kind !== 'paragraph')?.start ?? text.length;
      for (const l of text.slice(s.start, end).split('\n').slice(1)) {
        if (/^\s*(?:antecedentes|history|hist[oó]rico|historique|cronologia|historie)\b/iu.test(l))
          break;
        const source = this.#sourceLine(l);
        if (source !== undefined) {
          s.amendedBy = source;
          break;
        }
      }
    });
    return body;
  }

  /** The norm of a line that names only a norm and its date. */
  #sourceLine(line: string): string | undefined {
    const t = line
      .trim()
      .replace(/^\(/, '')
      .replace(/\)\.?$/, '');
    if (t.length < 4 || t.length > 90) return undefined;
    const refs = this.#references.extract(t);
    if (refs.length !== 1) return undefined;
    const label = refs[0]!.label;
    if (!strip(t).startsWith(strip(label))) return undefined;
    const rest = t.slice(label.length).trim();
    // What follows is its date ("de 15/03/2021", "del 9 de setiembre de 1999", "of 10 May 2010").
    if (rest.length > 40 || rest.split(/\s+/).length > 6) return undefined;
    if (
      rest !== '' &&
      !/^[,(]?\s*(?:de|del|of|from|du|vom|dated|do|da|della|des|em|di)?\s*[\p{L}\d\s/.\-,]*\)?$/u.test(
        rest,
      )
    ) {
      return undefined;
    }
    // A date is required: a bare norm on its own line is usually a running page header.
    if (rest === '' || !/\d/.test(rest)) return undefined;
    return t.replace(/\s+/g, ' ');
  }

  /**
   * What the text range [start, end) covers: the unit it starts in and every
   * unit that begins inside it, the previous and next articles (for "the
   * preceding article"), and the articles repealed or re-worded in it.
   *
   * @param sections - Result of {@link parse} for the whole document.
   */
  cover(sections: DocumentSection[], start: number, end: number): ChunkSection {
    let current: DocumentSection | undefined;
    let currentArticle: DocumentSection | undefined;
    let currentParagraph: DocumentSection | undefined;
    const inside: DocumentSection[] = [];
    for (const s of sections) {
      if (s.start <= start) {
        current = s;
        if (s.kind === 'article') {
          currentArticle = s;
          currentParagraph = undefined;
        } else if (s.kind === 'paragraph') currentParagraph = s;
        else if (s.kind === 'chapter') {
          currentArticle = undefined;
          currentParagraph = undefined;
        }
      } else if (s.start < end) inside.push(s);
      else break;
    }
    const units = [
      ...(currentArticle !== undefined ? [currentArticle] : []),
      ...(currentParagraph !== undefined ? [currentParagraph] : []),
      ...(current !== undefined && current.kind === 'section' ? [current] : []),
      ...inside,
    ];
    const ids = (k: DocumentSection['kind']): string[] => [
      ...new Set(units.filter((u) => u.kind === k).map((u) => u.id)),
    ];
    const articles = ids('article');
    const paragraphs = ids('paragraph');
    const secs = ids('section');
    const arts = units.filter((u) => u.kind === 'article');
    const derogated = [...new Set(arts.filter((u) => u.derogated === true).map((u) => u.id))];
    const amended = arts
      .filter((u) => u.amendedBy !== undefined)
      .map((u) => ({ article: u.id, by: u.amendedBy! }));
    const order = sections.filter((s) => s.kind === 'article').map((s) => s.id);
    const firstAt = articles.length > 0 ? order.indexOf(articles[0]!) : -1;
    const lastAt = articles.length > 0 ? order.lastIndexOf(articles[articles.length - 1]!) : -1;
    const head = currentParagraph ?? current ?? inside[0];
    let label = head?.label;
    if (head?.kind === 'paragraph' && currentArticle !== undefined) {
      label = `${currentArticle.label.slice(0, 60)} · ${head.label.slice(0, 50)}`;
    }
    return {
      ...(articles.length > 0 && { articles }),
      ...(paragraphs.length > 0 && { paragraphs }),
      ...(secs.length > 0 && { sections: secs }),
      ...(label !== undefined && { label }),
      ...(derogated.length > 0 && { derogated }),
      ...(amended.length > 0 && { amended }),
      ...(firstAt > 0 && { prevArticle: order[firstAt - 1]! }),
      ...(lastAt >= 0 && lastAt < order.length - 1 && { nextArticle: order[lastAt + 1]! }),
    };
  }

  /**
   * Internal references in `text` (to units of the same document), in order
   * of appearance. "ver punto 4" (a single level) is too ambiguous for a
   * section and is skipped; a unit followed by another document ("el
   * artículo 8 del Decreto 120/15") is left to the cross-document references.
   */
  internalReferences(text: string): InternalReference[] {
    const out: (InternalReference & { at: number })[] = [];
    const seen = new Set<string>();
    const push = (r: InternalReference, at: number): void => {
      const k = `${r.unit}:${r.id}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ ...r, at });
    };
    const articleWord = new RegExp(`^(?:${this.profile.articleRefWords()})$`, 'iu');
    const paragraphWord = new RegExp(`^(?:${this.profile.structure.paragraph})$`, 'iu');
    this.#internal.lastIndex = 0;
    for (const m of text.matchAll(this.#internal)) {
      const word = m[1]!;
      const id = normaliseId(m[2]!);
      const label = m[0].replace(/\s+/g, ' ').trim();
      let unit: InternalReference['unit'];
      if (word === '§') unit = 'sign';
      else if (paragraphWord.test(word)) unit = 'paragraph';
      else if (articleWord.test(word))
        unit = /^(?:§|sections?|secs?\.)$/iu.test(word) ? 'sign' : 'article';
      else unit = 'section';
      if (unit === 'section' && !id.includes('.')) continue;
      push({ unit, id, label }, m.index ?? 0);
    }
    const previous = new RegExp(`^(?:${this.profile.structure.previous})$`, 'iu');
    this.#relative.lastIndex = 0;
    for (const m of text.matchAll(this.#relative)) {
      push(
        {
          unit: previous.test(m[1]!) ? 'previous' : 'next',
          id: '',
          label: m[0].replace(/\s+/g, ' ').trim(),
        },
        m.index ?? 0,
      );
    }
    return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...r }) => r);
  }

  /**
   * Splits `text` at article, section and chapter headings (not at
   * paragraphs: they stay with their article): segments [start, end) that
   * never cross from one unit to the next.
   */
  segments(text: string, sections: DocumentSection[] = this.parse(text)): [number, number][] {
    const cuts = [
      ...new Set([0, ...sections.filter((s) => s.kind !== 'paragraph').map((s) => s.start)]),
    ].sort((a, b) => a - b);
    const out: [number, number][] = [];
    cuts.forEach((c, i) => {
      const end = cuts[i + 1] ?? text.length;
      if (text.slice(c, end).trim() !== '') out.push([c, end]);
    });
    return out;
  }
}

/**
 * The tag of the unit an internal reference names, from the passage that
 * makes it (a paragraph or "§" resolves against the passage's article; the
 * previous / next article against its position), or undefined when it
 * cannot be resolved.
 */
export function internalReferenceTag(
  ref: InternalReference,
  section: ChunkSection | undefined,
): string | undefined {
  const article = section?.articles?.[0];
  switch (ref.unit) {
    case 'article':
      return `art:${ref.id}`;
    case 'section':
      return `sec:${ref.id}`;
    case 'paragraph':
      return article !== undefined ? `par:${article.split(' ')[0]}§${ref.id}` : undefined;
    case 'sign':
      // A document that drafts paragraphs with "§" (its chunks carry paragraphs) reads it as one.
      if ((section?.paragraphs?.length ?? 0) > 0 && article !== undefined) {
        return `par:${article.split(' ')[0]}§${ref.id}`;
      }
      return `art:${ref.id}`;
    case 'previous':
      return section?.prevArticle !== undefined ? `art:${section.prevArticle}` : undefined;
    case 'next':
      return section?.nextArticle !== undefined ? `art:${section.nextArticle}` : undefined;
  }
}

/** Tags of a chunk's units: `art:<id>`, `par:<article>§<n>` and `sec:<id>` (see {@link ChunkSection}). */
export function sectionTags(section: ChunkSection): string[] {
  return [
    ...(section.articles ?? []).map((a) => `art:${a}`),
    ...(section.paragraphs ?? []).map((p) => `par:${p}`),
    ...(section.sections ?? []).map((s) => `sec:${s}`),
  ];
}
