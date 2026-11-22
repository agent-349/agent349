/**
 * Built-in language packs: how legal and administrative texts write
 * references, relations and structure in each language. Data only — the
 * regular expressions are compiled by `LegalProfile`.
 *
 * Every entry is a regular-expression fragment matched case-insensitively
 * (Unicode). Packs cover the main legal traditions of each language:
 *   es — Spain and Latin America
 *   pt — Brazil and Portugal
 *   en — United States, United Kingdom, European Union, international
 *   fr — France and Belgium; it — Italy; de — Germany and Austria
 * The fr, it and de packs follow the usual conventions of those traditions
 * and should be checked against real documents; installations extend any
 * pack through `rag.legal`.
 */

/** A kind of document a reference can point to, and the words that name it. */
export interface ReferenceKindDef {
  /** Key prefix: `law`, `decree`, `annex`… */
  kind: string;
  /** Words that name it (regex fragments). Longer forms first ("real decreto" before "decreto"). */
  words: string[];
  /** Identifier style: `roman` accepts Roman numerals (annexes); default `number`. */
  id?: 'number' | 'roman';
  /** Order of two-part identifiers, overriding the pack's. */
  order?: 'number/year' | 'year/number';
}

/** A citation with its own format ("12 U.S.C. § 1831"), as a raw regex with capture groups. */
export interface CitationDef {
  kind: string;
  /** Regex; the capture groups, joined with `-`, form the identifier. */
  pattern: string;
  /** For two groups that are year and number in that order (`S.I. 2017/692`). */
  yearFirst?: boolean;
}

export type RelationTypeName = 'derogates' | 'modifies' | 'regulates';

/** One language pack. */
export interface LegalPack {
  language: 'es' | 'pt' | 'en' | 'fr' | 'it' | 'de';
  references: ReferenceKindDef[];
  /** Order of two-part identifiers ("120/15" number/year; "78-17" year/number). Default: number/year. */
  idOrder?: 'number/year' | 'year/number';
  /** Words after which a bare four-digit year belongs to the title ("Companies Act 2006"). */
  titleYear?: string[];
  citations?: CitationDef[];
  /** Operative verbs, in the forms that state the document's own effect (not past narratives). */
  relations: Record<RelationTypeName, string[]>;
  /** "parcialmente", "partially"… */
  partial: string[];
  /** Words naming an article-level unit in references ("artículo 5", "Section 5", "§ 5"). */
  articleWords: string[];
  structure: {
    /** Article headings at the start of a line. */
    article: string[];
    /** Words for a sole article ("Artículo único") → id `1`. */
    sole: string[];
    /** Ordinal words for the first article ("Article premier"). */
    first: string[];
    /** Paragraph headings inside an article ("Parágrafo único", "§ 1º" in Brazil). */
    paragraph: string[];
    /** Grouping headings: chapter, title, part, book. */
    division: string[];
    /** How a line-start "§" reads in this language when outside an article. */
    sectionSign: 'article' | 'paragraph';
    /** Markers, inside parentheses or brackets, of a repealed unit. */
    repealed: string[];
    /** Markers, inside parentheses or brackets, of the text that gave the current wording. */
    wording: string[];
    /** Words introducing an internal reference ("ver", "see", "gemäß"). */
    internal: string[];
    /** Words joining a unit to another document ("del", "of the", "da") → not internal. */
    external: string[];
    /** Words for the previous / next unit ("anterior", "preceding"). */
    previous: string[];
    next: string[];
    /** Words naming units in internal references ("punto", "numeral", "item"). */
    unitWords: string[];
  };
}

