import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { FieldMasker } from '../../../src/security/FieldMasker.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(roles: string[]): ExecutionContext {
  return {
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    roles,
    metadata: {},
  };
}

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('FieldMasker', () => {
  // ── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts an empty rule list', () => {
      const masker = new FieldMasker();
      const data = { salary: 50000 };
      expect(masker.mask('hr.getEmployee', data, makeCtx([]))).toEqual(data);
    });

    it('accepts initial rules', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr.getEmployee',
          field: 'salary',
          maskType: 'redact',
          visibleToRoles: ['hr_admin'],
        },
      ]);
      const result = masker.mask('hr.getEmployee', { salary: 50000 }, makeCtx(['manager']));
      expect(result.salary).toBe('[REDACTED]');
    });
  });

  // ── addRule / removeRule ───────────────────────────────────────────────────

  describe('addRule()', () => {
    it('registers a rule that is applied on next mask() call', () => {
      const masker = new FieldMasker();
      masker.addRule({
        toolName: 'tool.a',
        field: 'secret',
        maskType: 'redact',
        visibleToRoles: [],
      });
      expect(masker.mask('tool.a', { secret: 'xyz' }, makeCtx([])).secret).toBe('[REDACTED]');
    });
  });

  describe('removeRule()', () => {
    it('removes an existing rule so subsequent calls no longer mask', () => {
      const masker = new FieldMasker([
        { toolName: 'tool.a', field: 'secret', maskType: 'redact', visibleToRoles: [] },
      ]);
      masker.removeRule('tool.a', 'secret');
      expect(masker.mask('tool.a', { secret: 'xyz' }, makeCtx([])).secret).toBe('xyz');
    });

    it('does nothing if rule does not exist', () => {
      const masker = new FieldMasker();
      expect(() => masker.removeRule('nonexistent', 'field')).not.toThrow();
    });

    it('removes only the first matching rule when duplicates exist', () => {
      const masker = new FieldMasker([
        { toolName: 'tool.a', field: 'x', maskType: 'redact', visibleToRoles: [] },
        { toolName: 'tool.a', field: 'x', maskType: 'redact', visibleToRoles: [] },
      ]);
      masker.removeRule('tool.a', 'x');
      // One rule remains — field should still be masked
      expect(masker.mask('tool.a', { x: 'v' }, makeCtx([])).x).toBe('[REDACTED]');
    });
  });

  // ── mask() — pass-through cases ────────────────────────────────────────────

  describe('mask() — pass-through', () => {
    it('returns data unchanged when no rules are registered for the tool', () => {
      const masker = new FieldMasker([
        { toolName: 'other.tool', field: 'salary', maskType: 'redact', visibleToRoles: [] },
      ]);
      const data = { salary: 99999 };
      expect(masker.mask('hr.getEmployee', data, makeCtx([]))).toEqual(data);
    });

    it('returns data unchanged when user has a visibleToRole', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'salary', maskType: 'redact', visibleToRoles: ['hr_admin'] },
      ]);
      const data = { salary: 75000 };
      expect(masker.mask('hr', data, makeCtx(['hr_admin']))).toEqual(data);
    });

    it('returns data unchanged when visibleToRoles includes "*" (public field)', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'name', maskType: 'redact', visibleToRoles: ['*'] },
      ]);
      const data = { name: 'Alice' };
      expect(masker.mask('hr', data, makeCtx([]))).toEqual(data);
    });

    it('skips rule silently when field path does not exist in object', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'missing.nested', maskType: 'redact', visibleToRoles: [] },
      ]);
      const data = { name: 'Alice' };
      expect(masker.mask('hr', data, makeCtx([]))).toEqual(data);
    });
  });

  // ── mask() — redact ────────────────────────────────────────────────────────

  describe('mask() — redact', () => {
    it('replaces field with [REDACTED] for unauthorised user', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr.getEmployee',
          field: 'salary',
          maskType: 'redact',
          visibleToRoles: ['hr_admin', 'payroll'],
        },
      ]);
      const result = masker.mask('hr.getEmployee', { salary: 75000 }, makeCtx(['manager']));
      expect(result.salary).toBe('[REDACTED]');
    });

    it('redacts string values', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr',
          field: 'personalEmail',
          maskType: 'redact',
          visibleToRoles: ['hr_admin'],
        },
      ]);
      expect(
        masker.mask('hr', { personalEmail: 'alice@acme.com' }, makeCtx([])).personalEmail,
      ).toBe('[REDACTED]');
    });
  });

  // ── mask() — partial ───────────────────────────────────────────────────────

  describe('mask() — partial', () => {
    it('shows last N chars and masks the rest (spec example: nationalId ******789)', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr.getEmployee',
          field: 'nationalId',
          maskType: 'partial',
          visibleToRoles: ['hr_admin', 'legal'],
          partialConfig: { showLast: 3, maskChar: '*' },
        },
      ]);
      // 9-char ID: first 6 masked → '******789'
      const result = masker.mask(
        'hr.getEmployee',
        { nationalId: '123456789' },
        makeCtx(['manager']),
      );
      expect(result.nationalId).toBe('******789');
    });

    it('shows first N chars and masks the rest', () => {
      const masker = new FieldMasker([
        {
          toolName: 'tool',
          field: 'token',
          maskType: 'partial',
          visibleToRoles: [],
          partialConfig: { showFirst: 4, maskChar: '*' },
        },
      ]);
      const result = masker.mask('tool', { token: 'ABCDEFGHIJ' }, makeCtx([]));
      expect(result.token).toBe('ABCD******');
    });

    it('shows first and last N chars', () => {
      const masker = new FieldMasker([
        {
          toolName: 'tool',
          field: 'card',
          maskType: 'partial',
          visibleToRoles: [],
          partialConfig: { showFirst: 4, showLast: 4, maskChar: '*' },
        },
      ]);
      // '1234567890123456' → '1234********3456'
      const result = masker.mask('tool', { card: '1234567890123456' }, makeCtx([]));
      expect(result.card).toBe('1234********3456');
    });

    it('uses custom maskChar', () => {
      const masker = new FieldMasker([
        {
          toolName: 'tool',
          field: 'pin',
          maskType: 'partial',
          visibleToRoles: [],
          partialConfig: { showLast: 1, maskChar: '#' },
        },
      ]);
      expect(masker.mask('tool', { pin: '12345' }, makeCtx([])).pin).toBe('####5');
    });

    it('clamps mask length to zero when showFirst+showLast >= string length', () => {
      const masker = new FieldMasker([
        {
          toolName: 'tool',
          field: 'id',
          maskType: 'partial',
          visibleToRoles: [],
          partialConfig: { showFirst: 3, showLast: 3 },
        },
      ]);
      // 'ABCDEF' length 6 — no room to mask
      expect(masker.mask('tool', { id: 'ABCDEF' }, makeCtx([])).id).toBe('ABCDEF');
    });

    it('defaults maskChar to "*" when not specified', () => {
      const masker = new FieldMasker([
        {
          toolName: 'tool',
          field: 'v',
          maskType: 'partial',
          visibleToRoles: [],
          partialConfig: { showLast: 2 },
        },
      ]);
      expect(masker.mask('tool', { v: 'hello' }, makeCtx([])).v).toBe('***lo');
    });
  });

  // ── mask() — hash ──────────────────────────────────────────────────────────

  describe('mask() — hash', () => {
    it('returns first 12 hex chars of SHA-256 (spec: "a3f2...c8d1" style)', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'email', maskType: 'hash', visibleToRoles: [] },
      ]);
      const email = 'juan@email.com';
      const result = masker.mask('hr', { email }, makeCtx([]));
      expect(result.email).toBe(sha12(email));
      expect(result.email).toHaveLength(12);
    });

    it('is deterministic — same input always produces same hash', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'email', maskType: 'hash', visibleToRoles: [] },
      ]);
      const r1 = masker.mask('hr', { email: 'test@acme.com' }, makeCtx([]));
      const r2 = masker.mask('hr', { email: 'test@acme.com' }, makeCtx([]));
      expect(r1.email).toBe(r2.email);
    });

    it('produces different hashes for different values', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'email', maskType: 'hash', visibleToRoles: [] },
      ]);
      const r1 = masker.mask('hr', { email: 'alice@acme.com' }, makeCtx([]));
      const r2 = masker.mask('hr', { email: 'bob@acme.com' }, makeCtx([]));
      expect(r1.email).not.toBe(r2.email);
    });

    it('converts non-string values to string before hashing', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'id', maskType: 'hash', visibleToRoles: [] },
      ]);
      const result = masker.mask('hr', { id: 12345 }, makeCtx([]));
      expect(result.id).toBe(sha12('12345'));
    });
  });

  // ── mask() — custom ────────────────────────────────────────────────────────

  describe('mask() — custom', () => {
    it('calls customMask and uses its return value', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr',
          field: 'salary',
          maskType: 'custom',
          visibleToRoles: [],
          customMask: (value) => `~${String(value)}~`,
        },
      ]);
      expect(masker.mask('hr', { salary: 80000 }, makeCtx([])).salary).toBe('~80000~');
    });

    it('passes context to customMask', () => {
      const masker = new FieldMasker([
        {
          toolName: 'hr',
          field: 'salary',
          maskType: 'custom',
          visibleToRoles: [],
          customMask: (_value, ctx) => `masked_for_${ctx.userId}`,
        },
      ]);
      const ctx = makeCtx([]);
      expect(masker.mask('hr', { salary: 80000 }, ctx).salary).toBe('masked_for_u1');
    });

    it('falls back to [REDACTED] when customMask is not provided', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'salary', maskType: 'custom', visibleToRoles: [] },
      ]);
      expect(masker.mask('hr', { salary: 80000 }, makeCtx([])).salary).toBe('[REDACTED]');
    });
  });

  // ── mask() — dot notation ──────────────────────────────────────────────────

  describe('mask() — dot notation', () => {
    it('masks a 2-level nested field', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'employee.salary', maskType: 'redact', visibleToRoles: [] },
      ]);
      const data = { employee: { name: 'Alice', salary: 60000 } };
      const result = masker.mask('hr', data, makeCtx([]));
      expect(result.employee.salary).toBe('[REDACTED]');
      expect(result.employee.name).toBe('Alice');
    });

    it('masks a 3-level nested field', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'info.finance.bonus', maskType: 'redact', visibleToRoles: [] },
      ]);
      const data = { info: { finance: { bonus: 5000, allowance: 200 } } };
      const result = masker.mask('hr', data, makeCtx([]));
      expect(result.info.finance.bonus).toBe('[REDACTED]');
      expect(result.info.finance.allowance).toBe(200);
    });

    it('skips silently when intermediate key is missing', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'a.b.c', maskType: 'redact', visibleToRoles: [] },
      ]);
      const data = { a: { x: 1 } };
      expect(masker.mask('hr', data, makeCtx([]))).toEqual(data);
    });
  });

  // ── mask() — array data ────────────────────────────────────────────────────

  describe('mask() — array data', () => {
    it('applies masking to each element of an array', () => {
      const masker = new FieldMasker([
        { toolName: 'hr.list', field: 'salary', maskType: 'redact', visibleToRoles: ['hr_admin'] },
      ]);
      const data = [
        { name: 'Alice', salary: 70000 },
        { name: 'Bob', salary: 80000 },
      ];
      const result = masker.mask('hr.list', data, makeCtx(['manager']));
      expect(result[0].salary).toBe('[REDACTED]');
      expect(result[1].salary).toBe('[REDACTED]');
      expect(result[0].name).toBe('Alice');
    });

    it('skips non-object array elements without throwing', () => {
      const masker = new FieldMasker([
        { toolName: 'tool', field: 'x', maskType: 'redact', visibleToRoles: [] },
      ]);

      const data: any[] = [null, 42, 'string', { x: 'secret' }];
      const result = masker.mask('tool', data, makeCtx([]));
      expect(result[0]).toBeNull();
      expect(result[1]).toBe(42);
      expect(result[2]).toBe('string');
      expect(result[3].x).toBe('[REDACTED]');
    });
  });

  // ── mask() — immutability ──────────────────────────────────────────────────

  describe('mask() — immutability', () => {
    it('does not mutate the original object', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'salary', maskType: 'redact', visibleToRoles: [] },
      ]);
      const original = { salary: 50000, name: 'Alice' };
      const originalCopy = { ...original };
      masker.mask('hr', original, makeCtx([]));
      expect(original).toEqual(originalCopy);
    });

    it('does not mutate the original array', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'salary', maskType: 'redact', visibleToRoles: [] },
      ]);
      const original = [{ salary: 50000 }];
      masker.mask('hr', original, makeCtx([]));
      expect(original[0]!.salary).toBe(50000);
    });
  });

  // ── mask() — spec example (section 8.4) ───────────────────────────────────

  describe('mask() — spec example hr.getEmployee (section 8.4)', () => {
    const masker = new FieldMasker([
      {
        toolName: 'hr.getEmployee',
        field: 'salary',
        maskType: 'redact',
        visibleToRoles: ['hr_admin', 'payroll'],
      },
      {
        toolName: 'hr.getEmployee',
        field: 'nationalId',
        maskType: 'partial',
        visibleToRoles: ['hr_admin', 'legal'],
        partialConfig: { showLast: 3, maskChar: '*' },
      },
      {
        toolName: 'hr.getEmployee',
        field: 'personalEmail',
        maskType: 'redact',
        visibleToRoles: ['hr_admin'],
      },
    ]);

    const employee = {
      name: 'María González',
      department: 'Engineering',
      salary: 75000,
      nationalId: '123456789',
      personalEmail: 'maria@personal.com',
      workEmail: 'maria@acme.com',
    };

    it('manager: masks salary, nationalId (partial), personalEmail; leaves others visible', () => {
      const result = masker.mask('hr.getEmployee', employee, makeCtx(['manager']));
      expect(result.name).toBe('María González');
      expect(result.department).toBe('Engineering');
      expect(result.salary).toBe('[REDACTED]');
      expect(result.nationalId).toBe('******789'); // showLast:3 on 9-char ID
      expect(result.personalEmail).toBe('[REDACTED]');
      expect(result.workEmail).toBe('maria@acme.com');
    });

    it('hr_admin: sees everything unmasked', () => {
      const result = masker.mask('hr.getEmployee', employee, makeCtx(['hr_admin']));
      expect(result.salary).toBe(75000);
      expect(result.nationalId).toBe('123456789');
      expect(result.personalEmail).toBe('maria@personal.com');
    });

    it('payroll: sees salary but not nationalId or personalEmail', () => {
      const result = masker.mask('hr.getEmployee', employee, makeCtx(['payroll']));
      expect(result.salary).toBe(75000);
      expect(result.nationalId).toBe('******789');
      expect(result.personalEmail).toBe('[REDACTED]');
    });

    it('legal: sees nationalId but not salary or personalEmail', () => {
      const result = masker.mask('hr.getEmployee', employee, makeCtx(['legal']));
      expect(result.salary).toBe('[REDACTED]');
      expect(result.nationalId).toBe('123456789');
      expect(result.personalEmail).toBe('[REDACTED]');
    });
  });

  // ── mask() — multiple rules ────────────────────────────────────────────────

  describe('mask() — multiple rules', () => {
    it('applies all matching rules independently', () => {
      const masker = new FieldMasker([
        { toolName: 'hr', field: 'salary', maskType: 'redact', visibleToRoles: ['finance'] },
        { toolName: 'hr', field: 'email', maskType: 'hash', visibleToRoles: ['admin'] },
      ]);
      const data = { salary: 60000, email: 'user@acme.com', name: 'Bob' };
      const result = masker.mask('hr', data, makeCtx(['manager']));
      expect(result.salary).toBe('[REDACTED]');
      expect(result.email).toBe(sha12('user@acme.com'));
      expect(result.name).toBe('Bob');
    });
  });
});
