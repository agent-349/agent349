/**
 * Legal language packs: references, relations and structure as each legal
 * tradition writes them (synthetic texts following their drafting
 * conventions), and the installation's own extensions through rag.legal.
 */
import { describe, it, expect } from 'vitest';

import { LegalProfile } from '../../../src/rag/legal/LegalProfile.js';
import { ReferenceExtractor } from '../../../src/rag/references/ReferenceExtractor.js';
import { RelationExtractor } from '../../../src/rag/references/RelationExtractor.js';
import {
  StructureParser,
  internalReferenceTag,
} from '../../../src/rag/structure/StructureParser.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';

const refs = new ReferenceExtractor();
const rels = new RelationExtractor();
const parser = new StructureParser();
const keys = (text: string): string[] => refs.extract(text).map((r) => r.key);
const units = (text: string): string[] => parser.parse(text).map((u) => `${u.kind}:${u.id}`);
const rel = (text: string) =>
  rels.extract(text).map((r) => [r.type, r.target, r.scope, r.articles ?? [], r.strength]);

describe('identifiers', () => {
  const p = new LegalProfile({ yearPivot: 30 });
  it('reads number/year, year/number by context or shape, series letters and bis', () => {
    expect(p.normaliseNumber('120/15')).toBe('120/2015');
    expect(p.normaliseNumber('120/015')).toBe('120/2015');
    expect(p.normaliseNumber('120-2015')).toBe('120/2015');
    expect(p.normaliseNumber('45/98')).toBe('45/1998');
    expect(p.normaliseNumber('2016/679', true)).toBe('679/2016');
    expect(p.normaliseNumber('2018/293')).toBe('293/2018'); // three digits after a year: year/number
    expect(p.normaliseNumber('2002/009')).toBe('2002/2009'); // a padded year stays a year
    expect(p.normaliseNumber('78-17', false, 'year/number')).toBe('17/1978');
    expect(p.normaliseNumber('A 7000')).toBe('a-7000');
    expect(p.normaliseNumber('12.345')).toBe('12345');
    expect(p.normaliseNumber('57 bis')).toBe('57-bis');
    expect(p.normaliseNumber('196', false, 'number/year', '2003')).toBe('196/2003');
  });
  it('migrates keys written with two-digit years', () => {
    expect(p.normaliseKey('decree:120/15')).toBe('decree:120/2015');
    expect(p.normaliseKey('decree:120/2015')).toBe('decree:120/2015');
    expect(p.normaliseKey('annex:14')).toBe('annex:14');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Traditions
// ─────────────────────────────────────────────────────────────────────────────

describe('Spain', () => {
  const text = [
    'Artículo 1. Objeto.',
    'Esta ley orgánica adapta el ordenamiento al Reglamento (UE) 2016/679 y desarrolla la Ley Orgánica 3/2018.',
    'Artículo 2. Ámbito de aplicación.',
    'Lo dispuesto en el artículo 1 se aplica a todo tratamiento.',
    'Disposición derogatoria única. Derogación normativa.',
    'Queda derogado el Real Decreto 1720/2007, de 21 de diciembre.',
  ].join('\n');
  it('references, relations, structure and internal references', () => {
    expect(keys(text)).toEqual(['regulation:679/2016', 'law:3/2018', 'decree:1720/2007']);
    expect(rel(text)).toEqual([['derogates', 'decree:1720/2007', 'total', [], 'explicit']]);
    expect(units(text)).toEqual(['article:1', 'article:2']);
    expect(parser.internalReferences(text)).toEqual([
      { unit: 'article', id: '1', label: 'dispuesto en el artículo 1' },
    ]);
  });
});

describe('Latin America', () => {
  it('Uruguay / Argentina / Mexico', () => {
    const uy = [
      'Artículo 1º.- Derógase el Decreto N° 732/019.',
      'Artículo 2º.- Modifícase el artículo 5 del Decreto 654/018.',
      'Según la Comunicación A 7000 y la Circular N° 3.456.',
    ].join('\n');
    expect(keys(uy)).toEqual([
      'decree:732/2019',
      'decree:654/2018',
      'circular:a-7000',
      'circular:3456',
    ]);
    expect(rel(uy)).toEqual([
      ['derogates', 'decree:732/2019', 'total', [], 'explicit'],
      ['modifies', 'decree:654/2018', 'partial', ['5'], 'explicit'],
    ]);
    expect(units('ARTÍCULO PRIMERO.- Se expide la ley.\nArtículo Segundo bis.- Texto.')).toEqual([
      'article:1',
    ]);
    expect(units('Artículo único. Se aprueba el reglamento.')).toEqual(['article:1']);
  });
});

describe('Brazil', () => {
  const text = [
    'Art. 1º Esta Lei dispõe sobre o tratamento de dados pessoais.',
    'Art. 2º Para os fins desta Lei, considera-se:',
    'I - dado pessoal: informação relacionada a pessoa natural;',
    '§ 1º O disposto no caput aplica-se às pessoas jurídicas.',
    '§ 2º Aplica-se o disposto no § 1º aos órgãos públicos.',
    'Parágrafo único. Os dados anonimizados não serão considerados dados pessoais.',
    'Art. 3º Fica revogada a Lei nº 9.507, de 12 de novembro de 1997.',
    'Art. 4º O art. 5º da Lei nº 8.078, de 11 de setembro de 1990, passa a vigorar com a seguinte redação:',
    'Art. 5º (Revogado pela Lei nº 13.709, de 2018)',
    'Art. 6º Esta Lei entra em vigor na data de sua publicação. (Redação dada pela Lei nº 13.853, de 2019)',
  ].join('\n');
  it('§ inside an article is a paragraph; repealed and re-worded articles', () => {
    const u = parser.parse(text);
    expect(u.map((x) => `${x.kind}:${x.id}`)).toEqual([
      'article:1',
      'article:2',
      'paragraph:2§1',
      'paragraph:2§2',
      'paragraph:2§unico',
      'article:3',
      'article:4',
      'article:5',
      'article:6',
    ]);
    expect(u.find((x) => x.id === '5')?.derogated).toBe(true);
    expect(u.find((x) => x.id === '6')?.amendedBy).toBe('Lei nº 13.853, de 2019');
  });
  it('relations and internal references to a paragraph', () => {
    expect(rel(text)).toEqual([
      ['derogates', 'law:9507', 'total', [], 'explicit'],
      ['modifies', 'law:8078', 'partial', ['5'], 'inferred'],
    ]);
    const internal = parser.internalReferences('Aplica-se o disposto no § 1º aos órgãos públicos.');
    expect(internal).toEqual([{ unit: 'sign', id: '1', label: 'disposto no § 1º' }]);
    const section = parser.cover(
      parser.parse(text),
      text.indexOf('§ 2º'),
      text.indexOf('Parágrafo'),
    );
    expect(section.paragraphs).toEqual(['2§2']);
    expect(internalReferenceTag(internal[0]!, section)).toBe('par:2§1');
  });
});

describe('Portugal', () => {
  it('articles with ".º" and repeals of a Decreto-Lei', () => {
    const text =
      'Artigo 1.º\nObjeto\nArtigo 2.º\nÉ revogado o Decreto-Lei n.º 41/2019, de 1 de abril.';
    expect(units(text)).toEqual(['article:1', 'article:2']);
    expect(keys(text)).toEqual(['decree:41/2019']);
    expect(rel(text)).toEqual([['derogates', 'decree:41/2019', 'total', [], 'explicit']]);
  });
});

describe('United States', () => {
  const text = [
    'SEC. 101. DEFINITIONS.',
    'In this Act, the term "agency" has the meaning given in section 551 of title 5.',
    'SEC. 102. AMENDMENTS.',
    'Section 5 of the Federal Reserve Act (12 U.S.C. 248) is amended by striking "may" and inserting "shall".',
    'See section 101 for definitions. Enacted as Pub. L. 111–203.',
    '§ 1026.5 General disclosure requirements.',
  ].join('\n');
  it('sections and § as articles, codified citations, amendments', () => {
    expect(units(text)).toEqual(['article:101', 'article:102', 'article:1026.5']);
    expect(keys(text)).toEqual(['usc:12-248', 'publaw:111-203']);
    expect(rel(text)).toEqual([['modifies', 'usc:12-248', 'partial', ['5'], 'inferred']]);
    expect(parser.internalReferences(text).map((r) => [r.unit, r.id])).toEqual([['sign', '101']]);
    expect(
      internalReferenceTag({ unit: 'sign', id: '101', label: '' }, { articles: ['102'] }),
    ).toBe('art:101');
  });
  it('the year in a title is not an identifier', () => {
    expect(
      keys(
        'The Companies Act 2006 and the Money Laundering Regulations 2007 (S.I. 2007/2157) are revoked.',
      ),
    ).toEqual(['si:2157/2007']);
  });
});

describe('European Union', () => {
  it('year/number identifiers, articles with points, repeals', () => {
    const text = [
      'Article 1',
      'Subject matter',
      'Article 4(1) of Regulation (EU) No 575/2013 applies.',
      'Directive 2006/48/EC is repealed.',
    ].join('\n');
    expect(units(text)).toEqual(['article:1', 'article:4']);
    expect(keys(text)).toEqual(['regulation:575/2013', 'directive:48/2006']);
    expect(rel(text)).toEqual([['derogates', 'directive:48/2006', 'total', [], 'explicit']]);
  });
});

describe('France', () => {
  it('Article premier / 1er, year-number identifiers', () => {
    const text = [
      'Article 1er',
      'La présente loi modifie la loi n° 78-17 du 6 janvier 1978.',
      'Article 2',
      'Le décret n° 2004-374 du 29 avril 2004 est abrogé.',
      'Voir l’article 1er.',
    ].join('\n');
    expect(units(text)).toEqual(['article:1', 'article:2']);
    expect(units('Article premier\nTexte.')).toEqual(['article:1']);
    expect(keys(text)).toEqual(['law:17/1978', 'decree:374/2004']);
    expect(rel(text)).toEqual([
      ['modifies', 'law:17/1978', 'partial', [], 'inferred'],
      ['derogates', 'decree:374/2004', 'total', [], 'explicit'],
    ]);
  });
});

describe('Italy', () => {
  it('date before the number, articles with -bis, repeals', () => {
    const text = [
      'Art. 1',
      'Oggetto',
      'Art. 2-bis',
      'Il decreto legislativo 30 giugno 2003, n. 196, è abrogato.',
      'Ai sensi del comma 2 del medesimo articolo.',
    ].join('\n');
    expect(units(text)).toEqual(['article:1', 'article:2 bis']);
    expect(keys(text)).toEqual(['decree:196/2003']);
    expect(rel(text)).toEqual([['derogates', 'decree:196/2003', 'total', [], 'explicit']]);
  });
});

describe('Germany', () => {
  it('§ and Artikel headings, aufgehoben, Richtlinie with /EG', () => {
    const text = [
      '§ 1 Anwendungsbereich',
      'Dieses Gesetz gilt für alle Institute.',
      '§ 2 Begriffsbestimmungen',
      '§ 3 (weggefallen)',
      'Artikel 4 Änderung',
      'Die Verordnung (EU) 2016/679 wird wie folgt geändert.',
      'Die Richtlinie 2006/48/EG tritt außer Kraft.',
      'Siehe § 2.',
    ].join('\n');
    const u = parser.parse(text);
    expect(u.map((x) => `${x.kind}:${x.id}`)).toEqual([
      'article:1',
      'article:2',
      'article:3',
      'article:4',
    ]);
    expect(u.find((x) => x.id === '3')?.derogated).toBe(true);
    expect(keys(text)).toEqual(['regulation:679/2016', 'directive:48/2006']);
    expect(rel(text)).toEqual([
      ['modifies', 'regulation:679/2016', 'partial', [], 'explicit'],
      ['derogates', 'directive:48/2006', 'total', [], 'explicit'],
    ]);
    expect(parser.internalReferences(text).map((r) => [r.unit, r.id])).toEqual([['sign', '2']]);
  });
});

describe('Manuals and procedures (any language)', () => {
  it('numbered sections, tables of contents, internal references', () => {
    const text = [
      '1.1 Scope ........................ 3',
      '2.1 Opening 4',
      '1.1 Scope',
      'This procedure applies to all branches. See item 2.1.',
      '2.1 Opening',
      'Open the cash register.',
    ].join('\n');
    expect(units(text)).toEqual(['section:1.1', 'section:2.1']);
    expect(parser.internalReferences(text)).toEqual([
      { unit: 'section', id: '2.1', label: 'See item 2.1' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Installation config
// ─────────────────────────────────────────────────────────────────────────────

describe('rag.legal', () => {
  it('restricts the packs and adds the installation words', () => {
    const p = new LegalProfile({
      packs: ['es'],
      references: [{ kind: 'policy', words: ['pol[ií]tica'] }],
      relations: [{ type: 'derogates', words: ['se\\s+deja\\s+atr[aá]s'] }],
      structure: { article: ['cl[aá]usula'] },
    });
    const x = new ReferenceExtractor({ profile: p });
    expect(x.extract('Ver la Política 12 y la Directive 2006/48/EC.').map((r) => r.key)).toEqual([
      'policy:12',
    ]);
    expect(
      new RelationExtractor({ profile: p }).extract('Se deja atrás la Política 7.')[0],
    ).toMatchObject({
      type: 'derogates',
      target: 'policy:7',
    });
    expect(
      new StructureParser(p).parse('Cláusula 3. Plazos.').map((u) => `${u.kind}:${u.id}`),
    ).toEqual(['article:3']);
  });

  it('is validated by the config loader', () => {
    const bad = (legal: unknown) => () => ConfigLoader.from({ rag: { legal } } as never);
    expect(bad({ packs: ['xx'] })).toThrow(/unknown pack 'xx'/);
    expect(bad({ yearPivot: 120 })).toThrow(/yearPivot/);
    expect(bad({ references: [{ kind: 'p', words: ['('] }] })).toThrow(/invalid pattern/);
  });
});

describe('dotted identifiers: thousands or compound', () => {
  const x = new ReferenceExtractor();
  const keys = (t: string): string[] => x.extract(t).map((r) => r.key);

  it('three-digit groups are thousands separators', () => {
    expect(keys('Ley 19.889.')).toEqual(['law:19889']);
    expect(keys('Ley 19.889, de 2020')).toEqual(['law:19889']);
    expect(keys('Act No. 12,345.')).toEqual(['law:12345']);
    expect(keys('Decreto 12.345/2020')).toEqual(['decree:12345/2020']);
  });

  it('other groups make a compound number, without leading zeros', () => {
    expect(keys('Circular 21.0070 - Inspecciones')).toEqual(['circular:21.70']);
    expect(keys('según la Circular 21.70')).toEqual(['circular:21.70']);
    expect(keys('Circular 25.0005')).toEqual(['circular:25.5']);
    expect(keys('Circular 2024.15')).toEqual(['circular:2024.15']);
    expect(keys('Resolución 1.234.5678')).toEqual(['resolution:1.234.5678']);
    expect(keys('Circular 21.0070/2021')).toEqual(['circular:21.70/2021']);
  });

  it('distinct compound numbers no longer collapse to their first part', () => {
    expect(keys('Circular 21.0070, Circular 21.0213 y Circular 21.0250')).toEqual([
      'circular:21.70',
      'circular:21.213',
      'circular:21.250',
    ]);
  });
});