const ES: LegalPack = {
  language: 'es',
  references: [
    { kind: 'annex', words: ['anexos?', 'ap[ée]ndices?'], id: 'roman' },
    { kind: 'decree', words: ['real\\s+decreto(?:-ley)?', 'decreto(?:-ley|\\s+ley)?', 'decretos'] },
    { kind: 'law', words: ['ley(?:es)?(?:\\s+org[áa]nica)?'] },
    { kind: 'regulation', words: ['reglamentos?'] },
    { kind: 'resolution', words: ['resoluci[óo]n(?:es)?', 'acordadas?'] },
    { kind: 'circular', words: ['circular(?:es)?', 'comunicaci[óo]n(?:es)?'] },
    { kind: 'directive', words: ['directivas?'] },
    { kind: 'ordinance', words: ['ordenanzas?', '[óo]rden(?:es)?\\s+ministerial(?:es)?'] },
  ],
  relations: {
    derogates: [
      'der[oó]g(?:a|an)se',
      'se\\s+der[oó]ga(?:n)?',
      'qu[eé]da(?:n)?\\s+derogad[oa]s?',
      'd[eé]ja(?:n)?se\\s+sin\\s+efecto',
      'se\\s+deja(?:n)?\\s+sin\\s+efecto',
      'abr[oó]g(?:a|an)se',
    ],
    modifies: [
      'modif[ií]ca(?:n)?se',
      'se\\s+modifica(?:n)?',
      'sustit[uú]ye(?:n)?se',
      'se\\s+sustituye(?:n)?',
      'reempl[aá]za(?:n)?se',
      'agr[eé]ga(?:n)?se',
      'incorp[oó]ra(?:n)?se',
      'qu[eé]da(?:n)?\\s+(?:redactad|modificad)[oa]s?',
    ],
    regulates: ['regl[aá]m[eé]nta(?:n)?se', 'se\\s+reglamenta(?:n)?'],
  },
  partial: ['parcialmente'],
  articleWords: ['art[ií]culos?', 'arts?\\.'],
  structure: {
    article: ['art[ií]culo', 'art\\.'],
    sole: ['[úu]nico'],
    first: ['primero'],
    paragraph: ['par[áa]grafo'],
    division: ['cap[ií]tulo', 't[ií]tulo', 'libro', 'parte', 'secci[óo]n'],
    sectionSign: 'article',
    repealed: ['derogad[oa]s?', 'sin\\s+efecto'],
    wording: [
      'redacci[óo]n\\s+dada\\s+por',
      'texto\\s+(?:seg[úu]n|dado\\s+por)',
      'modificad[oa]\\s+por',
      'sustituid[oa]\\s+por',
      'incorporad[oa]\\s+por',
      'agregad[oa]\\s+por',
    ],
    internal: [
      'ver',
      'v[ée]ase',
      'seg[úu]n',
      'conforme(?:\\s+a)?',
      'de\\s+acuerdo\\s+(?:con|a)',
      'establecid[oa]\\s+en',
      'previst[oa]\\s+en',
      'dispuest[oa]\\s+en',
    ],
    external: ['del?', 'de\\s+la', 'de\\s+los', 'de\\s+las'],
    previous: ['anterior', 'precedente'],
    next: ['siguiente'],
    unitWords: ['punto', 'numeral', 'apartado', 'secci[óo]n', 'inciso'],
  },
};

