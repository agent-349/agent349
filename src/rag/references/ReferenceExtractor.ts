import { LegalProfile, defaultLegalProfile, fromRoman } from '../legal/LegalProfile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options of {@link ReferenceExtractor}. */
export interface ReferenceExtractorOptions {
  /** Legal language profile (`rag.legal`). Default: every built-in pack. */
  profile?: LegalProfile;
}

/** A reference found in a text. */
export interface ExtractedReference {
  /** Normalised key: `<kind>:<identifier>`, e.g. `annex:14`, `law:12345`, `decree:120/2015`. */
  key: string;
  /** The text as written in the first occurrence, e.g. `Anexo XIV`. */
  label: string;
  /** Occurrences in the text. */
  count: number;
}

/** Where an identity of a document comes from. */
export type IdentitySource = 'title' | 'header';

/** The identity of a document, from its title and the heading of its text. */
export interface DocumentIdentity {
  /** Identity keys, title first. */
  keys: string[];
  /** Each key with its label and source. */
  identities: { key: string; label: string; source: IdentitySource }[];
  /**
   * The heading names another document of a kind the title already gives
   * ("Decreto 120/2015" in the title, "Decreto 200/2016" in the heading). The
   * title wins; the heading's key is reported here for review.
   */
  conflicts: { title: string; header: string; headerLabel: string }[];
}

/** Options of {@link ReferenceExtractor.identifyDocument}. */
export interface IdentifyDocumentOptions {
  /** Read the heading of the text. Default: `rag.legal.identity.header` (true). */
  header?: boolean;
}

/** Characters and non-empty lines of the beginning of a text searched for the document's own designation. */
const HEADING_CHARS = 1500;
const HEADING_LINES = 30;

// ─────────────────────────────────────────────────────────────────────────────
// ReferenceExtractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds references to other documents in a text ("Anexo XIV", "Ley 12.345",
 * "Decreto 120/15", "Regulation (EU) 2016/679", "12 U.S.C. § 1831") and
 * normalises them to keys (`annex:14`, `law:12345`, `decree:120/2015`,
 * `regulation:679/2016`, `usc:12-1831`), so that different spellings of the
 * same reference match. The same keys identify a document from its title
 * ({@link identify}).
 *
 * The kinds and the words that name them come from the legal language
 * profile: built-in packs for Spanish, Portuguese, English, French, Italian
 * and German, plus the installation's own (`rag.legal.references`).
 */
export class ReferenceExtractor {
  readonly profile: LegalProfile;

  constructor(options: ReferenceExtractorOptions = {}) {
    this.profile = options.profile ?? defaultLegalProfile();
  }

  /**
   * The references in `text`, in order of first appearance, with their counts.
   *
   * @param text - Any text (a passage, a whole document).
   */
  extract(text: string): ExtractedReference[] {
    return this.#scan(text).map(({ key, label, count }) => ({ key, label, count }));
  }

