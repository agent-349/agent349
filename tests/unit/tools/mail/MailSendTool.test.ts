import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMailSendTool } from '../../../../src/tools/builtin/mail/MailSendTool.js';
import { MailTransport } from '../../../../src/tools/builtin/mail/MailTransport.js';
import type { OutgoingMail } from '../../../../src/tools/builtin/mail/MailTransport.js';
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
  metadata: { mailbox: 'ada@company.com' },
};

class RecordingTransport extends MailTransport {
  override readonly name = 'recording';
  readonly sent: OutgoingMail[] = [];
  seenUser: string | null = null;
  failWith: Error | null = null;

  override async send(
    message: OutgoingMail,
    context: ExecutionContext,
  ): Promise<{ messageId?: string }> {
    if (this.failWith !== null) throw this.failWith;
    this.sent.push(message);
    this.seenUser = context.userId;
    return { messageId: 'mid-1' };
  }
}

let transport: RecordingTransport;
let emit: ReturnType<typeof vi.fn>;
let ctx: InternalToolContext;

beforeEach(() => {
  transport = new RecordingTransport();
  emit = vi.fn();
  ctx = { emit, mailTransport: transport } as unknown as InternalToolContext;
});

function tool(overrides: Record<string, unknown> = {}) {
  return createMailSendTool(
    {
      name: 'mail.send',
      from: { from: 'literal', value: 'agent@company.com' },
      allowedRecipientDomains: ['company.com'],
      ...overrides,
    },
    ctx,
  );
}

const MESSAGE = { to: ['ada@company.com'], subject: 'Hi', body: 'Report attached.' };

// ─────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────

describe('mail.send', () => {
  it('hands the message to the transport', async () => {
    const result = await tool().execute(MESSAGE, CTX);

    expect(result.success).toBe(true);
    expect(transport.sent[0]).toMatchObject({
      from: 'agent@company.com',
      to: ['ada@company.com'],
      subject: 'Hi',
    });
  });

  it('returns the provider message id', async () => {
    const result = await tool().execute(MESSAGE, CTX);
    expect((result.data as { messageId?: string }).messageId).toBe('mid-1');
  });

  // So a transport that sends through the acting user's mailbox can.
  it('passes the execution context to the transport', async () => {
    await tool().execute(MESSAGE, CTX);
    expect(transport.seenUser).toBe('u1');
  });

  it('resolves a context-bound sender', async () => {
    await tool({ from: { from: 'context', path: 'metadata.mailbox' } }).execute(MESSAGE, CTX);
    expect(transport.sent[0]?.from).toBe('ada@company.com');
  });

  it('reports a transport failure as a failed result', async () => {
    transport.failWith = new Error('smtp down');
    const result = await tool().execute(MESSAGE, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('smtp down');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exfiltration controls
// ─────────────────────────────────────────────────────────────────────────────

describe('mail.send guards', () => {
  // The control that matters. Everything else is secondary.
  it('refuses a recipient outside the allowed domains', async () => {
    const result = await tool().execute({ ...MESSAGE, to: ['attacker@evil.com'] }, CTX);

    expect(result.success).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('checks cc recipients too', async () => {
    const result = await tool().execute({ ...MESSAGE, cc: ['attacker@evil.com'] }, CTX);
    expect(result.success).toBe(false);
  });

  it('emits security.egress.denied on a refused recipient', async () => {
    await tool().execute({ ...MESSAGE, to: ['attacker@evil.com'] }, CTX);

    expect(emit).toHaveBeenCalledWith(
      'security.egress.denied',
      expect.objectContaining({ control: 'allowed-recipient-domains' }),
    );
  });

  it('refuses a malformed address', async () => {
    const result = await tool().execute({ ...MESSAGE, to: ['not-an-address'] }, CTX);
    expect(result.success).toBe(false);
  });

  it('caps the number of recipients', async () => {
    const many = Array.from({ length: 6 }, (_, i) => `p${i}@company.com`);
    const result = await tool({ maxRecipients: 3 }).execute({ ...MESSAGE, to: many }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at most 3/i);
  });

  it('counts cc against the recipient cap', async () => {
    const result = await tool({ maxRecipients: 2 }).execute(
      { ...MESSAGE, to: ['a@company.com', 'b@company.com'], cc: ['c@company.com'] },
      CTX,
    );
    expect(result.success).toBe(false);
  });

  it('caps the body length', async () => {
    const result = await tool({ maxBodyChars: 10 }).execute(
      { ...MESSAGE, body: 'x'.repeat(50) },
      CTX,
    );
    expect(result.success).toBe(false);
  });

  it('requires at least one recipient', async () => {
    const result = await tool().execute({ ...MESSAGE, to: [] }, CTX);
    expect(result.success).toBe(false);
  });

  // Who a message appears to come from is never the model's decision, so the
  // field must not be in the schema at all.
  it('never publishes the sender to the model', () => {
    expect(JSON.stringify(tool().inputSchema)).not.toContain('from');
  });

  // The marker the untrusted tracker watches for.
  it('is marked as having side effects', () => {
    expect(tool().sideEffects).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Declaration
// ─────────────────────────────────────────────────────────────────────────────

describe('mail.send declaration', () => {
  it('refuses to build without a transport', () => {
    const bare = { emit } as unknown as InternalToolContext;
    expect(() => createMailSendTool({ from: { from: 'literal', value: 'a@b.com' } }, bare)).toThrow(
      /MailTransport/,
    );
  });

  it('says the SDK ships no transport of its own', () => {
    const bare = { emit } as unknown as InternalToolContext;
    expect(() => createMailSendTool({ from: { from: 'literal', value: 'a@b.com' } }, bare)).toThrow(
      /ships none/,
    );
  });

  // Not a default anyone should fall into by omission.
  it('refuses to build with no recipient allowlist unless waived', () => {
    expect(() => tool({ allowedRecipientDomains: [] })).toThrow(ValidationError);
  });

  it('allows an explicit waiver, and says so loudly', () => {
    tool({ allowedRecipientDomains: [], allowExternalRecipients: true });

    expect(emit).toHaveBeenCalledWith(
      'security.mail.unrestricted',
      expect.objectContaining({ toolName: 'mail.send' }),
    );
  });

  it('refuses a model-supplied sender', () => {
    expect(() => tool({ from: { from: 'model', schema: { type: 'string' } } })).toThrow(
      /never correct/,
    );
  });

  it('names the allowed domains in its description', () => {
    expect(tool().description).toContain('company.com');
  });
});