const PT: LegalPack = {
  language: 'pt',
  references: [
    { kind: 'annex', words: ['anexos?', 'ap[êe]ndices?'], id: 'roman' },
    { kind: 'decree', words: ['decreto(?:-lei)?', 'decretos'] },
    { kind: 'law', words: ['lei(?:s)?(?:\\s+complementar)?'] },
    { kind: 'ordinance', words: ['medida\\s+provis[óo]ria', 'portarias?'] },
    { kind: 'regulation', words: ['regulamentos?'] },
    { kind: 'resolution', words: ['resolu[çc][ãa]o', 'resolu[çc][õo]es', 'delibera[çc][ãa]o'] },
    {
      kind: 'circular',
      words: ['circular(?:es)?', 'instru[çc][ãa]o\\s+normativa', 'comunicados?'],
    },
    { kind: 'directive', words: ['diretivas?'] },
  ],
  relations: {
    derogates: ['revoga(?:m)?-se', 'fica(?:m)?\\s+revogad[oa]s?', '(?:é|são)\\s+revogad[oa]s?'],
    modifies: [
      'altera(?:m)?-se',
      'fica(?:m)?\\s+alterad[oa]s?',
      'passa(?:m)?\\s+a\\s+vigorar\\s+com\\s+a\\s+seguinte\\s+reda[çc][ãa]o',
      'acrescenta(?:m)?-se',
      'd[áa]-se\\s+nova\\s+reda[çc][ãa]o',
      'substitui-se',
    ],
    regulates: ['regulamenta(?:m)?-se', 'fica(?:m)?\\s+regulamentad[oa]s?'],
  },
  partial: ['parcialmente', 'em\\s+parte'],
  articleWords: ['artigos?', 'arts?\\.'],
  structure: {
    article: ['artigo', 'art\\.'],
    sole: ['[úu]nico'],
    first: ['primeiro'],
    paragraph: ['par[áa]grafo'],
    division: ['cap[íi]tulo', 't[íi]tulo', 'livro', 'parte', 'se[çc][ãa]o', 'subse[çc][ãa]o'],
    // Brazilian drafting: "§ 1º" is a paragraph of the article above.
    sectionSign: 'paragraph',
    repealed: ['revogad[oa]s?'],
    wording: [
      'reda[çc][ãa]o\\s+dada\\s+pel[oa]',
      'inclu[íi]d[oa]\\s+pel[oa]',
      'acrescid[oa]\\s+pel[oa]',
      'alterad[oa]\\s+pel[oa]',
      'renumerad[oa]\\s+pel[oa]',
    ],
    internal: [
      'ver',
      'vide',
      'conforme(?:\\s+o)?',
      'nos\\s+termos\\s+d[oa]',
      'de\\s+acordo\\s+com',
      'previst[oa]\\s+n[oa]',
      'dispost[oa]\\s+n[oa]',
      'referid[oa]\\s+n[oa]',
    ],
    external: ['d[oa]s?', 'de'],
    previous: ['anterior', 'precedente'],
    next: ['seguinte'],
    unitWords: ['item', 'itens', 'se[çc][ãa]o', 'inciso'],
  },
};

const EN: LegalPack = {
  language: 'en',
  titleYear: ['acts?', 'regulations', 'rules', 'orders?'],
  references: [
    {
      kind: 'annex',
      words: ['annex(?:es)?', 'appendix', 'appendices', 'schedules?', 'exhibits?'],
      id: 'roman',
    },
    { kind: 'law', words: ['acts?', 'laws?', 'statutes?'] },
    { kind: 'decree', words: ['executive\\s+orders?', 'decrees?'] },
    { kind: 'regulation', words: ['regulations?', 'rules?'] },
    { kind: 'resolution', words: ['resolutions?', 'decisions?'] },
    { kind: 'circular', words: ['circulars?'] },
    { kind: 'directive', words: ['directives?'] },
    { kind: 'ordinance', words: ['ordinances?'] },
  ],
  citations: [
    {
      kind: 'usc',
      pattern: '\\b(\\d{1,2})\\s+U\\.?\\s?S\\.?\\s?C\\.?\\s*(?:§+\\s*)?(\\d+[a-z]?(?:-\\d+)?)',
    },
    {
      kind: 'cfr',
      pattern: '\\b(\\d{1,2})\\s+C\\.?\\s?F\\.?\\s?R\\.?\\s*(?:(?:§+|part)\\s*)?(\\d+(?:\\.\\d+)?)',
    },
    {
      kind: 'publaw',
      pattern: '\\bPub(?:lic)?\\.?\\s*L(?:aw)?\\.?\\s*(?:No\\.?\\s*)?(\\d{2,3})[-–](\\d{1,4})',
    },
    { kind: 'si', pattern: '\\bS\\.?\\s?I\\.?\\s+(\\d{4})\\s*/\\s*(\\d{1,5})', yearFirst: true },
  ],
  relations: {
    derogates: [
      '(?:is|are)\\s+(?:hereby\\s+)?(?:repealed|revoked|rescinded)',
      'hereby\\s+(?:repeals?|revokes?)',
      'shall\\s+(?:be\\s+)?(?:repealed|cease\\s+to\\s+have\\s+effect)',
    ],
    modifies: [
      '(?:is|are)\\s+(?:hereby\\s+)?(?:amended|replaced|substituted)',
      'hereby\\s+amends?',
      'shall\\s+be\\s+(?:amended|replaced)',
    ],
    regulates: ['hereby\\s+(?:implements|regulates)', 'gives\\s+effect\\s+to'],
  },
  partial: ['partially', 'in\\s+part'],
  articleWords: [
    'articles?',
    'sections?',
    'secs?\\.',
    '§§?',
    'regulations?',
    'rules?',
    'clauses?',
    'paragraphs?',
  ],
  structure: {
    article: ['article', 'art\\.', 'section', 'sec\\.', 'regulation', 'rule', 'clause'],
    sole: ['sole'],
    first: ['one', 'first'],
    paragraph: [],
    division: ['chapter', 'part', 'title', 'book', 'subpart'],
    sectionSign: 'article',
    repealed: ['repealed', 'revoked', 'omitted', 'deleted'],
    wording: [
      'as\\s+amended\\s+by',
      'amended\\s+by',
      'substituted\\s+by',
      'inserted\\s+by',
      'added\\s+by',
    ],
    internal: [
      'see',
      'under',
      'pursuant\\s+to',
      'subject\\s+to',
      'as\\s+(?:set\\s+out|provided|referred\\s+to)\\s+in',
      'in\\s+accordance\\s+with',
    ],
    external: ['of\\s+the', 'of'],
    previous: ['preceding', 'previous'],
    next: ['following', 'next'],
    unitWords: ['item', 'paragraph', 'point'],
  },
};