  /** References with the position of their first occurrence, in order. */
  #scan(text: string): (ExtractedReference & { at: number })[] {
    const found = new Map<string, ExtractedReference & { at: number }>();
    const taken: [number, number][] = [];
    for (const ref of this.profile.references) {
      ref.re.lastIndex = 0;
      for (const m of text.matchAll(ref.re)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        // A span already read as another kind ("Decreto-Lei 41/2019" is not also a "Lei").
        if (taken.some(([a, b]) => at < b && end > a)) continue;
        const id = this.#identifier(ref, m);
        if (id === undefined || id === '') continue;
        taken.push([at, end]);
        const key = `${ref.kind}:${id}`;
        const hit = found.get(key);
        if (hit !== undefined) hit.count++;
        else found.set(key, { key, label: m[0].replace(/\s+/g, ' ').trim(), count: 1, at });
      }
    }
    return [...found.values()].sort((a, b) => a.at - b.at);
  }

  #identifier(ref: LegalProfile['references'][number], m: RegExpMatchArray): string | undefined {
    if (ref.id === 'roman') {
      const raw = (m[1] ?? '').trim();
      if (/^\d+$/.test(raw)) return String(Number(raw));
      const n = fromRoman(raw);
      return n !== undefined ? String(n) : undefined;
    }
    if (ref.id === 'number') {
      const raw = (m[4] ?? '').trim();
      // "Companies Act 2006": the year belongs to the title.
      if (ref.titleYear !== undefined && /^\d{4}$/.test(raw) && ref.titleYear.test(m[0])) {
        return undefined;
      }
      const yearFirst = m[3] !== undefined || m[5] !== undefined;
      return this.profile.normaliseNumber(raw, yearFirst, ref.order, m[2]);
    }
    // Citation: the capture groups joined ("12 U.S.C. § 1831" → 12-1831).
    const groups = m.slice(1).filter((g): g is string => g !== undefined && g !== '');
    if (groups.length === 0) return undefined;
    if (ref.yearFirst === true && groups.length === 2) {
      return `${Number(groups[1])}/${this.profile.year(groups[0]!)}`;
    }
    return groups.map((g) => g.toLowerCase().replace(/\s+/g, '')).join('-');
  }

  /**
   * The document's own designation, read from the beginning of its text: the
   * first reference that opens a heading line ("DECRETO N° 120/015", "Real
   * Decreto 123/2020, de 5 de junio…", "Décret n° 2004-374 du…"), before the
   * preamble ("VISTO", "CONSIDERANDO", "WHEREAS", "Vu"…) and the first
   * article. References inside a line, or after the preamble, are citations
   * of other norms and are ignored. When a heading line names an annex, the
   * document is that annex (its other heading lines name the norm it belongs
   * to), so only the annex is returned.
   *
   * @param text - Document text (only its beginning is read).
   * @returns At most one designation.
   */
  selfDesignation(text: string): { key: string; label: string }[] {
    const lines = text.slice(0, HEADING_CHARS).split(/\r?\n/);
    const found: { key: string; label: string }[] = [];
    let seen = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '') continue;
      if (++seen > HEADING_LINES) break;
      if (this.profile.preamble.test(line) || this.profile.articleLine.test(line)) break;
      const lead = /^[^\p{L}\d§]*/u.exec(line)![0].length;
      const first = this.#scan(line)[0];
      if (first !== undefined && first.at <= lead)
        found.push({ key: first.key, label: first.label });
    }
    const annex = found.find((f) => f.key.startsWith('annex:'));
    if (annex !== undefined) return [annex];
    return found.slice(0, 1);
  }

  /**
   * The identity of a document. The title (or file name) comes first: its
   * references ("2 - ANEXO II - Decreto 120-15.pdf" → `annex:2`,
   * `decree:120/2015`), or, with `rag.legal.numberedTitles`, a numbered
   * annex title ("30 - ANEXO - …" → `annex:30`). Then the heading of the
   * text ({@link selfDesignation}), unless `rag.legal.identity.header` is
   * false: it adds a kind the title does not give; for a kind the title
   * already gives with another identifier, the title wins and the
   * disagreement is reported in `conflicts`.
   *
   * @param title - Document title or file name.
   * @param text  - Optional document text; only its beginning is read.
   */
  identifyDocument(
    title: string,
    text?: string,
    options: IdentifyDocumentOptions = {},
  ): DocumentIdentity {
    const identities: DocumentIdentity['identities'] = this.#fromTitle(title).map((r) => ({
      ...r,
      source: 'title' as const,
    }));
    const conflicts: DocumentIdentity['conflicts'] = [];
    const header = options.header ?? this.profile.identityFromHeader;
    if (header && text !== undefined && text !== '') {
      const kind = (key: string): string => key.slice(0, key.indexOf(':'));
      for (const h of this.selfDesignation(text)) {
        if (identities.some((i) => i.key === h.key)) continue;
        const same = identities.find((i) => kind(i.key) === kind(h.key));
        if (same !== undefined) {
          conflicts.push({ title: same.key, header: h.key, headerLabel: h.label });
          continue;
        }
        identities.push({ ...h, source: 'header' });
      }
    }
    return { keys: identities.map((i) => i.key), identities, conflicts };
  }

  /**
   * The identity keys of a document ({@link identifyDocument}, keys only).
   *
   * @param title - Document title or file name.
   * @param text  - Optional document text; only its beginning is read.
   */
  identify(title: string, text?: string): string[] {
    return this.identifyDocument(title, text).keys;
  }

  #fromTitle(title: string): { key: string; label: string }[] {
    const clean = title.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
    const refs = this.extract(clean);
    if (refs.length > 0) return refs.map(({ key, label }) => ({ key, label }));
    if (this.profile.numberedTitles) {
      const numbered = new RegExp(
        String.raw`^\s*(\d{1,4})\s*[a-z]?\s*[-–—.]\s*(?:${this.profile.annexWords})(?![\p{L}])`,
        'iu',
      ).exec(clean);
      if (numbered !== null)
        return [{ key: `annex:${Number(numbered[1])}`, label: numbered[0].trim() }];
    }
    return [];
  }
}
