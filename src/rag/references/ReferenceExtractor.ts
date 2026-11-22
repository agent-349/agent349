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
    return [...found.values()]
      .sort((a, b) => a.at - b.at)
      .map(({ key, label, count }) => ({ key, label, count }));
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
   * The identity keys of a document: the references in its title (e.g.
   * "2 - ANEXO II - Decreto 120-15.pdf" → `annex:2`, `decree:120/2015`). When
   * the title has none: with `rag.legal.numberedTitles`, a numbered annex
   * title ("30 - ANEXO - …") gives `annex:30`; otherwise the beginning of its
   * text (its heading) is used.
   *
   * @param title - Document title or file name.
   * @param text  - Optional document text; only its first 300 characters are read.
   */
  identify(title: string, text?: string): string[] {
    const clean = title.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
    const fromTitle = this.extract(clean);
    if (fromTitle.length > 0) return fromTitle.map((r) => r.key);
    if (this.profile.numberedTitles) {
      const numbered = new RegExp(
        String.raw`^\s*(\d{1,4})\s*[a-z]?\s*[-–—.]\s*(?:${this.profile.annexWords})(?![\p{L}])`,
        'iu',
      ).exec(clean);
      if (numbered !== null) return [`annex:${Number(numbered[1])}`];
    }
    if (text === undefined) return [];
    return this.extract(text.slice(0, 300)).map((r) => r.key);
  }
}
