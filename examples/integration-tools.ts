/**
 * Integration tools, end to end.
 *
 * Wires an agent that can query a database, call a declared API endpoint, read
 * a document and send mail — declaring everything in config, and injecting only
 * what the SDK deliberately does not own: credentials with a lifecycle, a mail
 * transport, and a document store that applies the host's access control.
 *
 * Run with `npx tsx examples/integration-tools.ts` (no services required: it
 * builds the agent, prints what was registered, and shuts down).
 */
import {
  ConfigLoader,
  CredentialProvider,
  DocumentStore,
  MailTransport,
  Orchestrator,
  PostgresDriver,
} from '../src/index.js';
import type { Credential, ExecutionContext, FetchedDocument, OutgoingMail } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Configuration — connections and tools, all declarative
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  connections: {
    // Read-only user, scoped to the exposed views: this is the real guarantee,
    // not the syntactic guards.
    erp: {
      type: 'sql' as const,
      driver: 'postgres',
      host: 'db.internal',
      database: 'erp',
      credential: { ref: 'erp-readonly' },
      readOnlyUser: true,
      limits: { maxRows: 200, timeoutMs: 15_000 },
      // Curated views, described for the model. One declaration doing two
      // jobs: the allowlist, and the grounding that makes text-to-SQL work.
      relations: [
        {
          name: 'v_sales',
          description: 'One row per confirmed sale. Excludes quotes and cancellations.',
          columns: [
            { name: 'date', type: 'date', description: 'Confirmation date' },
            { name: 'customer_id', type: 'integer', description: 'FK to v_customers.id' },
            { name: 'amount', type: 'numeric', description: 'Net amount, before tax' },
          ],
        },
        { name: 'v_customers', description: 'Active customers.' },
      ],
    },

    crm: {
      type: 'http' as const,
      baseUrl: 'https://crm.internal/api/v2',
      credential: { ref: 'crm-oauth' },
      followRedirects: false,
    },

    corpMail: { type: 'mail' as const, transport: 'injected' as const },
  },

  tools: {
    definitions: [
      // Declared query: the model fills only the date, never the customer.
      {
        name: 'sales.byCustomer',
        kind: 'internal' as const,
        ref: 'sql.query',
        config: {
          connection: 'erp',
          description: 'Confirmed sales for the current customer from a given date.',
          statement:
            'SELECT date, amount FROM v_sales WHERE customer_id = :customerId AND date >= :from ORDER BY date DESC',
          params: {
            customerId: { from: 'context', path: 'metadata.customerId', required: true },
            from: {
              from: 'model',
              required: true,
              schema: { type: 'string', format: 'date' },
              description: 'Start date, YYYY-MM-DD',
            },
          },
        },
      },

      // The text-to-SQL pair: catalogue first, free-form query second.
      {
        name: 'erp.schema',
        kind: 'internal' as const,
        ref: 'sql.schema',
        config: { connection: 'erp' },
      },
      {
        name: 'erp.query',
        kind: 'internal' as const,
        ref: 'sql.query',
        config: { connection: 'erp', mode: 'freeform' },
      },

      // One declared operation, one fixed verb.
      {
        name: 'crm.findCustomer',
        kind: 'internal' as const,
        ref: 'http.request',
        config: {
          connection: 'crm',
          method: 'GET',
          path: '/customers/{id}',
          description: 'Looks up a CRM customer by id.',
          params: {
            id: { in: 'path', from: 'model', required: true, schema: { type: 'string' } },
            'X-Actor': { in: 'header', from: 'context', path: 'userId' },
          },
          response: { pick: 'data' },
        },
      },

      // Documents come from the host's own store, which checks permissions.
      {
        name: 'doc.read',
        kind: 'internal' as const,
        ref: 'doc.read',
        config: { sources: [{ name: 'attachments', kind: 'store' }] },
      },

      // External and irreversible: approval on, recipients fenced in.
      {
        name: 'mail.send',
        kind: 'internal' as const,
        ref: 'mail.send',
        requiresApproval: true,
        config: {
          connection: 'corpMail',
          from: { from: 'literal', value: 'agent@company.com' },
          allowedRecipientDomains: ['company.com'],
          maxRecipients: 3,
        },
      },
    ],
  },

  agents: [
    {
      id: 'analyst',
      name: 'Sales analyst',
      systemPrompt:
        'You answer questions about sales. Call erp.schema before writing SQL. ' +
        'Never present a truncated result as a total.',
      skills: [],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. What the host injects — the state the SDK declines to own
// ─────────────────────────────────────────────────────────────────────────────

/** Credentials with a lifecycle: refresh, rotation, encryption at rest. */
class HostCredentials extends CredentialProvider {
  readonly name = 'host';

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(ref: string, context: ExecutionContext): Promise<Credential> {
    // `context` is what makes per-user OAuth expressible — a service-account
    // provider simply ignores it.
    if (ref === 'crm-oauth') {
      return { kind: 'bearer', token: `token-for-${context.userId}` };
    }
    return { kind: 'basic', username: 'agent_ro', password: process.env['ERP_PASSWORD'] ?? '' };
  }
}

/** The host's document store, applying its own access control. */
class AttachmentStore extends DocumentStore {
  readonly name = 'attachments';

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetch(ref: string, _context: ExecutionContext): Promise<FetchedDocument> {
    // A real implementation checks `_context` against its ACL before returning.
    return { bytes: Buffer.from('example document'), mimeType: 'text/plain', fileName: ref };
  }
}

/** The host's mailer. The SDK ships no transport of its own, by design. */
class HostMailer extends MailTransport {
  readonly name = 'host-mailer';

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: OutgoingMail): Promise<{ messageId?: string }> {
    process.stdout.write(`  [mail] would send "${message.subject}" to ${message.to.join(', ')}\n`);
    return { messageId: 'example-1' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Wiring
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // `fromConfig` takes a fully-resolved config, so the declarative sections are
  // merged over the SDK defaults first.
  const orch = await Orchestrator.fromConfig(ConfigLoader.from(config as never).get(), {
    credentialProvider: new HostCredentials(),
    documentStores: { attachments: new AttachmentStore() },
    mailTransport: new HostMailer(),
  });

  // Security events are the whole enforcement story for provenance, and the
  // load-time warnings are how a dangerous configuration stays visible.
  orch.events.on('security.untrusted.inflow', () => {
    process.stdout.write('  [security] untrusted content entered this turn\n');
  });
  orch.events.on('security.untrusted.mutating', (event) => {
    process.stdout.write(`  [security] outlet ran in a tainted turn: ${JSON.stringify(event)}\n`);
  });

  // Drivers arrive with the tools that need them. `pg` is not an SDK
  // dependency: install it in the host to use this one.
  orch.connections.registerDriver(new PostgresDriver());

  process.stdout.write('Registered tools:\n');
  for (const name of orch.toolRegistry.list()) {
    const tool = orch.toolRegistry.get(name);
    const marks = [
      tool?.requiresApproval === true ? 'approval' : null,
      tool?.sideEffects === true ? 'side-effects' : null,
    ].filter((mark) => mark !== null);
    process.stdout.write(`  - ${name}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}\n`);
  }

  process.stdout.write(`\nConnections declared: ${orch.connections.names().join(', ')}\n`);
  process.stdout.write('None are open: they connect on first use.\n');

  await orch.shutdown();
}

await main();
