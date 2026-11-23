/**
 * Document identity: the document's own designation from its title, from the
 * heading of its text (before the preamble) and, as a fallback, from a model.
 * All norms, numbers and names are invented.
 */
import { describe, it, expect, vi } from 'vitest';
import { ReferenceExtractor } from '../../../src/rag/references/ReferenceExtractor.js';
import { DocumentIdentifier } from '../../../src/rag/references/DocumentIdentifier.js';
import { LegalProfile } from '../../../src/rag/legal/LegalProfile.js';
import { RAGFacade } from '../../../src/rag/RAGFacade.js';
import { notesFor } from '../../../src/rag/RAGPipeline.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { LLMResponse } from '../../../src/types/index.js';
import type { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import type { IngestionPipeline } from '../../../src/rag/ingestion/IngestionPipeline.js';
import type { CollectionManager } from '../../../src/rag/collections/CollectionManager.js';

const x = new ReferenceExtractor();

function routerReplying(reply: Partial<LLMResponse> | Error) {
  const call = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return {
      content: '',
      stopReason: 'end',
      usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
      ...reply,
    };
  });
  return { call, getProvider: vi.fn(() => undefined) } as unknown as LLMRouter & {
    call: ReturnType<typeof vi.fn>;
  };
}
const json = (v: unknown): Partial<LLMResponse> => ({ content: JSON.stringify(v) });

describe('selfDesignation — the heading before the preamble', () => {
  it('Spanish (Latin America): the designation line, not the norms cited in VISTO', () => {
    const text = [
      'MINISTERIO DE ASUNTOS GENERALES',
      'Ciudad Capital, 5 de mayo de 2009',
      'DECRETO N° 345/009',
      'VISTO: lo dispuesto por la Ley N° 17.001 y el Decreto 100/005;',
      'CONSIDERANDO: …',
    ].join('\n');
    expect(x.selfDesignation(text)).toEqual([
      { key: 'decree:345/2009', label: 'DECRETO N° 345/009' },
    ]);
  });

  it('Spain: a long title line opened by the designation', () => {
    const text =
      'Real Decreto 456/2021, de 3 de marzo, por el que se modifica el Real Decreto 12/2010.\n' +
      'La Ley 9/2015 establece…\nEn su virtud, DISPONGO:\nArtículo único. …';
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['decree:456/2021']);
  });

  it('Brazil: designation, summary line, then the enacting formula', () => {
    const text = [
      'DECRETO Nº 11.222, DE 9 DE OUTUBRO DE 2019',
      'Dispõe sobre o compartilhamento de dados.',
      'O PRESIDENTE DA REPÚBLICA, no uso da atribuição que lhe confere a Lei nº 8.765,',
      'DECRETA:',
    ].join('\n');
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['decree:11222']);
  });

  it('English (EU): the regulation, not the act cited after "Having regard to"', () => {
    const text = [
      'REGULATION (EU) 2030/111 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL',
      'of 27 April 2030',
      'Having regard to Regulation (EU) 2016/679,',
      'Whereas: …',
    ].join('\n');
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['regulation:111/2030']);
  });

  it('French: year-number order; "Vu" ends the heading', () => {
    const text =
      'Décret n° 2031-77 du 2 février 2031 relatif aux registres\nVu le décret n° 2004-374 ;\nDécrète :';
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['decree:77/2031']);
  });

  it('Italian: date before the number; "Visto" ends the heading', () => {
    const text =
      'DECRETO LEGISLATIVO 30 giugno 2032, n. 444\nVisto l’articolo 76 della Costituzione;\nEmana';
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['decree:444/2032']);
  });

  it('German: "Auf Grund" ends the heading', () => {
    const text =
      'Verordnung 55/2033 über Register\nAuf Grund des Gesetzes 12/2001 verordnet die Bundesregierung:';
    expect(x.selfDesignation(text).map((r) => r.key)).toEqual(['regulation:55/2033']);
  });

  it('ignores references that do not open a line, and stops at the first article', () => {
    expect(x.selfDesignation('Normas internas según la Ley 1234\nTexto…')).toEqual([]);
    expect(
      x.selfDesignation('Procedimiento de caja\nArtículo 1. Conforme al Decreto 77/2010 …'),
    ).toEqual([]);
  });

  it('an annex heading names the annex, not the norm it belongs to', () => {
    const text = 'DECRETO N° 345/009\nANEXO III\nFormularios de solicitud';
    expect(x.selfDesignation(text)).toEqual([{ key: 'annex:3', label: 'ANEXO III' }]);
  });

  it('does not read past the beginning of the text', () => {
    expect(
      x.selfDesignation('Manual del operador\n' + 'texto '.repeat(400) + '\nDecreto 1/2020'),
    ).toEqual([]);
  });
});

