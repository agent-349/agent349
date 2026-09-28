import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIMITS,
  fetchSize,
  fitToBytes,
  resolveLimits,
  toCollectionResult,
  truncateText,
} from '../../../src/tools/builtin/limits.js';

// ─────────────────────────────────────────────────────────────────────────────
// resolveLimits
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveLimits', () => {
  it('falls back to the SDK defaults when nothing is declared', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });

  it('lets a tool tighten its connection ceiling', () => {
    const limits = resolveLimits({ maxRows: 10 }, { maxRows: 200 });
    expect(limits.maxRows).toBe(10);
  });

  // The asymmetry is the point: a connection's limits are a guarantee for
  // whoever declared it, not a suggestion each tool may ignore.
  it('does not let a tool raise its connection ceiling', () => {
    const limits = resolveLimits({ maxRows: 5000 }, { maxRows: 200 });
    expect(limits.maxRows).toBe(200);
  });

  it('uses the connection value when the tool declares none', () => {
    expect(resolveLimits(undefined, { maxBytes: 1024 }).maxBytes).toBe(1024);
  });

  it('caps a tool against the SDK default when its connection sets none', () => {
    const limits = resolveLimits({ timeoutMs: 900_000 }, {});
    expect(limits.timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
  });

  it('resolves each field independently', () => {
    const limits = resolveLimits({ maxRows: 10 }, { maxBytes: 2048 });
    expect(limits).toEqual({
      maxRows: 10,
      maxBytes: 2048,
      timeoutMs: DEFAULT_LIMITS.timeoutMs,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchSize
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchSize', () => {
  // Asking for one extra row is what distinguishes "exactly 200 results" from
  // "at least 200" — without it truncation can only be guessed at.
  it('asks for one row beyond the cap so truncation is detectable', () => {
    expect(fetchSize({ ...DEFAULT_LIMITS, maxRows: 200 })).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toCollectionResult
// ─────────────────────────────────────────────────────────────────────────────

describe('toCollectionResult', () => {
  const limits = { maxRows: 3, maxBytes: 100_000, timeoutMs: 1000 };

  it('reports an untruncated result plainly', () => {
    const result = toCollectionResult([1, 2], limits);
    expect(result).toEqual({ rows: [1, 2], rowCount: 2, truncated: false });
  });

  it('does not flag a result that exactly fills the cap', () => {
    const result = toCollectionResult([1, 2, 3], limits);
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(3);
  });

  it('cuts to the cap and flags the reason when the probe row comes back', () => {
    const result = toCollectionResult([1, 2, 3, 4], limits);
    expect(result.rows).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('maxRows');
  });

  // Without this the model reports a capped count as the total.
  it('tells the model not to present a truncated count as complete', () => {
    const result = toCollectionResult([1, 2, 3, 4], limits);
    expect(result.notice).toMatch(/narrow the query/i);
    expect(result.notice).toMatch(/not present this as a complete or total count/i);
  });

  it('falls back to the byte cap when rows are wide rather than many', () => {
    const wide = [{ text: 'x'.repeat(500) }, { text: 'y'.repeat(500) }];
    const result = toCollectionResult(wide, { maxRows: 10, maxBytes: 600, timeoutMs: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('maxBytes');
    expect(result.rowCount).toBe(1);
  });

  it('uses the noun supplied by the caller in the notice', () => {
    const result = toCollectionResult([1, 2, 3, 4], limits, 'documents');
    expect(result.notice).toContain('documents');
  });

  it('handles an empty result without flagging truncation', () => {
    expect(toCollectionResult([], limits)).toEqual({ rows: [], rowCount: 0, truncated: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fitToBytes
// ─────────────────────────────────────────────────────────────────────────────

describe('fitToBytes', () => {
  it('returns everything when it already fits', () => {
    const rows = [1, 2, 3];
    expect(fitToBytes(rows, 10_000)).toEqual(rows);
  });

  it('returns the longest prefix that fits', () => {
    const rows = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
    const kept = fitToBytes(rows, 230);

    expect(kept.length).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(230);
  });

  // An empty result would misreport a successful query as having found
  // nothing, which is worse than exceeding the budget by one row.
  it('always keeps at least one row, even one over budget', () => {
    expect(fitToBytes(['x'.repeat(5000)], 10)).toHaveLength(1);
  });

  it('handles an empty input', () => {
    expect(fitToBytes([], 100)).toEqual([]);
  });

  it('measures multi-byte characters by bytes, not by length', () => {
    const rows = ['ñ'.repeat(50), 'ñ'.repeat(50)];
    const kept = fitToBytes(rows, 120);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// truncateText
// ─────────────────────────────────────────────────────────────────────────────

describe('truncateText', () => {
  it('leaves text within budget untouched', () => {
    expect(truncateText('hello', 10)).toEqual({ text: 'hello', truncated: false });
  });

  it('cuts to the budget and says how much was left out', () => {
    const result = truncateText('x'.repeat(100), 10);

    expect(result.text).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('100');
  });
});
