import { describe, it, expect } from 'vitest';
import { createSIEMForwarder } from '../../../../src/audit/siem/createSIEMForwarder.js';
import { WebhookSIEMForwarder } from '../../../../src/audit/siem/WebhookSIEMForwarder.js';
import { toCEF, toLEEF, formatRecords } from '../../../../src/audit/siem/formatters.js';
import type { AuditRecord } from '../../../../src/types/index.js';

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'rec-1',
    timestamp: new Date('2026-01-15T10:00:00Z'),
    requestId: 'r1',
    sessionId: 's1',
    tenantId: 'acme',
    userId: 'u1',
    agentId: 'a1',
    category: 'security',
    action: 'access_denied',
    outcome: 'blocked',
    severity: 'critical',
    detail: { summary: 'denied' },
    ...overrides,
  };
}

describe('createSIEMForwarder()', () => {
  it('returns undefined for type none', () => {
    expect(createSIEMForwarder({ type: 'none' })).toBeUndefined();
  });

  it('builds a WebhookSIEMForwarder for type webhook', () => {
    const fwd = createSIEMForwarder({ type: 'webhook', url: 'https://x', format: 'cef' });
    expect(fwd).toBeInstanceOf(WebhookSIEMForwarder);
    expect(fwd!.name).toBe('webhook');
  });
});

describe('SIEM formatters', () => {
  it('toCEF includes vendor, action and a numeric severity', () => {
    const line = toCEF(makeRecord());
    expect(line).toContain('CEF:0|Agent349|AgentOrchestrator|1.0|access_denied|');
    expect(line).toContain('|9|'); // critical → 9
    expect(line).toContain('cs1=acme');
  });

  it('toLEEF includes tenant and user', () => {
    const line = toLEEF(makeRecord());
    expect(line).toContain('LEEF:2.0|Agent349|');
    expect(line).toContain('tenantId=acme');
    expect(line).toContain('usrName=u1');
  });

  it('formatRecords json returns a parseable array', () => {
    const out = formatRecords([makeRecord(), makeRecord({ id: 'r2' })], 'json');
    expect(JSON.parse(out)).toHaveLength(2);
  });

  it('formatRecords cef returns one line per record', () => {
    const out = formatRecords([makeRecord(), makeRecord({ id: 'r2' })], 'cef');
    expect(out.split('\n')).toHaveLength(2);
  });
});