const FR: LegalPack = {
  language: 'fr',
  // "Loi n° 78-17", "décret n° 2004-374": year, then number.
  idOrder: 'year/number',
  references: [
    { kind: 'annex', words: ['annexes?', 'appendices?'], id: 'roman' },
    { kind: 'law', words: ['lois?'] },
    { kind: 'decree', words: ['d[ée]crets?'] },
    { kind: 'ordinance', words: ['ordonnances?'] },
    { kind: 'regulation', words: ['r[èe]glements?'] },
    { kind: 'resolution', words: ['arr[êe]t[ée]s?', 'd[ée]cisions?'] },
    { kind: 'circular', words: ['circulaires?'] },
    { kind: 'directive', words: ['directives?'] },
  ],
  relations: {
    derogates: ['(?:est|sont)\\s+abrog[ée]e?s?', 'abroge(?:nt)?\\b'],
    modifies: ['(?:est|sont)\\s+(?:modifi[ée]e?s?|remplac[ée]e?s?)', 'modifie(?:nt)?\\b'],
    regulates: ["pris\\s+pour\\s+l'application\\s+de"],
  },
  partial: ['partiellement'],
  articleWords: ['articles?', 'art\\.'],
  structure: {
    article: ['article', 'art\\.'],
    sole: ['unique'],
    first: ['premier', '1er'],
    paragraph: ['alin[ée]a'],
    division: ['chapitre', 'titre', 'livre', 'partie', 'section'],
    sectionSign: 'article',
    repealed: ['abrog[ée]e?s?'],
    wording: ['modifi[ée]e?\\s+par', 'cr[ée]{1,2}e?\\s+par', 'r[ée]dig[ée]e?\\s+par'],
    internal: [
      'voir',
      'conform[ée]ment\\s+[àa]',
      'selon',
      'en\\s+application\\s+de',
      'pr[ée]vu\\s+[àa]',
    ],
    external: ['du', 'de\\s+la', 'des'],
    previous: ['pr[ée]c[ée]dent'],
    next: ['suivant'],
    unitWords: ['point', 'paragraphe'],
  },
};

