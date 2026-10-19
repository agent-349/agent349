import { describe, it, expect } from 'vitest';
import type { AuditRecord } from '../../../../src/types/index.js';
import { formatRecords, toCEF, toLEEF } from '../../../../src/audit/siem/formatters.js';

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'rec-1',
    timestamp: new Date('2026-01-15T10:00:00Z'),
    requestId: 'req|1',
    sessionId: 's1',
    tenantId: 'acme',
    userId: 'u1',
    agentId: 'agent',
    category: 'tool',
    action: 'tool.call',
    outcome: 'success',
    severity: 'warning',
    detail: { summary: 'ok' },
    metrics: {},
    security: {},
    ...overrides,
  };
}

// Values come from users, tools and the model; a SIEM must not be fed forged
// fields or forged records through them. Same output as the Java SDK.
describe('SIEM formatters — escaping', () => {
  const forged = record({
    action: 'tool.call|9|x',
    userId: 'eve\tsev=critical',
    detail: { summary: 'ok act=deleteAll\nCEF:0|Fake' },
  });

  it('CEF escapes header pipes, extension equals signs and line breaks', () => {
    expect(toCEF(forged)).toBe(
      'CEF:0|Agent349|AgentOrchestrator|1.0|tool.call\\|9\\|x|tool.call\\|9\\|x|5|' +
        'src=eve\tsev\\=critical dst=agent msg=ok act\\=deleteAll\\nCEF:0|Fake ' +
        'cs1=acme cs1Label=tenantId cs2=req|1 cs2Label=requestId outcome=success',
    );
  });

  it('CEF escapes backslashes and carriage returns', () => {
    const line = toCEF(record({ action: 'a\\b\r\nc', userId: 'x\\y\rz' }));
    expect(line).toContain('|a\\\\b  c|');
    expect(line).toContain('src=x\\\\y\\rz ');
  });

  it('LEEF turns header pipes into underscores and tabs or line breaks in values into spaces', () => {
    expect(toLEEF(forged)).toBe(
      'LEEF:2.0|Agent349|AgentOrchestrator|1.0|tool.call_9_x|tenantId=acme\tusrName=eve sev=critical\t' +
        'cat=tool\tsev=warning\toutcome=success\trequestId=req|1',
    );
    expect(toLEEF(record({ tenantId: 'acme\nLEEF:2.0|Fake' }))).not.toContain('\n');
  });

  it('keeps one line per record', () => {
    expect(formatRecords([forged, forged], 'cef').split('\n')).toHaveLength(2);
    expect(formatRecords([forged, forged], 'leef').split('\n')).toHaveLength(2);
  });
});
