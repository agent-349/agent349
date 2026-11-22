// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A custom reference pattern. */
export interface ReferencePattern {
  /** Kind of document the reference points to (`annex`, `law`, `policy`…): the key prefix. */
  kind: string;
  /**
   * Regular expression with one capture group for the identifier, e.g.
   * `'\\bPolicy\\s+([A-Z]{2}-\\d+)'`. Matched case-insensitively.
   */
  pattern: string;
}

/** Options of {@link ReferenceExtractor}. */
export interface ReferenceExtractorOptions {
  /** Use the built-in patterns (annexes, laws, decrees, circulars, resolutions in es/en/pt). Default: true. */
  builtin?: boolean;
  /** Additional patterns. */
  patterns?: ReferencePattern[];
  /**
   * Heuristic for {@link ReferenceExtractor.identify}: a title that starts with
   * a number followed by the word annex/appendix and no identifier of its own
   * ("30 - ANEXO - Formularios") identifies `annex:30`. Useful for collections whose
   * annexes are numbered in the file name; off by default.
   */
  numberedTitles?: boolean;
}

/** A reference found in a text. */
export interface ExtractedReference {
  /** Normalised key: `<kind>:<identifier>`, e.g. `annex:14`, `law:12345`, `decree:120/15`. */
  key: string;
  /** The text as written in the first occurrence, e.g. `Anexo XIV`. */
  label: string;
  /** Occurrences in the text. */
  count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in patterns
// ─────────────────────────────────────────────────────────────────────────────

/** Optional "number" marker between the word and the identifier: N°, Nº, No., nro., n.º, #. */
const NUM = String.raw`(?:(?:N|n)(?:[°º]|o\.?|ro\.?|\.º)\s*|#\s*)?`;
/** A Roman numeral (validated later) or an Arabic number, optionally followed by a letter ("XIV A"). */
const ANNEX_ID = String.raw`([IVXLCDM]{1,8}|\d{1,4})`;
/** Law number: 12345, 12.345, 12,345. */
const LAW_ID = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d{2,6})`;
/** Decree / resolution: 120/15, 120-15, 120/015, 120/2015, or a bare number. */
const DECREE_ID = String.raw`(\d{1,5}(?:\s*[/-]\s*\d{2,4})?)`;

const BUILTIN: { kind: string; re: RegExp; id: 'roman' | 'law' | 'decree' | 'plain' }[] = [
  {
    kind: 'annex',
    re: new RegExp(
      String.raw`\b(?:anexos?|annex(?:es)?|appendix|appendices|ap[ée]ndices?|apêndices?)\s+${NUM}${ANNEX_ID}\b`,
      'giu',
    ),
    id: 'roman',
  },
  {
    kind: 'law',
    re: new RegExp(String.raw`(?<!-)\b(?:ley|law|lei)\s+${NUM}${LAW_ID}\b`, 'giu'),
    id: 'law',
  },
  {
    kind: 'decree',
    re: new RegExp(String.raw`\b(?:decretos?|decree|decreto-lei)\s+${NUM}${DECREE_ID}`, 'giu'),
    id: 'decree',
  },
  {
    kind: 'circular',
    re: new RegExp(String.raw`\bcircular(?:es)?\s+${NUM}${LAW_ID}\b`, 'giu'),
    id: 'law',
  },
  {
    kind: 'resolution',
    re: new RegExp(
      String.raw`\b(?:resoluci[óo]n|resolution|resolução)\s+${NUM}${DECREE_ID}`,
      'giu',
    ),
    id: 'decree',
  },
];

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** Arabic value of a canonical Roman numeral, or undefined when it is not one ("IIII", "VX"). */
function fromRoman(text: string): number | undefined {
  const s = text.toUpperCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]!];
    const next = ROMAN[s[i + 1] ?? ''] ?? 0;
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

/** Normalised identifier, or undefined when the match is not a valid reference. */
function normaliseId(raw: string, mode: 'roman' | 'law' | 'decree' | 'plain'): string | undefined {
  const id = raw.trim();
  switch (mode) {
    case 'roman': {
      if (/^\d+$/.test(id)) return String(Number(id));
      const n = fromRoman(id);
      return n !== undefined ? String(n) : undefined;
    }
    case 'law':
      return id.replace(/[.,]/g, '');
    case 'decree': {
      const m = /^(\d+)\s*(?:[/-]\s*(\d{2,4}))?$/.exec(id);
      if (m === null) return undefined;
      const num = String(Number(m[1]));
      if (m[2] === undefined) return num;
      // 120/15, 120/015, 120/2015 → 120/15
      return `${num}/${m[2].slice(-2)}`;
    }
    default:
      return id.toLowerCase();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ReferenceExtractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds references to other documents in a text ("Anexo XIV", "Ley 12.345",
 * "Decreto 120/15") and normalises them to keys (`annex:14`, `law:12345`,
 * `decree:120/15`), so that "Anexo XIV", "anexo 14" and "Anexo N° 14" match.
 * The same keys identify a document from its title ({@link identify}).
 *
 * Built-in patterns cover annexes/appendices, laws, decrees, circulars and
 * resolutions in Spanish, English and Portuguese; installations add their own.
 */
export class ReferenceExtractor {
  readonly #patterns: { kind: string; re: RegExp; id: 'roman' | 'law' | 'decree' | 'plain' }[];
  readonly #numberedTitles: boolean;

  constructor(options: ReferenceExtractorOptions = {}) {
    this.#numberedTitles = options.numberedTitles === true;
    this.#patterns = [
      ...(options.builtin === false ? [] : BUILTIN),
      ...(options.patterns ?? []).map((p) => ({
        kind: p.kind,
        re: new RegExp(p.pattern, 'giu'),
        id: 'plain' as const,
      })),
    ];
  }

  /**
   * The references in `text`, in order of first appearance, with their counts.
   *
   * @param text - Any text (a passage, a whole document).
   */
  extract(text: string): ExtractedReference[] {
    const found = new Map<string, ExtractedReference & { at: number }>();
    for (const { kind, re, id } of this.#patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const norm = normaliseId(m[1] ?? '', id);
        if (norm === undefined || norm === '') continue;
        const key = `${kind}:${norm}`;
        const hit = found.get(key);
        if (hit !== undefined) hit.count++;
        else
          found.set(key, {
            key,
            label: m[0].replace(/\s+/g, ' ').trim(),
            count: 1,
            at: m.index ?? 0,
          });
      }
    }
    return [...found.values()]
      .sort((a, b) => a.at - b.at)
      .map(({ key, label, count }) => ({ key, label, count }));
  }

  /**
   * The identity keys of a document: the references in its title (e.g.
   * "2 - ANEXO II - Decreto 120-15.pdf" → `annex:2`, `decree:120/15`). When
   * the title has none: with `numberedTitles`, a numbered annex title
   * ("30 - ANEXO - Formularios") gives `annex:30`; otherwise the beginning of its
   * text (its heading) is used.
   *
   * @param title - Document title or file name.
   * @param text  - Optional document text; only its first 300 characters are read.
   */
  identify(title: string, text?: string): string[] {
    const clean = title.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
    const fromTitle = this.extract(clean);
    if (fromTitle.length > 0) return fromTitle.map((r) => r.key);
    // "30 - ANEXO - Formularios": a numbered title whose annex has no identifier of its own.
    const numbered =
      this.#numberedTitles &&
      /^\s*(\d{1,4})\s*[a-z]?\s*[-–—.]\s*(?:anexo|annex|appendix|ap[ée]ndice|apêndice)\b/iu.exec(
        clean,
      );
    if (numbered !== false && numbered !== null) return [`annex:${Number(numbered[1])}`];
    if (text === undefined) return [];
    return this.extract(text.slice(0, 300)).map((r) => r.key);
  }
}