describe('identifyDocument — title first, heading second', () => {
  it('adds the heading when the title gives nothing', () => {
    const id = x.identifyDocument('scan_0012.pdf', 'DECRETO N° 345/009\nVISTO: …');
    expect(id.keys).toEqual(['decree:345/2009']);
    expect(id.identities).toEqual([
      { key: 'decree:345/2009', label: 'DECRETO N° 345/009', source: 'header' },
    ]);
    expect(id.conflicts).toEqual([]);
  });

  it('the title wins for the same kind; the disagreement is reported', () => {
    const id = x.identifyDocument('Decreto 345-09.pdf', 'DECRETO N° 346/009\nVISTO: …');
    expect(id.keys).toEqual(['decree:345/2009']);
    expect(id.conflicts).toEqual([
      { title: 'decree:345/2009', header: 'decree:346/2009', headerLabel: 'DECRETO N° 346/009' },
    ]);
  });

  it('the same identity in title and heading is neither repeated nor a conflict', () => {
    const id = x.identifyDocument('Decreto 345-09.pdf', 'Decreto N° 345/2009\nVISTO');
    expect(id.keys).toEqual(['decree:345/2009']);
    expect(id.conflicts).toEqual([]);
  });

  it('a kind the title does not give is added from the heading', () => {
    const id = x.identifyDocument('Resolución 12-2024.pdf', 'ANEXO II\nCuadro de tarifas');
    expect(id.identities.map((i) => [i.key, i.source])).toEqual([
      ['resolution:12/2024', 'title'],
      ['annex:2', 'header'],
    ]);
  });

  it('rag.legal.identity.header false reads only the title', () => {
    const off = new ReferenceExtractor({
      profile: new LegalProfile({ identity: { header: false } }),
    });
    expect(off.identifyDocument('scan.pdf', 'DECRETO N° 345/009\nVISTO').keys).toEqual([]);
    expect(
      x.identifyDocument('scan.pdf', 'DECRETO N° 345/009\nVISTO', { header: false }).keys,
    ).toEqual([]);
  });

  it('installation preamble words extend the packs', () => {
    const p = new LegalProfile({ preamble: ['fundamentos'] });
    const ex = new ReferenceExtractor({ profile: p });
    expect(ex.selfDesignation('FUNDAMENTOS\nDecreto 1/2020 …')).toEqual([]);
    expect(x.selfDesignation('FUNDAMENTOS\nDecreto 1/2020 …').map((r) => r.key)).toEqual([
      'decree:1/2020',
    ]);
  });
});

describe('DocumentIdentifier — model fallback', () => {
  const profile = new LegalProfile();

  it('normalises the model reply to a profile key', async () => {
    const router = routerReplying(
      json({ kind: 'decree', number: 'N° 345', year: '009', label: 'Decreto N° 345/009' }),
    );
    const r = await new DocumentIdentifier(router, 'p', 'm', profile).identify('scan.pdf', 'texto');
    expect(r.identity).toEqual({ key: 'decree:345/2009', label: 'Decreto N° 345/009' });
    expect(r.inputTokens).toBe(200);
  });

  it('accepts a number that already carries the year, and annexes in Roman numerals', async () => {
    const a = await new DocumentIdentifier(
      routerReplying(json({ kind: 'law', number: '19.001/2020', year: '2020', label: null })),
      'p',
      'm',
      profile,
    ).identify('t', 'x');
    expect(a.identity?.key).toBe('law:19001/2020');
    const b = await new DocumentIdentifier(
      routerReplying(json({ kind: 'annex', number: 'XIV', year: null, label: 'Anexo XIV' })),
      'p',
      'm',
      profile,
    ).identify('t', 'x');
    expect(b.identity?.key).toBe('annex:14');
  });

  it('no identity for a kind outside the profile, a null kind or a missing number', async () => {
    for (const reply of [
      { kind: 'manual', number: '3', year: null, label: null },
      { kind: null, number: null, year: null, label: null },
      { kind: 'decree', number: null, year: '2020', label: null },
    ]) {
      const r = await new DocumentIdentifier(
        routerReplying(json(reply)),
        'p',
        'm',
        profile,
      ).identify('t', 'x');
      expect(r.identity).toBeUndefined();
      expect(r.error).toBeUndefined();
    }
  });

  it('reports provider errors and unreadable replies without throwing', async () => {
    const e = await new DocumentIdentifier(
      routerReplying(new Error('403 no access')),
      'p',
      'm',
      profile,
    ).identify('t', 'x');
    expect(e.error).toContain('403');
    const u = await new DocumentIdentifier(
      routerReplying({ content: 'no json' }),
      'p',
      'm',
      profile,
    ).identify('t', 'x');
    expect(u.error).toContain('did not return');
    expect(
      await new DocumentIdentifier(routerReplying(new Error('down')), 'p', 'm', profile).validate(),
    ).toMatchObject({ ok: false });
  });

  it('sends only the beginning of the text and the profile kinds', async () => {
    const router = routerReplying(json({ kind: null, number: null, year: null, label: null }));
    await new DocumentIdentifier(router, 'p', 'm', profile, { maxChars: 300 }).identify(
      't',
      'a'.repeat(5000),
    );
    const req = router.call.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(req.messages[0]!.content).toContain('decree');
    expect(req.messages[0]!.content.length).toBeLessThan(800);
  });
});

