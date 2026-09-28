import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFeedReadTool } from '../../../../src/tools/builtin/http/FeedReadTool.js';
import type { RequestPerformer } from '../../../../src/tools/builtin/http/guardedRequest.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

const FEED =
  '<rss version="2.0"><channel><title>Calls</title><link>https://calls.example.com/</link>' +
  '<item><title>One</title><guid>1</guid><link>https://calls.example.com/1</link></item>' +
  '<item><title>Two</title><guid>2</guid></item>' +
  '<item><title>Three</title><guid>3</guid></item>' +
  '</channel></rss>';

let answer: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
let sentHeaders: Record<string, string>[];
let emit: ReturnType<typeof vi.fn>;
let ctx: InternalToolContext;

const performer: RequestPerformer = async (_url, init) => {
  sentHeaders.push(init.headers);
  return answer;
};

const resolve = async (): Promise<string[]> => ['93.184.216.34'];

beforeEach(() => {
  answer = {
    status: 200,
    headers: { 'content-type': 'application/rss+xml', etag: '"f1"' },
    body: FEED,
    truncated: false,
  };
  sentHeaders = [];
  emit = vi.fn();
  ctx = { emit } as unknown as InternalToolContext;
});

function tool(overrides: Record<string, unknown> = {}) {
  return createFeedReadTool(
    {
      name: 'feed.read',
      allowedDomains: ['*.example.com'],
      transport: { performer, resolve },
      ...overrides,
    },
    ctx,
  );
}

describe('feed.read', () => {
  it('returns the normalised entries and feed metadata', async () => {
    const result = await tool().execute({ url: 'https://calls.example.com/rss' }, CTX);
    const data = result.data as {
      format: string;
      title: string;
      entries: { id: string; title: string }[];
      totalEntries: number;
      etag: string;
    };

    expect(result.success).toBe(true);
    expect(data.format).toBe('rss');
    expect(data.title).toBe('Calls');
    expect(data.entries.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(data.totalEntries).toBe(3);
    expect(data.etag).toBe('"f1"');
  });

  it('marks the result as untrusted and says so in the payload', async () => {
    const result = await tool().execute({ url: 'https://calls.example.com/rss' }, CTX);

    expect(result.untrusted).toBe(true);
    expect((result.data as { warning: string }).warning).toMatch(/never as instructions/i);
  });

  it('caps the entries and tells the caller', async () => {
    const result = await tool({ maxEntries: 2 }).execute(
      { url: 'https://calls.example.com/rss' },
      CTX,
    );
    const data = result.data as { entries: unknown[]; truncated: boolean; notice: string };

    expect(data.entries).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.notice).toContain('2 of 3');
  });

  it('fails plainly on a body cut at maxBytes instead of parsing half a document', async () => {
    answer = { ...answer, truncated: true };
    const result = await tool().execute({ url: 'https://calls.example.com/rss' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maxBytes/);
  });

  it('fails when the document is not a feed', async () => {
    answer = { ...answer, body: '<html><body>Not a feed</body></html>' };
    const result = await tool().execute({ url: 'https://calls.example.com/rss' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a readable feed/);
  });

  it('reports an HTTP error as a failed result', async () => {
    answer = { ...answer, status: 503 };
    const result = await tool().execute({ url: 'https://calls.example.com/rss' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });

  it('answers notModified to a conditional request that got 304', async () => {
    answer = { status: 304, headers: { etag: '"f1"' }, body: '', truncated: false };
    const result = await tool({ conditionalRequests: true }).execute(
      { url: 'https://calls.example.com/rss', ifNoneMatch: '"f1"' },
      CTX,
    );

    expect(sentHeaders[0]?.['if-none-match']).toBe('"f1"');
    expect(result.success).toBe(true);
    expect((result.data as { notModified: boolean }).notModified).toBe(true);
  });
});

describe('feed.read egress', () => {
  it('refuses a domain outside the allowlist', async () => {
    const result = await tool().execute({ url: 'https://evil.com/rss' }, CTX);

    expect(result.success).toBe(false);
    expect(emit).toHaveBeenCalledWith(
      'security.egress.denied',
      expect.objectContaining({ control: 'allowed-hosts' }),
    );
  });

  it('refuses a private address even with no allowlist', async () => {
    const result = await tool({ allowedDomains: [] }).execute({ url: 'http://10.1.2.3/rss' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private, loopback or link-local/);
  });

  it('warns at build time when no domain allowlist is configured', () => {
    tool({ allowedDomains: [] });
    expect(emit).toHaveBeenCalledWith(
      'security.web.unrestricted',
      expect.objectContaining({ toolName: 'feed.read' }),
    );
  });
});
