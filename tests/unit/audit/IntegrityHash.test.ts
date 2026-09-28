import { describe, it, expect } from 'vitest';
import { IntegrityHash } from '../../../src/audit/IntegrityHash.js';
import type { AuditRecord } from '../../../src/types/index.js';

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'rec-001',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    requestId: 'req-001',
    sessionId: 'sess-001',
    tenantId: 'tenant-a',
    userId: 'user-1',
    agentId: 'agent-1',
    category: 'tool',
    action: 'call_end',
    outcome: 'success',
    severity: 'info',
    ...overrides,
  };
}

describe('IntegrityHash', () => {
  describe('compute()', () => {
    it('returns a 64-character hex SHA-256 string', () => {
      const ih = new IntegrityHash();
      const hash = ih.compute(makeRecord());
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same hash for the same record', () => {
      const ih = new IntegrityHash();
      const r = makeRecord();
      expect(ih.compute(r)).toBe(ih.compute(r));
    });

    it('returns different hashes when any covered field changes', () => {
      const ih = new IntegrityHash();
      const base = makeRecord();
      const changed = makeRecord({ action: 'call_start' });
      expect(ih.compute(base)).not.toBe(ih.compute(changed));
    });

    it('is stable across separate IntegrityHash instances', () => {
      const r = makeRecord();
      expect(new IntegrityHash().compute(r)).toBe(new IntegrityHash().compute(r));
    });

    it('ignores non-covered fields (detail, metrics)', () => {
      const ih = new IntegrityHash();
      const a = makeRecord();
      const b = makeRecord({ detail: { summary: 'something' }, metrics: { durationMs: 500 } });
      expect(ih.compute(a)).toBe(ih.compute(b));
    });
  });

  describe('verify()', () => {
    it('returns true when _integrityHash matches', () => {
      const ih = new IntegrityHash();
      const r = makeRecord();
      const hash = ih.compute(r);
      const withHash: AuditRecord = { ...r, _integrityHash: hash };
      expect(ih.verify(withHash)).toBe(true);
    });

    it('returns false when _integrityHash is absent', () => {
      const ih = new IntegrityHash();
      expect(ih.verify(makeRecord())).toBe(false);
    });

    it('returns false when _integrityHash is tampered', () => {
      const ih = new IntegrityHash();
      const r: AuditRecord = { ...makeRecord(), _integrityHash: 'deadbeef' };
      expect(ih.verify(r)).toBe(false);
    });

    it('detects tampering of a covered field', () => {
      const ih = new IntegrityHash();
      const original = makeRecord();
      const hash = ih.compute(original);
      // Tamper with the outcome after hashing
      const tampered: AuditRecord = { ...original, outcome: 'failure', _integrityHash: hash };
      expect(ih.verify(tampered)).toBe(false);
    });
  });
});
