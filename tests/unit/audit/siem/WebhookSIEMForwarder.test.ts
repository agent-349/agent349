import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebhookSIEMForwarder } from '../../../../src/audit/siem/WebhookSIEMForwarder.js';
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
    severity: 'warning',
    detail: { summary: 'denied' },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebhookSIEMForwarder', () => {
  it('POSTs a JSON array by default and reports sent count', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fwd = new WebhookSIEMForwarder({ url: 'https://siem.example/ingest' });
    const result = await fwd.forward([makeRecord(), makeRecord({ id: 'rec-2' })]);

    expect(result).toEqual({ sent: 2, failed: 0 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://siem.example/ingest');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    const parsed = JSON.parse((init as RequestInit).body as string) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('sends CEF as text/plain', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const fwd = new WebhookSIEMForwarder({ url: 'https://x', format: 'cef' });
    await fwd.forward([makeRecord()]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(init.body as string).toContain('CEF:0|Agent349|');
  });

  it('merges custom headers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fwd = new WebhookSIEMForwarder({
      url: 'https://x',
      headers: { authorization: 'Bearer t' },
    });
    await fwd.forward([makeRecord()]);
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer t');
  });

  it('marks the batch failed on a non-2xx response (no throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 500, statusText: 'Server Error' })),
    );
    const fwd = new WebhookSIEMForwarder({ url: 'https://x' });
    const result = await fwd.forward([makeRecord()]);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors?.[0]).toContain('500');
  });

  it('marks the batch failed on a network error (no throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const fwd = new WebhookSIEMForwarder({ url: 'https://x' });
    const result = await fwd.forward([makeRecord()]);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(result.errors?.[0]).toContain('ECONNREFUSED');
  });

  it('is a no-op for an empty batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fwd = new WebhookSIEMForwarder({ url: 'https://x' });
    expect(await fwd.forward([])).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