const IT: LegalPack = {
  language: 'it',
  references: [
    { kind: 'annex', words: ['allegat[oi]'], id: 'roman' },
    {
      kind: 'decree',
      words: ['decreto\\s+legislativo', 'd\\.\\s?lgs\\.', 'decreto(?:-legge)?', 'decreti'],
    },
    { kind: 'law', words: ['legge', 'leggi'] },
    { kind: 'regulation', words: ['regolament[oi]'] },
    { kind: 'circular', words: ['circolar[ei]'] },
    { kind: 'directive', words: ['direttiv[ae]'] },
  ],
  relations: {
    derogates: ['(?:è|sono)\\s+abrogat[oaie]', 'abroga(?:no)?\\b'],
    modifies: ['(?:è|sono)\\s+(?:sostituit|modificat)[oaie]', 'sono\\s+soppress[ie]'],
    regulates: ['in\\s+attuazione\\s+d(?:el|ella|i)'],
  },
  partial: ['parzialmente'],
  articleWords: ['articol[oi]', 'artt?\\.'],
  structure: {
    article: ['articolo', 'art\\.'],
    sole: ['unico'],
    first: ['primo'],
    paragraph: ['comma'],
    division: ['capo', 'titolo', 'libro', 'parte', 'sezione'],
    sectionSign: 'article',
    repealed: ['abrogat[oaie]', 'soppress[oaie]'],
    wording: ['modificat[oa]\\s+da', 'sostituit[oa]\\s+da', 'inserit[oa]\\s+da'],
    internal: ['vedi', 'ai\\s+sensi\\s+del', 'secondo', 'di\\s+cui\\s+al', 'previst[oa]\\s+dal'],
    external: ['del', 'della', 'dei', 'delle'],
    previous: ['precedente'],
    next: ['seguente', 'successivo'],
    unitWords: ['punto', 'paragrafo'],
  },
};

const DE: LegalPack = {
  language: 'de',
  references: [
    { kind: 'annex', words: ['anlagen?', 'anh[äa]nge?'], id: 'roman' },
    { kind: 'law', words: ['gesetz(?:es)?'] },
    { kind: 'regulation', words: ['verordnung(?:en)?'] },
    { kind: 'resolution', words: ['beschl[üu]ss?e?'] },
    { kind: 'circular', words: ['rundschreiben'] },
    { kind: 'directive', words: ['richtlinien?'] },
  ],
  relations: {
    derogates: [
      'wird\\s+aufgehoben',
      'werden\\s+aufgehoben',
      'tritt\\s+au[ßs]er\\s+kraft',
      'treten\\s+au[ßs]er\\s+kraft',
    ],
    modifies: [
      'wird\\s+(?:wie\\s+folgt\\s+)?ge[äa]ndert',
      'werden\\s+ge[äa]ndert',
      'erh[äa]lt\\s+folgende\\s+fassung',
    ],
    regulates: ['zur\\s+durchf[üu]hrung\\s+d(?:es|er)'],
  },
  partial: ['teilweise'],
  articleWords: ['artikel', 'art\\.', '§§?'],
  structure: {
    article: ['artikel', 'art\\.'],
    sole: ['einziger'],
    first: [],
    paragraph: [],
    division: ['kapitel', 'abschnitt', 'teil', 'titel', 'buch'],
    sectionSign: 'article',
    repealed: ['aufgehoben', 'weggefallen'],
    wording: ['ge[äa]ndert\\s+durch', 'eingef[üu]gt\\s+durch', 'neu\\s+gefasst\\s+durch'],
    internal: ['siehe', 'gem[äa][ßs]', 'nach', 'im\\s+sinne\\s+d(?:es|er)'],
    external: ['des', 'der'],
    previous: ['vorstehend', 'vorherig'],
    next: ['folgend', 'nachstehend'],
    unitWords: ['nummer', 'punkt'],
  },
};

/** The built-in packs, by language. */
export const LEGAL_PACKS: Record<LegalPack['language'], LegalPack> = {
  es: ES,
  pt: PT,
  en: EN,
  fr: FR,
  it: IT,
  de: DE,
};

/** Languages with a built-in pack. */
export const LEGAL_LANGUAGES = Object.keys(LEGAL_PACKS) as LegalPack['language'][];
