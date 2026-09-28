import { describe, it, expect } from 'vitest';
import { PricingTable } from '../../../src/tokens/PricingTable.js';

describe('PricingTable', () => {
  const table = new PricingTable({
    'gpt-4o': { input: 0.005, output: 0.015 },
    'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  });

  it('computes cost per 1000 tokens by direction', () => {
    // 1000 in → 0.005 ; 500 out → 0.0075 ; total 0.0125
    expect(table.cost('gpt-4o', 1000, 500)).toBeCloseTo(0.0125, 6);
  });

  it('returns 0 for an unknown model', () => {
    expect(table.cost('mystery-model', 1000, 1000)).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    expect(table.cost('gpt-4o', 0, 0)).toBe(0);
  });

  it('has() reports whether a model is priced', () => {
    expect(table.has('gpt-4o')).toBe(true);
    expect(table.has('nope')).toBe(false);
  });

  it('an empty table prices everything at 0', () => {
    const empty = new PricingTable();
    expect(empty.cost('gpt-4o', 1000, 1000)).toBe(0);
  });
});
