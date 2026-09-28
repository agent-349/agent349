import { describe, it, expect } from 'vitest';
import { SensitiveDataGuard } from '../../../src/audit/SensitiveDataGuard.js';
import type { AuditRecord } from '../../../src/types/index.js';

function makeRecord(detail?: AuditRecord['detail']): AuditRecord {
  return {
    id: 'rec-001',
    timestamp: new Date(),
    requestId: 'req-001',
    sessionId: 'sess-001',
    tenantId: 'tenant-a',
    userId: 'user-1',
    agentId: 'agent-1',
    category: 'tool',
    action: 'call_end',
    outcome: 'success',
    severity: 'info',
    detail,
  };
}

describe('SensitiveDataGuard', () => {
  // ── Identity fields are never mutated ─────────────────────────────────────

  describe('immutable fields', () => {
    it('does not alter id, tenantId, userId, requestId', () => {
      const guard = new SensitiveDataGuard();
      const record = makeRecord({ summary: 'hello' });
      const result = guard.sanitize(record);
      expect(result.id).toBe(record.id);
      expect(result.tenantId).toBe(record.tenantId);
      expect(result.userId).toBe(record.userId);
      expect(result.requestId).toBe(record.requestId);
    });

    it('does not mutate the original record', () => {
      const guard = new SensitiveDataGuard();
      const record = makeRecord({ summary: 'email: test@example.com' });
      const original = record.detail?.summary;
      guard.sanitize(record);
      expect(record.detail?.summary).toBe(original);
    });
  });

  // ── globalRedactFields ────────────────────────────────────────────────────

  describe('globalRedactFields', () => {
    it('replaces matching field values with [REDACTED]', () => {
      const guard = new SensitiveDataGuard({ globalRedactFields: ['password'] });
      const record = makeRecord({ input: { username: 'alice', password: 'secret123' } });
      const result = guard.sanitize(record);
      expect(result.detail?.input?.password).toBe('[REDACTED]');
      expect(result.detail?.input?.username).toBe('alice');
    });

    it('redacts deeply nested fields', () => {
      const guard = new SensitiveDataGuard({ globalRedactFields: ['apiKey'] });
      const record = makeRecord({ input: { config: { apiKey: 'sk-abc123' } } });
      const result = guard.sanitize(record);
      expect(result.detail?.input?.config?.apiKey).toBe('[REDACTED]');
    });

    it('redacts field in arrays of objects', () => {
      const guard = new SensitiveDataGuard({ globalRedactFields: ['token'] });
      const record = makeRecord({ input: [{ token: 'xyz', name: 'item1' }] });
      const result = guard.sanitize(record);
      expect(result.detail?.input?.[0]?.token).toBe('[REDACTED]');
      expect(result.detail?.input?.[0]?.name).toBe('item1');
    });
  });

  // ── Built-in regex patterns ────────────────────────────────────────────────

  describe('built-in pattern: email', () => {
    it('replaces email addresses with [EMAIL]', () => {
      const guard = new SensitiveDataGuard();
      const record = makeRecord({ summary: 'Contact: alice@example.com for info' });
      const result = guard.sanitize(record);
      expect(result.detail?.summary).toContain('[EMAIL]');
      expect(result.detail?.summary).not.toContain('alice@example.com');
    });
  });

  describe('built-in pattern: ssn', () => {
    it('replaces SSN patterns with [SSN]', () => {
      const guard = new SensitiveDataGuard();
      const record = makeRecord({ summary: 'SSN: 123-45-6789 on file' });
      const result = guard.sanitize(record);
      expect(result.detail?.summary).toContain('[SSN]');
      expect(result.detail?.summary).not.toContain('123-45-6789');
    });
  });

  describe('built-in pattern: apiKey', () => {
    it('replaces sk- prefixed tokens with [API_KEY]', () => {
      const guard = new SensitiveDataGuard();
      const record = makeRecord({ summary: 'key=sk-abc123XYZ used' });
      const result = guard.sanitize(record);
      expect(result.detail?.summary).toContain('[API_KEY]');
    });
  });

  describe('built-in pattern: jwt', () => {
    it('replaces JWT tokens with [JWT_TOKEN]', () => {
      const guard = new SensitiveDataGuard();
      const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abc123def456';
      const record = makeRecord({ summary: `token=${token}` });
      const result = guard.sanitize(record);
      expect(result.detail?.summary).toContain('[JWT_TOKEN]');
      expect(result.detail?.summary).not.toContain(token);
    });
  });

  // ── Custom patterns ────────────────────────────────────────────────────────

  describe('customPatterns', () => {
    it('applies a custom redact pattern', () => {
      const guard = new SensitiveDataGuard({
        customPatterns: [
          { name: 'secretCode', pattern: /SECRET-[A-Z]{8}/g, replacement: '[SECRET]' },
        ],
      });
      const record = makeRecord({ summary: 'Code SECRET-ABCDEFGH was used' });
      const result = guard.sanitize(record);
      expect(result.detail?.summary).toContain('[SECRET]');
      expect(result.detail?.summary).not.toContain('SECRET-ABCDEFGH');
    });
  });

  // ── No detail — no-op ─────────────────────────────────────────────────────

  describe('records without detail', () => {
    it('returns the record unchanged if detail is absent', () => {
      const guard = new SensitiveDataGuard({ globalRedactFields: ['password'] });
      const record = makeRecord();
      const result = guard.sanitize(record);
      expect(result.detail).toBeUndefined();
    });
  });
});
