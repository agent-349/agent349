import { describe, it, expect } from 'vitest';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import type { DeepPartial, SDKConfig } from '../../../src/config/ConfigLoader.js';

function from(overrides: DeepPartial<SDKConfig>): SDKConfig {
  return ConfigLoader.from(overrides).get();
}

describe('ConfigLoader declarative validation', () => {
  it('accepts a well-formed declarative config', () => {
    const cfg = from({
      appHome: './dist',
      tools: {
        definitions: [
          {
            name: 'calculator',
            kind: 'module',
            module: './tools/calc.js',
            export: 'calculatorTool',
          },
          { name: 'rag.search', kind: 'internal', ref: 'rag.search', config: { topK: 8 } },
        ],
      },
      skills: [{ name: 'general', description: 'd', tools: ['calculator', 'rag.search'] }],
      agents: [{ id: 'a1', name: 'A1', systemPrompt: 'p', skills: ['general'] }],
    });
    expect(cfg.tools.definitions).toHaveLength(2);
    expect(cfg.skills).toHaveLength(1);
    expect(cfg.agents).toHaveLength(1);
  });

  it('rejects duplicate tool names', () => {
    expect(() =>
      from({
        tools: {
          definitions: [
            { name: 'dup', kind: 'internal', ref: 'rag.search' },
            { name: 'dup', kind: 'internal', ref: 'rag.search' },
          ],
        },
      }),
    ).toThrow(ConfigError);
  });

  it('rejects a module tool with no module path', () => {
    expect(() =>
      from({
        // @ts-expect-error intentionally missing `module`
        tools: { definitions: [{ name: 'x', kind: 'module' }] },
      }),
    ).toThrow(/module is required/);
  });

  it('rejects an internal tool with no ref', () => {
    expect(() =>
      from({
        // @ts-expect-error intentionally missing `ref`
        tools: { definitions: [{ name: 'x', kind: 'internal' }] },
      }),
    ).toThrow(/ref is required/);
  });

  it('rejects an invalid kind', () => {
    expect(() =>
      from({
        // @ts-expect-error invalid discriminator
        tools: { definitions: [{ name: 'x', kind: 'weird', module: './a.js' }] },
      }),
    ).toThrow(/kind must be/);
  });

  it('rejects an invalid loadMode', () => {
    expect(() =>
      from({
        // @ts-expect-error invalid literal
        tools: { loadMode: 'lenient' },
      }),
    ).toThrow(/loadMode must be/);
  });

  it('rejects duplicate skill names', () => {
    expect(() =>
      from({
        skills: [
          { name: 's', description: 'd', tools: [] },
          { name: 's', description: 'd', tools: [] },
        ],
      }),
    ).toThrow(/Duplicate skill/);
  });

  it('rejects duplicate agent ids', () => {
    expect(() =>
      from({
        agents: [
          { id: 'a', name: 'A', systemPrompt: 'p', skills: [] },
          { id: 'a', name: 'A', systemPrompt: 'p', skills: [] },
        ],
      }),
    ).toThrow(/Duplicate agent/);
  });

  it('requires agent systemPrompt', () => {
    expect(() =>
      from({
        // @ts-expect-error missing systemPrompt
        agents: [{ id: 'a', name: 'A', skills: [] }],
      }),
    ).toThrow(/systemPrompt is required/);
  });

  it('omitting declarative sections keeps config valid (backward compatible)', () => {
    const cfg = from({});
    expect(cfg.tools.definitions).toBeUndefined();
    expect(cfg.skills).toBeUndefined();
    expect(cfg.agents).toBeUndefined();
  });
});