describe('RAGFacade.identifyDocument', () => {
  const facade = (router: LLMRouter, mode: 'off' | 'fallback') => {
    const profile = new LegalProfile();
    return new RAGFacade(
      {} as RAGPipeline,
      {} as IngestionPipeline,
      {} as CollectionManager,
      undefined,
      {
        references: new ReferenceExtractor({ profile }),
        identifier: new DocumentIdentifier(router, 'p', 'm', profile),
        llmMode: mode,
      },
    );
  };

  it('uses the model only when the title and the heading give nothing', async () => {
    const router = routerReplying(
      json({ kind: 'circular', number: '2105', year: null, label: 'Circular 2105' }),
    );
    const f = facade(router, 'fallback');
    expect((await f.identifyDocument({ title: 'Decreto 1-2020.pdf', text: '' })).keys).toEqual([
      'decree:1/2020',
    ]);
    expect(router.call).not.toHaveBeenCalled();
    const r = await f.identifyDocument({ title: 'scan.pdf', text: 'imagen' });
    expect(r.identities).toEqual([{ key: 'circular:2105', label: 'Circular 2105', source: 'llm' }]);
    expect(r.model?.name).toBe('m');
  });

  it('mode off never calls the model; validate reports it as not configured', async () => {
    const router = routerReplying(json({ kind: 'decree', number: '1', year: '2020', label: null }));
    const f = facade(router, 'off');
    expect((await f.identifyDocument({ title: 'scan.pdf', text: 'imagen' })).keys).toEqual([]);
    expect(router.call).not.toHaveBeenCalled();
    expect(await f.validateDocumentIdentifier()).toMatchObject({
      role: 'documentIdentifier',
      configured: false,
    });
  });

  it('without identification pieces returns an empty identity', async () => {
    const f = new RAGFacade({} as RAGPipeline, {} as IngestionPipeline, {} as CollectionManager);
    expect(await f.identifyDocument({ title: 'Decreto 1-2020.pdf' })).toEqual({
      keys: [],
      identities: [],
      conflicts: [],
    });
  });
});

describe('rag.legal.identity configuration', () => {
  const load = (legal: unknown) => () => ConfigLoader.from({ rag: { legal } } as never);

  it('accepts header, preamble and the model fallback', () => {
    expect(
      load({
        preamble: ['fundamentos'],
        identity: { header: true, llm: { mode: 'off', model: 'small' } },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown mode, a bad number and an invalid preamble pattern', () => {
    expect(load({ identity: { llm: { mode: 'always' } } })).toThrow(/identity\.llm\.mode/);
    expect(load({ identity: { llm: { maxChars: -1 } } })).toThrow(/maxChars/);
    expect(load({ preamble: ['('] })).toThrow(/preamble/);
  });
});

describe('identity note on passages', () => {
  it('notes which norm the document is, with or without validity', () => {
    const n = notesFor({ identity: ['Circular N° 77/2023'] }, false);
    expect(n).toEqual([
      {
        kind: 'identity',
        label: 'Circular N° 77/2023',
        text: 'This document is Circular N° 77/2023.',
      },
    ]);
    expect(notesFor({ identity: ['Decreto 1/2020', 'Anexo II'] }, true)[0]!.label).toBe(
      'Decreto 1/2020; Anexo II',
    );
    expect(notesFor({ identity: [' '] }, true)).toEqual([]);
  });
});
