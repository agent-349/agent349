import { describe, it, expect } from 'vitest';
import {
  assertResponseFormatSupported,
  buildStructuredOutput,
  validateAgainstSchema,
} from '../../../src/llm/structured.js';
import { textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { UnsupportedCapabilityError } from '../../../src/errors/index.js';
import type { LLMRequest, ProviderCapabilities } from '../../../src/types/index.js';

const SCHEMA = {
  type: 'object',
  properties: { total: { type: 'number' } },
  required: ['total'],
};

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return { ...textOnlyCapabilities(), ...overrides };
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return { systemPrompt: '', messages: [], model: 'm', ...overrides };
}

describe('assertResponseFormatSupported', () => {
  it('passes when no format was requested', () => {
    expect(() => assertResponseFormatSupported('p', capabilities(), request())).not.toThrow();
  });

  it('rejects a format on a provider with no native support', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities(),
        request({ responseFormat: { type: 'json_object' } }),
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  it('rejects a schema on a provider that only offers JSON mode, and says what to do', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities({ structuredOutput: 'jsonMode' }),
        request({ responseFormat: { type: 'json_schema', schema: SCHEMA } }),
      ),
    ).toThrow(/json_object/);
  });

  it('accepts plain JSON mode on a JSON-mode provider', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities({ structuredOutput: 'jsonMode' }),
        request({ responseFormat: { type: 'json_object' } }),
      ),
    ).not.toThrow();
  });

  it('rejects combining a format with tools when the provider cannot do both', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities({ structuredOutput: 'jsonSchema', structuredOutputWithTools: false }),
        request({
          responseFormat: { type: 'json_schema', schema: SCHEMA },
          tools: [{ name: 't', description: 'd', inputSchema: {} }],
        }),
      ),
    ).toThrow(/cannot combine/);
  });

  it('allows the combination when the provider declares it', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities({ structuredOutput: 'jsonSchema', structuredOutputWithTools: true }),
        request({
          responseFormat: { type: 'json_schema', schema: SCHEMA },
          tools: [{ name: 't', description: 'd', inputSchema: {} }],
        }),
      ),
    ).not.toThrow();
  });

  it('does not object to tools alone', () => {
    expect(() =>
      assertResponseFormatSupported(
        'p',
        capabilities(),
        request({ tools: [{ name: 't', description: 'd', inputSchema: {} }] }),
      ),
    ).not.toThrow();
  });
});

describe('buildStructuredOutput', () => {
  it('returns nothing when no format was requested', () => {
    expect(buildStructuredOutput('{"a":1}', undefined, 'none')).toBeUndefined();
  });

  it('keeps provider mode, parsing and validation as three separate facts', () => {
    const result = buildStructuredOutput(
      '{"total":10}',
      { type: 'json_schema', schema: SCHEMA },
      'native_schema',
    );

    expect(result).toEqual({
      mode: 'native_schema',
      parsed: true,
      value: { total: 10 },
      validation: 'skipped',
    });
  });

  it('never reports validation without being asked for it', () => {
    const result = buildStructuredOutput(
      '{"total":"not a number"}',
      { type: 'json_schema', schema: SCHEMA },
      'native_schema',
    );

    expect(result?.validation).toBe('skipped');
    expect(result?.validationErrors).toBeUndefined();
  });

  it('validates when asked and reports the failures', () => {
    const result = buildStructuredOutput(
      '{"total":"not a number"}',
      { type: 'json_schema', schema: SCHEMA, validate: true },
      'native_schema',
    );

    expect(result?.parsed).toBe(true);
    expect(result?.validation).toBe('invalid');
    expect(result?.validationErrors?.[0]).toContain('total');
  });

  it('marks a valid answer as valid', () => {
    const result = buildStructuredOutput(
      '{"total":10}',
      { type: 'json_schema', schema: SCHEMA, validate: true },
      'native_schema',
    );

    expect(result?.validation).toBe('valid');
  });

  it('reports a parse failure and keeps the raw text', () => {
    const result = buildStructuredOutput('sorry, I cannot', { type: 'json_object' }, 'native_json');

    expect(result).toEqual({
      mode: 'native_json',
      parsed: false,
      validation: 'skipped',
      rawText: 'sorry, I cannot',
    });
  });

  it('does not claim native enforcement the provider did not apply', () => {
    const result = buildStructuredOutput('{"total":1}', { type: 'json_object' }, 'none');
    expect(result?.mode).toBe('none');
  });
});

describe('validateAgainstSchema', () => {
  it('returns no errors for a valid value', () => {
    expect(validateAgainstSchema({ total: 1 }, SCHEMA)).toEqual([]);
  });

  it('reports a missing required property', () => {
    expect(validateAgainstSchema({}, SCHEMA)[0]).toContain('total');
  });

  it('reports a malformed schema instead of throwing', () => {
    const errors = validateAgainstSchema({}, { type: 'not-a-type' });
    expect(errors[0]).toContain('schema could not be compiled');
  });

  it('tolerates unknown keywords from a provider dialect', () => {
    expect(validateAgainstSchema({ total: 1 }, { ...SCHEMA, propertyOrdering: ['total'] })).toEqual(
      [],
    );
  });
});
