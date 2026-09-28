import type { ExecutionContext } from '../../../types/index.js';

/** A message handed to a transport for delivery. */
export interface OutgoingMail {
  /** Sender address, fixed by configuration or taken from the context. */
  from: string;
  /** Recipients, already checked against the domain allowlist. */
  to: string[];
  /** Carbon copies, checked the same way. */
  cc?: string[];
  /** Subject line. */
  subject: string;
  /** Plain-text body. */
  body: string;
}

/**
 * Sends mail on behalf of an agent.
 *
 * ### Why the SDK ships no implementation
 * A built-in SMTP transport would mean a new dependency, and any application
 * that wants an agent to send mail already has a configured mailer — with its
 * queue, its retries and its verified sender. Reimplementing that inside the
 * SDK adds surface without adding capability. The contract lives here; the
 * implementation is the host's, injected via
 * `OrchestratorOverrides.mailTransport`.
 *
 * It is the same shape as `CredentialProvider`: the SDK defines the seam and
 * declines to own the state behind it.
 *
 * `send()` receives the {@link ExecutionContext}, so a transport that sends
 * through the acting user's own mailbox can.
 *
 * @example
 * ```typescript
 * class NodemailerTransport extends MailTransport {
 *   readonly name = 'corporate-smtp';
 *
 *   async send(message: OutgoingMail): Promise<{ messageId?: string }> {
 *     const info = await this.transporter.sendMail(message);
 *     return { messageId: info.messageId };
 *   }
 * }
 *
 * await Orchestrator.fromConfig(config, { mailTransport: new NodemailerTransport() });
 * ```
 */
export abstract class MailTransport {
  /** Transport id, for diagnostics. */
  abstract readonly name: string;

  /**
   * Delivers one message.
   *
   * @param message - The message, already validated by the tool.
   * @param context - Execution context of the agent turn that produced it.
   * @returns The provider's message id, when it returns one.
   */
  abstract send(message: OutgoingMail, context: ExecutionContext): Promise<{ messageId?: string }>;
}
