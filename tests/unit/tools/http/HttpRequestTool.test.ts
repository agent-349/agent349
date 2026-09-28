import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHttpRequestTool } from '../../../../src/tools/builtin/http/HttpRequestTool.js';
import type { HttpRequestToolConfig } from '../../../../src/tools/builtin/http/HttpRequestTool.js';
import type { RequestPerformer } from '../../../../src/tools/builtin/http/guardedRequest.js';
import { ConnectionManager } from '../../../../src/connections/ConnectionManager.js';
import type { ConnectionsConfig } from '../../../../src/connections/types.js';
import { ConfigCredentialProvider } from '../../../../src/credentials/ConfigCredentialProvider.js';
import { ValidationError } from '../../../../src/errors/index.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
  metadata: { department: 'finance' },
};

const CONNECTIONS: ConnectionsConfig = {
  crm: {
    type: 'http',
    baseUrl: 'https://crm.internal/api/v2',
    headers: { 'x-app': 'agent' },
    credential: { kind: 'bearer', token: 'tok-123' },
  },
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let sent: Recorded[];
let respond: { status?: number; body?: string; truncated?: boolean };
let performer: RequestPerformer;
let emit: ReturnType<typeof vi.fn>;
let ctx: InternalToolContext;

beforeEach(() => {
  sent = [];
  respond = {};
  emit = vi.fn();

  performer = async (url, init) => {
    sent.push({ url: url.toString(), method: init.method, headers: init.headers, body: init.body });
    return {
      status: respond.status ?? 200,
      headers: { 'content-type': 'application/json' },
      body: respond.body ?? '{"data":{"id":"7","name":"Ada"}}',
      truncated: respond.truncated ?? false,
    };
  };

  const manager = new ConnectionManager({
    connections: CONNECTIONS,
    credentials: new ConfigCredentialProvider(),
  });
  ctx = {
    getConnection: (name: string) => manager.get(name),
    emit,
  } as unknown as InternalToolContext;
});

function tool(overrides: Partial<HttpRequestToolConfig> = {}) {
  return createHttpRequestTool(
    {
      name: 'crm.findCustomer',
      connection: 'crm',
      method: 'GET',
      path: '/customers/{id}',
      params: {
        id: { in: 'path', from: 'model', schema: { type: 'string' }, required: true },
      },
      transport: { performer },
      ...overrides,
    },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Private addresses
// ─────────────────────────────────────────────────────────────────────────────

describe('http.request private addresses', () => {
  /** Builds the operation on a connection whose base URL resolves to 10.0.0.5. */
  function toolOn(extra: Record<string, unknown>) {
    const manager = new ConnectionManager({
      connections: {
        api: { type: 'http', baseUrl: 'https://api.internal/v1', ...extra },
      } as ConnectionsConfig,
      credentials: new ConfigCredentialProvider(),
    });
    return createHttpRequestTool(
      {
        name: 'api.status',
        connection: 'api',
        method: 'GET',
        path: '/status',
        transport: { performer, resolve: async () => ['10.0.0.5'] },
      },
      {
        getConnection: (name: string) => manager.get(name),
        emit,
      } as unknown as InternalToolContext,
    );
  }

  // An integrator-declared endpoint may legitimately be an internal service.
  it('reaches an internal address by default', async () => {
    const result = await toolOn({}).execute({}, CTX);

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('refuses a private address when the connection blocks them', async () => {
    await expect(toolOn({ blockPrivateAddresses: true }).execute({}, CTX)).rejects.toThrow(
      /private, loopback or link-local/,
    );
    expect(sent).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Building the request
// ─────────────────────────────────────────────────────────────────────────────

describe('http.request building', () => {
  it('resolves the path against the connection base URL', async () => {
    await tool().execute({ id: '7' }, CTX);
    expect(sent[0]?.url).toBe('https://crm.internal/api/v2/customers/7');
  });

  it('uses the verb fixed in configuration', async () => {
    await tool().execute({ id: '7' }, CTX);
    expect(sent[0]?.method).toBe('GET');
  });

  // The verb is a property of the operation, so the model has no say in it and
  // no way to name it.
  it('never publishes the method or the path to the model', () => {
    const schema = JSON.stringify(tool().inputSchema);
    expect(schema).not.toContain('method');
    expect(schema).not.toContain('customers');
  });

  it('publishes only the model-supplied parameters', () => {
    const built = tool({
      params: {
        id: { in: 'path', from: 'model', schema: { type: 'string' }, required: true },
        expand: { in: 'query', from: 'literal', value: 'contacts' },
        'x-actor': { in: 'header', from: 'context', path: 'userId' },
      },
    });
    const properties = built.inputSchema['properties'] as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(['id']);
  });

  it('adds literal query parameters and context headers', async () => {
    await tool({
      params: {
        id: { in: 'path', from: 'model', schema: { type: 'string' }, required: true },
        expand: { in: 'query', from: 'literal', value: 'contacts' },
        'x-actor': { in: 'header', from: 'context', path: 'userId' },
      },
    }).execute({ id: '7' }, CTX);

    expect(sent[0]?.url).toContain('expand=contacts');
    expect(sent[0]?.headers['x-actor']).toBe('u1');
  });

  it('merges the connection headers', async () => {
    await tool().execute({ id: '7' }, CTX);
    expect(sent[0]?.headers['x-app']).toBe('agent');
  });

  it('applies the connection credential as an Authorization header', async () => {
    await tool().execute({ id: '7' }, CTX);
    expect(sent[0]?.headers['authorization']).toBe('Bearer tok-123');
  });

  it('url-encodes a path parameter', async () => {
    await tool().execute({ id: 'a b/c' }, CTX);
    expect(sent[0]?.url).toContain('a%20b%2Fc');
  });

  // Without these two checks a path parameter is a way out of the declared
  // endpoint.
  it('refuses a path parameter containing ..', async () => {
    await expect(tool().execute({ id: '../../admin' }, CTX)).rejects.toThrow(ValidationError);
  });

  it('refuses a path parameter that is an absolute URL', async () => {
    await expect(tool().execute({ id: 'https://evil.com/x' }, CTX)).rejects.toThrow(/absolute URL/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bodies
// ─────────────────────────────────────────────────────────────────────────────

describe('http.request bodies', () => {
  const withBody: Partial<HttpRequestToolConfig> = {
    name: 'crm.addNote',
    method: 'POST',
    path: '/customers/{id}/notes',
    body: {
      template: { text: ':text', author: ':author', origin: 'agent' },
      params: {
        text: { from: 'model', schema: { type: 'string' }, required: true },
        author: { from: 'context', path: 'userId' },
      },
    },
  };

  it('fills the template by value, mixing model and context origins', async () => {
    await tool(withBody).execute({ id: '7', text: 'hello' }, CTX);

    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      text: 'hello',
      author: 'u1',
      origin: 'agent',
    });
  });

  it('sets a JSON content type', async () => {
    await tool(withBody).execute({ id: '7', text: 'hello' }, CTX);
    expect(sent[0]?.headers['content-type']).toBe('application/json');
  });

  it('publishes body parameters alongside request ones', () => {
    const properties = tool(withBody).inputSchema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['id', 'text']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

describe('http.request responses', () => {
  it('returns the parsed body', async () => {
    const result = await tool().execute({ id: '7' }, CTX);
    expect((result.data as { body: unknown }).body).toEqual({ data: { id: '7', name: 'Ada' } });
  });

  it('narrows the payload with pick, so envelopes do not cost context', async () => {
    const result = await tool({ response: { pick: 'data' } }).execute({ id: '7' }, CTX);
    expect((result.data as { body: unknown }).body).toEqual({ id: '7', name: 'Ada' });
  });

  // An HTTP error is information the model can act on; failing the whole loop
  // over a 404 helps nobody.
  it('reports a non-2xx as a failed result rather than throwing', async () => {
    respond = { status: 404, body: '{"error":"not found"}' };
    const result = await tool().execute({ id: '7' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });

  it('flags a truncated response', async () => {
    respond = { truncated: true };
    const result = await tool().execute({ id: '7' }, CTX);

    expect((result.data as { truncated?: boolean }).truncated).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Declaration checks
// ─────────────────────────────────────────────────────────────────────────────

describe('http.request declaration', () => {
  it('rejects a path placeholder with no parameter', () => {
    expect(() => tool({ path: '/customers/{ghost}' })).toThrow(/no parameter declares/);
  });

  it('rejects a path placeholder declared somewhere other than the path', () => {
    expect(() =>
      tool({
        path: '/customers/{id}',
        params: { id: { in: 'query', from: 'model', schema: { type: 'string' } } },
      }),
    ).toThrow(/"in": "path"/);
  });

  it('rejects a connection that is not an HTTP one', () => {
    const manager = new ConnectionManager({
      connections: { db: { type: 'sql', driver: 'postgres', database: 'x' } },
      credentials: new ConfigCredentialProvider(),
    });
    const local = { ...ctx, getConnection: (name: string) => manager.get(name) };

    expect(() =>
      createHttpRequestTool({ connection: 'db', method: 'GET', path: '/' }, local),
    ).toThrow(/needs an http connection/);
  });

  it('warns when a mutating operation carries no approval', () => {
    tool({ method: 'POST', path: '/customers', params: {} });
    expect(emit).toHaveBeenCalledWith(
      'security.http.mutating.unapproved',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('stays quiet for a read operation', () => {
    tool();
    expect(emit).not.toHaveBeenCalled();
  });

  // The marker the untrusted tracker uses to spot an outlet.
  it('marks mutating operations as having side effects', () => {
    expect(tool({ method: 'DELETE', path: '/customers/{id}' }).sideEffects).toBe(true);
    expect(tool().sideEffects).toBeUndefined();
  });
});
