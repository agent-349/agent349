import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { INTERNAL_TOOL_IDS } from '../../../src/tools/internalTools.js';
import { MailTransport } from '../../../src/tools/builtin/mail/MailTransport.js';
import type { OutgoingMail } from '../../../src/tools/builtin/mail/MailTransport.js';

class NoopTransport extends MailTransport {
  override readonly name = 'noop';

  override async send(_message: OutgoingMail): Promise<{ messageId?: string }> {
    return { messageId: 'x' };
  }
}

const CONFIG = {
  connections: {
    erp: {
      type: 'sql',
      driver: 'postgres',
      database: 'erp',
      readOnlyUser: true,
      relations: [{ name: 'v_sales', columns: [{ name: 'amount' }] }],
    },
    ops: {
      type: 'mongo',
      url: 'mongodb://localhost:27017',
      database: 'ops',
      readOnlyUser: true,
      relations: [{ name: 'tickets' }],
    },
    crm: { type: 'http', baseUrl: 'https://crm.internal/api' },
    corpMail: { type: 'mail', transport: 'injected' },
  },
  tools: {
    definitions: [
      {
        name: 'sales.byCustomer',
        kind: 'internal',
        ref: 'sql.query',
        config: {
          connection: 'erp',
          statement: 'SELECT amount FROM v_sales WHERE id = :id',
          params: { id: { from: 'context', path: 'metadata.id', required: true } },
        },
      },
      { name: 'erp.schema', kind: 'internal', ref: 'sql.schema', config: { connection: 'erp' } },
      {
        name: 'tickets.open',
        kind: 'internal',
        ref: 'mongo.query',
        config: { connection: 'ops', collection: 'tickets', filter: { status: 'open' } },
      },
      { name: 'ops.schema', kind: 'internal', ref: 'mongo.schema', config: { connection: 'ops' } },
      {
        name: 'crm.findCustomer',
        kind: 'internal',
        ref: 'http.request',
        config: {
          connection: 'crm',
          method: 'GET',
          path: '/customers/{id}',
          params: { id: { in: 'path', from: 'model', schema: { type: 'string' }, required: true } },
        },
      },
      {
        name: 'web.read',
        kind: 'internal',
        ref: 'web.read',
        config: { allowedDomains: ['*.example.com'] },
      },
      {
        name: 'feed.read',
        kind: 'internal',
        ref: 'feed.read',
        config: { allowedDomains: ['*.example.com'], conditionalRequests: true },
      },
      {
        name: 'doc.read',
        kind: 'internal',
        ref: 'doc.read',
        config: { sources: [{ name: 'manuals', kind: 'fs', root: './docs' }] },
      },
      {
        name: 'file.read',
        kind: 'internal',
        ref: 'file.read',
        config: { roots: [{ name: 'logs', path: './logs' }], maxBytes: 65536 },
      },
      {
        name: 'mail.send',
        kind: 'internal',
        ref: 'mail.send',
        requiresApproval: true,
        config: {
          connection: 'corpMail',
          from: { from: 'literal', value: 'agent@company.com' },
          allowedRecipientDomains: ['company.com'],
        },
      },
    ],
  },
};

async function build(): Promise<Orchestrator> {
  return Orchestrator.fromConfig(ConfigLoader.from(CONFIG as never).get(), {
    mailTransport: new NoopTransport(),
  });
}

describe('every integration tool, declared in JSON', () => {
  it('exposes every internal ref', () => {
    expect([...INTERNAL_TOOL_IDS].sort()).toEqual([
      'doc.read',
      'feed.read',
      'file.read',
      'http.request',
      'mail.send',
      'mongo.query',
      'mongo.schema',
      'rag.search',
      'sql.query',
      'sql.schema',
      'web.read',
    ]);
  });

  it('rejects an http connection whose blockPrivateAddresses is not a boolean', () => {
    const broken = {
      connections: {
        api: { type: 'http', baseUrl: 'https://api.example.com', blockPrivateAddresses: 'yes' },
      },
    };
    expect(() => ConfigLoader.from(broken as never).get()).toThrow(/blockPrivateAddresses/);
  });

  it('builds every tool from the config file', async () => {
    const orch = await build();

    for (const name of [
      'sales.byCustomer',
      'erp.schema',
      'tickets.open',
      'ops.schema',
      'crm.findCustomer',
      'web.read',
      'feed.read',
      'doc.read',
      'file.read',
      'mail.send',
    ]) {
      expect(orch.toolRegistry.get(name), name).toBeDefined();
    }

    await orch.shutdown();
  });

  it('carries requiresApproval through from the definition', async () => {
    const orch = await build();
    expect(orch.toolRegistry.get('mail.send')?.requiresApproval).toBe(true);
    await orch.shutdown();
  });

  // What the untrusted tracker keys on: mail.send is an outlet, web.read an
  // inlet. Neither can see the other; the tracker sees both.
  it('marks the outlets and leaves the readers unmarked', async () => {
    const orch = await build();

    expect(orch.toolRegistry.get('mail.send')?.sideEffects).toBe(true);
    expect(orch.toolRegistry.get('crm.findCustomer')?.sideEffects).toBeUndefined();
    expect(orch.toolRegistry.get('web.read')?.sideEffects).toBeUndefined();

    await orch.shutdown();
  });

  it('opens no connection while building tools', async () => {
    const orch = await build();
    // Nothing above registered a driver, so any eager open would have thrown.
    expect(orch.connections.names().sort()).toEqual(['corpMail', 'crm', 'erp', 'ops']);
    await orch.shutdown();
  });

  it('fails to load when a tool points at an unknown connection', async () => {
    const broken = {
      ...CONFIG,
      tools: {
        definitions: [
          {
            name: 't',
            kind: 'internal',
            ref: 'http.request',
            config: { connection: 'ghost', method: 'GET', path: '/' },
          },
        ],
      },
    };

    await expect(Orchestrator.fromConfig(ConfigLoader.from(broken as never).get())).rejects.toThrow(
      /ghost/,
    );
  });
});
