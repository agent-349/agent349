import { EgressDeniedError, ValidationError } from '../../../errors/index.js';
import type { ExecutionContext, Tool, ToolResult, ValueBinding } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { readContextPath } from '../binding.js';
import type { OutgoingMail } from './MailTransport.js';

/** Configuration for {@link createMailSendTool}. */
export interface MailSendToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `mail` connection, when one is declared. */
  connection?: string;
  /** Description sent to the LLM. */
  description?: string;
  /**
   * Sender address. Only `literal` and `context` are accepted — never `model`.
   * Who a message appears to come from is not the model's decision.
   */
  from: Extract<ValueBinding, { from: 'literal' } | { from: 'context' }>;
  /**
   * Domains a recipient may belong to.
   *
   * This is *the* control. Without it the tool refuses to build unless
   * `allowExternalRecipients` is set, because an agent that can mail anyone is
   * an agent that can post your data anywhere.
   */
  allowedRecipientDomains?: string[];
  /** Deliberately allow any recipient domain. Emits a security event at load. */
  allowExternalRecipients?: boolean;
  /** Recipients per message, counting cc. Default `5`. */
  maxRecipients?: number;
  /** Body characters allowed. Default `20000`. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_RECIPIENTS = 5;
const DEFAULT_MAX_BODY_CHARS = 20_000;

/** A minimal, deliberately strict address check. */
const ADDRESS = /^[^\s@,;]+@([^\s@,;]+\.[^\s@,;]+)$/;

/**
 * Builds a `mail.send` tool.
 *
 * ### The risk this tool is
 * Sending is the most direct exfiltration channel an agent has: the model picks
 * the recipient and writes the body, and a document it read can ask it to send
 * something. Three guards follow from that, and the first is the one that
 * matters:
 *
 * 1. **Recipient domain allowlist.** Everything else is secondary.
 * 2. **Recipient count**, since a broadcast from an agent is rarely intended.
 * 3. **The sender is never model-supplied** — `literal` or `context` only.
 *
 * On top of that, the tool is marked `sideEffects`, so a send that happens in a
 * turn which took in untrusted content raises `security.untrusted.mutating`.
 * `requiresApproval: true` on the definition is the recommended default: the
 * action is external and cannot be undone.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} when no transport is injected, or when the
 *         recipient allowlist is neither configured nor explicitly waived.
 */
export function createMailSendTool(config: MailSendToolConfig, ctx: InternalToolContext): Tool {
  const name = config.name ?? 'mail.send';

  const transport = ctx.mailTransport;
  if (transport === undefined) {
    throw new ValidationError(
      `${name}.transport`,
      'mail.send needs a MailTransport. The SDK ships none — inject one via ' +
        'OrchestratorOverrides.mailTransport.',
    );
  }

  // Referenced only to fail early on a misdeclared connection; the transport,
  // not the connection, is what actually delivers.
  if (config.connection !== undefined) {
    const handle = ctx.getConnection(config.connection);
    if (handle.config.type !== 'mail') {
      throw new ValidationError(
        `${name}.connection`,
        `connection '${handle.name}' is of type '${handle.config.type}'; mail.send needs a mail connection`,
      );
    }
  }

  if (config.from.from !== 'literal' && config.from.from !== 'context') {
    throw new ValidationError(
      `${name}.from`,
      "the sender must be 'literal' or 'context'. Letting the model choose who a " +
        'message comes from is never correct.',
    );
  }

  const allowedDomains = (config.allowedRecipientDomains ?? []).map((domain) =>
    domain.toLowerCase().replace(/^@/, ''),
  );
  if (allowedDomains.length === 0) {
    if (config.allowExternalRecipients !== true) {
      throw new ValidationError(
        `${name}.allowedRecipientDomains`,
        'declare the recipient domains this agent may write to. To deliberately ' +
          'allow any recipient, set allowExternalRecipients: true.',
      );
    }
    ctx.emit('security.mail.unrestricted', {
      toolName: name,
      reason:
        'mail.send is declared with no recipient domain allowlist, so the agent can ' +
        'send to any address. Combined with any tool that reads external content, ' +
        'this is an exfiltration path.',
    });
  }

  const maxRecipients = config.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  const maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  return {
    name,
    description:
      config.description ??
      'Sends a plain-text email.' +
        (allowedDomains.length > 0 ? ` Recipients must be at: ${allowedDomains.join(', ')}.` : ''),
    sideEffects: true,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Recipient addresses.',
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Addresses to copy.' },
        subject: { type: 'string', maxLength: 200, description: 'Subject line.' },
        body: { type: 'string', description: 'Message body, plain text.' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    async execute(
      input: { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown },
      context: ExecutionContext,
    ): Promise<ToolResult> {
      const to = asAddresses(input?.to);
      const cc = asAddresses(input?.cc);
      const subject = typeof input?.subject === 'string' ? input.subject : '';
      const body = typeof input?.body === 'string' ? input.body : '';

      if (to.length === 0) return { success: false, error: 'No recipient was supplied.' };
      if (body.length > maxBodyChars) {
        return {
          success: false,
          error: `The body is longer than the ${maxBodyChars}-character limit.`,
        };
      }
      if (to.length + cc.length > maxRecipients) {
        return {
          success: false,
          error: `At most ${maxRecipients} recipients per message, including cc.`,
        };
      }

      for (const address of [...to, ...cc]) {
        const domain = ADDRESS.exec(address)?.[1]?.toLowerCase();
        if (domain === undefined) {
          return { success: false, error: `'${address}' is not a valid email address.` };
        }
        if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
          ctx.emit('security.egress.denied', {
            toolName: name,
            destination: address,
            control: 'allowed-recipient-domains',
          });
          const denied = new EgressDeniedError(
            address,
            'allowed-recipient-domains',
            `Cannot send to '${address}': only ${allowedDomains.join(', ')} are allowed.`,
          );
          return { success: false, error: denied.message };
        }
      }

      const from = resolveSender(config.from, context);
      if (from === null) {
        return { success: false, error: 'The sender address could not be determined.' };
      }

      const message: OutgoingMail = {
        from,
        to,
        ...(cc.length > 0 && { cc }),
        subject,
        body,
      };

      try {
        const sent = await transport.send(message, context);
        return {
          success: true,
          data: {
            sent: true,
            to,
            ...(cc.length > 0 && { cc }),
            ...(sent.messageId !== undefined && { messageId: sent.messageId }),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `The message could not be sent: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/** Normalises the model's recipient list into trimmed strings. */
function asAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Resolves the sender from configuration or the execution context. */
function resolveSender(
  binding: Extract<ValueBinding, { from: 'literal' } | { from: 'context' }>,
  context: ExecutionContext,
): string | null {
  const value = binding.from === 'literal' ? binding.value : readContextPath(context, binding.path);
  return typeof value === 'string' && value !== '' ? value : null;
}
