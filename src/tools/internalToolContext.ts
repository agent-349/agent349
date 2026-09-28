import type { ExecutionContext } from '../types/index.js';
import type { ConnectionHandle } from '../connections/types.js';
import type { Credential } from '../credentials/types.js';
import type { RAGPipeline } from '../rag/RAGPipeline.js';
import type { RAGToolDefaults } from '../rag/RAGTool.js';
import type { DocumentStore } from './builtin/doc/DocumentStore.js';
import type { MailTransport } from './builtin/mail/MailTransport.js';

/**
 * Services the Orchestrator exposes to internal tool factories so they can be
 * wired against live subsystems without the config layer knowing the details.
 */
export interface InternalToolContext {
  /** Lazily builds (or returns) the configured RAG pipeline. */
  getRAGPipeline: () => RAGPipeline;
  /** Default retrieval parameters from `SDKConfig.rag.retrieval`. */
  ragRetrievalDefaults: RAGToolDefaults;
  /**
   * Resolves a named connection from the `connections` section (or an injected
   * one) to a handle.
   *
   * Called while the tool is being built, so a connection renamed in the config
   * fails at load time rather than on the first query. Nothing is opened here —
   * the handle opens its resource on first use.
   *
   * @throws {@link import('../errors/index.js').ConfigError} for an unknown name.
   */
  getConnection: (name: string) => ConnectionHandle;
  /**
   * Resolves a credential reference for the execution at hand.
   *
   * Most tools reach credentials through their {@link ConnectionHandle}; this
   * is for the ones that need a reference their connection does not carry.
   */
  getCredential: (ref: string, context: ExecutionContext) => Promise<Credential>;
  /**
   * Event sink, wired to the EventBus.
   *
   * Used for the load-time `security.*` warnings: a dangerous configuration is
   * allowed, but never silently. The integrator can live with the event; they
   * cannot say they were not told.
   */
  emit: (event: string, data: Record<string, unknown>) => void;
  /**
   * Document stores injected by the host, keyed by the name `doc.read` sources
   * refer to. Absent when the host injected none.
   */
  documentStores?: Record<string, DocumentStore>;
  /**
   * Mail transport injected by the host. `mail.send` refuses to build without
   * one: the SDK ships no transport of its own.
   */
  mailTransport?: MailTransport;
}
