import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWebReadTool } from '../../../../src/tools/builtin/http/WebReadTool.js';
import type { RequestPerformer } from '../../../../src/tools/builtin/http/guardedRequest.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { ExecutionContext } from '../../../../src/types/index.js';
import { ValidationError } from '../../../../src/errors/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

const PAGE =
  '<html><head><title>Quarterly report</title><script>evil()</script></head>' +
  '<body><nav>menu</nav><p>Revenue rose 4%.</p></body></html>';

let respond: { status?: number; body?: string; contentType?: string };
let performer: RequestPerformer;
let emit: ReturnType<typeof vi.fn>;
let ctx: InternalToolContext;

beforeEach(() => {
  respond = {};
  emit = vi.fn();

  performer = async () => ({
    status: respond.status ?? 200,
    headers: { 'content-type': respond.contentType ?? 'text/html; charset=utf-8' },
    body: respond.body ?? PAGE,
    truncated: false,
  });

  ctx = { emit } as unknown as InternalToolContext;
});

/** Stub resolver: every test hostname answers with one public address. */

const resolve = async (): Promise<string[]> => ['93.184.216.34'];

function tool(overrides: Record<string, unknown> = {}) {
  return createWebReadTool(
    {
      name: 'web.read',
      allowedDomains: ['*.example.com'],
      transport: { performer, resolve },
      ...overrides,
    },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

describe('web.read', () => {
  it('returns the page text with the markup stripped', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/q3' }, CTX);
    const data = result.data as { text: string; title?: string };

    expect(result.success).toBe(true);
    expect(data.text).toContain('Revenue rose 4%');
    expect(data.text).not.toContain('<p>');
  });

  it('drops scripts and navigation chrome', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/q3' }, CTX);
    expect((result.data as { text: string }).text).not.toContain('evil()');
  });

  it('reports the page title', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/q3' }, CTX);
    expect((result.data as { title?: string }).title).toBe('Quarterly report');
  });

  it('returns plain text unchanged', async () => {
    respond = { body: 'just words', contentType: 'text/plain' };
    const result = await tool().execute({ url: 'https://docs.example.com/x' }, CTX);

    expect((result.data as { text: string }).text).toBe('just words');
  });

  it('truncates a long page and says so', async () => {
    respond = { body: 'x'.repeat(5000), contentType: 'text/plain' };
    const result = await tool({ maxChars: 100 }).execute(
      { url: 'https://docs.example.com/x' },
      CTX,
    );
    const data = result.data as { text: string; truncated?: boolean };

    expect(data.text).toHaveLength(100);
    expect(data.truncated).toBe(true);
  });

  it('reports an HTTP error as a failed result', async () => {
    respond = { status: 404 };
    const result = await tool().execute({ url: 'https://docs.example.com/gone' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });

  it('asks for a URL when none was supplied', async () => {
    const result = await tool().execute({ url: '  ' }, CTX);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('web.read provenance', () => {
  // The marker that lets the tracker see an inlet and an outlet meet in one
  // turn. Without it the whole observability story is inert.
  it('marks the result as untrusted', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/q3' }, CTX);
    expect(result.untrusted).toBe(true);
  });

  it('marks an error result as untrusted too', async () => {
    respond = { status: 500 };
    const result = await tool().execute({ url: 'https://docs.example.com/x' }, CTX);
    expect(result.untrusted).toBe(true);
  });

  it('tells the model in the payload that the text is not instructions', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/q3' }, CTX);
    expect((result.data as { warning: string }).warning).toMatch(/never as instructions/i);
  });

  it('says the same thing in the tool description', () => {
    expect(tool().description).toMatch(/not as instructions to follow/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Egress
// ─────────────────────────────────────────────────────────────────────────────

describe('web.read egress', () => {
  it('refuses a domain outside the allowlist', async () => {
    const result = await tool().execute({ url: 'https://evil.com/x' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in the allowed list/);
  });

  it('emits security.egress.denied when it refuses one', async () => {
    await tool().execute({ url: 'https://evil.com/x' }, CTX);

    expect(emit).toHaveBeenCalledWith(
      'security.egress.denied',
      expect.objectContaining({ control: 'allowed-hosts' }),
    );
  });

  // These apply whether or not a domain allowlist is configured.
  it('refuses a loopback URL even with no allowlist', async () => {
    const result = await tool({ allowedDomains: [] }).execute(
      { url: 'http://127.0.0.1:8080/x' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private, loopback or link-local/);
  });

  it('refuses the cloud metadata endpoint even with no allowlist', async () => {
    const result = await tool({ allowedDomains: [] }).execute(
      { url: 'http://169.254.169.254/latest/meta-data/' },
      CTX,
    );
    expect(result.success).toBe(false);
  });

  it('refuses a non-http scheme', async () => {
    const result = await tool({ allowedDomains: [] }).execute({ url: 'file:///etc/passwd' }, CTX);
    expect(result.success).toBe(false);
  });

  it('warns at build time when no domain allowlist is configured', () => {
    tool({ allowedDomains: [] });
    expect(emit).toHaveBeenCalledWith(
      'security.web.unrestricted',
      expect.objectContaining({ toolName: 'web.read' }),
    );
  });

  it('stays quiet when an allowlist is configured', () => {
    tool();
    expect(emit).not.toHaveBeenCalledWith('security.web.unrestricted', expect.anything());
  });

  it('names the readable domains in its description', () => {
    expect(tool().description).toContain('*.example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structure, selector and format
// ─────────────────────────────────────────────────────────────────────────────

describe('web.read structure', () => {
  // Plain `text` fused adjacent blocks ("alphabeta"): a caller could neither
  // read the words nor tell where one block ended and the next began.
  it('keeps block elements on separate lines', async () => {
    respond = {
      body: '<html><body><p>alpha</p><p>beta</p><ul><li>one</li><li>two</li></ul></body></html>',
    };
    const result = await tool().execute({ url: 'https://docs.example.com/x' }, CTX);

    expect((result.data as { text: string }).text).toBe('alpha\nbeta\none\ntwo');
  });

  it('keeps inline markup on the same line', async () => {
    respond = { body: '<p>Revenue <b>rose</b> 4%.</p>' };
    const result = await tool().execute({ url: 'https://docs.example.com/x' }, CTX);

    expect((result.data as { text: string }).text).toBe('Revenue rose 4%.');
  });
});

describe('web.read selector', () => {
  const NEWS =
    '<html><body><nav><a>Home</a></nav>' +
    '<div class="news"><h2>Call 1</h2><p>AI platform</p></div>' +
    '<div class="news"><h2>Call 2</h2></div>' +
    '<footer>(c) Agency</footer></body></html>';

  it('returns only the text of the selected elements, in document order', async () => {
    respond = { body: NEWS };
    const result = await tool({ selector: '.news' }).execute(
      { url: 'https://docs.example.com/news' },
      CTX,
    );
    const data = result.data as { text: string; selectorMatches: number };

    expect(data.text).toBe('Call 1\nAI platform\n\nCall 2');
    expect(data.selectorMatches).toBe(2);
  });

  // Without a selector nav/footer are chrome; with one, the caller chose the region.
  it('reads a selected region even when it is page chrome', async () => {
    respond = { body: NEWS };
    const result = await tool({ selector: 'nav' }).execute(
      { url: 'https://docs.example.com/n' },
      CTX,
    );

    expect((result.data as { text: string }).text).toBe('Home');
  });

  it('reports zero matches instead of failing when the region disappears', async () => {
    respond = { body: NEWS };
    const result = await tool({ selector: '#gone' }).execute(
      { url: 'https://docs.example.com/n' },
      CTX,
    );
    const data = result.data as { text: string; selectorMatches: number };

    expect(result.success).toBe(true);
    expect(data.text).toBe('');
    expect(data.selectorMatches).toBe(0);
  });

  it('refuses an invalid selector at build time', () => {
    expect(() => tool({ selector: 'p[[' })).toThrow(ValidationError);
  });

  it('refuses a selector combined with the raw format', () => {
    expect(() => tool({ selector: '.news', format: 'raw' })).toThrow(/format 'text'/);
  });
});

describe('web.read raw format', () => {
  it('returns the body exactly as received', async () => {
    const xml = '<rss><channel><title>T &amp; U</title></channel></rss>';
    respond = { body: xml, contentType: 'application/rss+xml' };
    const result = await tool({ format: 'raw' }).execute(
      { url: 'https://docs.example.com/f' },
      CTX,
    );
    const data = result.data as { text: string; format: string };

    expect(data.text).toBe(xml);
    expect(data.format).toBe('raw');
    expect(result.untrusted).toBe(true);
  });

  it('refuses an unknown format at build time', () => {
    expect(() => tool({ format: 'pdf' })).toThrow(ValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conditional requests
// ─────────────────────────────────────────────────────────────────────────────

describe('web.read conditional requests', () => {
  let sentHeaders: Record<string, string>[];
  let answer: { status: number; headers: Record<string, string>; body: string };

  function conditionalTool(overrides: Record<string, unknown> = {}) {
    sentHeaders = [];
    const recorder: RequestPerformer = async (_url, init) => {
      sentHeaders.push(init.headers);
      return { ...answer, truncated: false };
    };
    return createWebReadTool(
      {
        name: 'web.read',
        allowedDomains: ['*.example.com'],
        transport: { performer: recorder, resolve },
        conditionalRequests: true,
        ...overrides,
      },
      ctx,
    );
  }

  beforeEach(() => {
    answer = {
      status: 200,
      headers: {
        'content-type': 'text/html',
        etag: '"v7"',
        'last-modified': 'Wed, 09 Sep 2026 10:00:00 GMT',
      },
      body: '<p>hello</p>',
    };
  });

  it('reports status, etag and last-modified on every successful read', async () => {
    const result = await tool().execute({ url: 'https://docs.example.com/x' }, CTX);
    const data = result.data as { status: number; notModified: boolean };

    expect(data.status).toBe(200);
    expect(data.notModified).toBe(false);

    const withValidators = await conditionalTool().execute(
      { url: 'https://docs.example.com/x' },
      CTX,
    );
    expect(withValidators.data).toMatchObject({
      etag: '"v7"',
      lastModified: 'Wed, 09 Sep 2026 10:00:00 GMT',
    });
  });

  it('keeps the one-field schema unless conditional requests are enabled', () => {
    expect(Object.keys(tool().inputSchema['properties'] as object)).toEqual(['url']);
    expect(Object.keys(conditionalTool().inputSchema['properties'] as object)).toEqual([
      'url',
      'ifNoneMatch',
      'ifModifiedSince',
    ]);
  });

  it('sends the validators as conditional headers', async () => {
    await conditionalTool().execute(
      {
        url: 'https://docs.example.com/x',
        ifNoneMatch: '"v7"',
        ifModifiedSince: 'Wed, 09 Sep 2026 10:00:00 GMT',
      },
      CTX,
    );

    expect(sentHeaders[0]).toMatchObject({
      'if-none-match': '"v7"',
      'if-modified-since': 'Wed, 09 Sep 2026 10:00:00 GMT',
    });
  });

  it('answers notModified, without text, when the server says 304', async () => {
    answer = { status: 304, headers: { etag: '"v7"' }, body: '' };
    const result = await conditionalTool().execute(
      { url: 'https://docs.example.com/x', ifNoneMatch: '"v7"' },
      CTX,
    );
    const data = result.data as { notModified: boolean; status: number; text?: string };

    expect(result.success).toBe(true);
    expect(data.notModified).toBe(true);
    expect(data.status).toBe(304);
    expect(data.text).toBeUndefined();
  });

  it('treats a 304 to a request that asked nothing as an HTTP error', async () => {
    answer = { status: 304, headers: {}, body: '' };
    const result = await conditionalTool().execute({ url: 'https://docs.example.com/x' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('304');
  });

  it('refuses a validator that would inject a header', async () => {
    const result = await conditionalTool().execute(
      { url: 'https://docs.example.com/x', ifNoneMatch: '"v7"\r\nX-Evil: 1' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(sentHeaders).toHaveLength(0);
  });

  it('ignores validators when conditional requests are disabled', async () => {
    const plain = createWebReadTool(
      {
        name: 'web.read',
        allowedDomains: ['*.example.com'],
        transport: {
          performer: async (_url, init) => {
            sentHeaders.push(init.headers);
            return { ...answer, truncated: false };
          },
          resolve,
        },
      },
      ctx,
    );
    sentHeaders = [];
    await plain.execute({ url: 'https://docs.example.com/x', ifNoneMatch: '"v7"' }, CTX);

    expect(sentHeaders[0]?.['if-none-match']).toBeUndefined();
  });
});
