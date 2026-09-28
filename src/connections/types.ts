import type { ExecutionContext, ResourceLimits } from '../types/index.js';
import type { Credential, CredentialSpec } from '../credentials/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue — relations exposed to the model
// ─────────────────────────────────────────────────────────────────────────────

/** One column of a {@link RelationDescriptor}. */
export interface ColumnDescriptor {
  /** Column name exactly as the engine spells it. */
  name: string;
  /** Engine type, for the model's benefit (e.g. `'date'`, `'numeric'`). */
  type?: string;
  /** What the column means. Worth writing: this is what grounds the model. */
  description?: string;
}

/**
 * A relation (table, view, collection) the model is allowed to query.
 *
 * This declaration does double duty: it is the **allowlist** enforced on
 * model-authored queries, and the **grounding** served by the `*.schema`
 * tools. Declaring curated views here — rather than raw transactional tables —
 * is what makes natural-language querying accurate.
 */
export interface RelationDescriptor {
  /** Relation name as used in a query. */
  name: string;
  /** What one row represents, and what it excludes. */
  description?: string;
  /** Columns/fields, described for the model. */
  columns?: ColumnDescriptor[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection configs
// ─────────────────────────────────────────────────────────────────────────────

/** Fields shared by every connection type. */
export interface ConnectionConfigBase {
  /** Credential reference, or inline material for simple static cases. */
  credential?: CredentialSpec;
  /**
   * Ceiling for every tool using this connection. A tool may lower these,
   * never raise them.
   */
  limits?: ResourceLimits;
}

/** Pool sizing for connections that hold one. */
export interface ConnectionPoolConfig {
  /** Maximum simultaneous connections. */
  max?: number;
  /** Idle connection lifetime, in milliseconds. */
  idleTimeoutMs?: number;
}

/** A relational database connection. */
export interface SqlConnectionConfig extends ConnectionConfigBase {
  type: 'sql';
  /** Driver id; a matching {@link ConnectionDriver} must be registered. */
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  /** Full connection string, as an alternative to the discrete fields. */
  url?: string;
  pool?: ConnectionPoolConfig;
  /** Relations exposed to the model — allowlist and grounding both. */
  relations?: RelationDescriptor[];
  /**
   * The integrator's assertion that this connection authenticates as a
   * read-only user with permissions scoped to `relations`.
   *
   * The SDK cannot verify it, and treats it as a declaration: leaving it unset
   * on a free-form query tool emits `security.sql.unrestricted`. The syntactic
   * guards are defence in depth — this is the actual guarantee.
   */
  readOnlyUser?: boolean;
}

/** A MongoDB connection. */
export interface MongoConnectionConfig extends ConnectionConfigBase {
  type: 'mongo';
  /** Connection URI. */
  url?: string;
  /** Database name. */
  database?: string;
  pool?: ConnectionPoolConfig;
  /** Collections exposed to the model — allowlist and grounding both. */
  relations?: RelationDescriptor[];
  /** Assertion that the connection authenticates with a read-only role. */
  readOnlyUser?: boolean;
}

/** An HTTP endpoint an `http.request` tool targets. */
export interface HttpConnectionConfig extends ConnectionConfigBase {
  type: 'http';
  /** Base URL every declared operation is resolved against. */
  baseUrl: string;
  /** Headers added to every request (credentials do not belong here). */
  headers?: Record<string, string>;
  /**
   * Whether to follow redirects. Default `false`: a `302` to another host is
   * the classic way around an egress allowlist.
   */
  followRedirects?: boolean;
  /** Maximum redirects to follow when enabled. */
  maxRedirects?: number;
  /** Hosts reachable beyond `baseUrl`'s own, used when following redirects. */
  allowedHosts?: string[];
  /**
   * Refuse private, loopback and link-local destinations — resolving DNS,
   * checking every address, and pinning the connection to the checked one —
   * the same chain `web.read` applies.
   *
   * Default `false`: an endpoint the integrator declared may legitimately be an
   * internal service. Set it when the `baseUrl` comes from someone who is *not*
   * the integrator (an application user configuring an integration at runtime),
   * so the connection cannot be pointed at the metadata endpoint or the
   * intranet.
   */
  blockPrivateAddresses?: boolean;
}

/** A mail connection. In v1 the transport is always host-injected. */
export interface MailConnectionConfig extends ConnectionConfigBase {
  type: 'mail';
  /**
   * Transport selector. Only `'injected'` exists in v1: the SDK ships no
   * built-in transport, since that would require a new dependency and every
   * host that wants this tool already has a configured mailer.
   */
  transport: 'injected';
}

/** Any declared connection, discriminated by `type`. */
export type ConnectionConfig =
  | SqlConnectionConfig
  | MongoConnectionConfig
  | HttpConnectionConfig
  | MailConnectionConfig;

/** The `connections` config section. */
export type ConnectionsConfig = Record<string, ConnectionConfig>;

/** Discriminator values of {@link ConnectionConfig}. */
export type ConnectionType = ConnectionConfig['type'];

// ─────────────────────────────────────────────────────────────────────────────
// Drivers and handles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens and closes the live resource behind a stateful connection.
 *
 * Drivers are registered per id and resolved from the connection's `driver`
 * field (or its `type`, for engines with a single driver). The SDK ships none
 * in this phase: a database driver arrives with the tool that needs it, as an
 * optional dependency loaded dynamically.
 */
export abstract class ConnectionDriver<TResource = unknown> {
  /** Driver id, matched against `SqlConnectionConfig.driver`. */
  abstract readonly name: string;

  /**
   * Opens the resource (typically a pool).
   *
   * @param config     - The connection's declared configuration.
   * @param credential - Resolved credential, `{ kind: 'none' }` if undeclared.
   * @returns The live resource, handed to tools untouched.
   */
  abstract open(config: ConnectionConfig, credential: Credential): Promise<TResource>;

  /**
   * Releases the resource. Must not throw: it runs during shutdown, where one
   * bad connection must not prevent the others from closing.
   *
   * @param resource - The resource previously returned by {@link open}.
   */
  abstract close(resource: TResource): Promise<void>;
}

/**
 * A tool's view of a connection: its declared config, its live resource, and
 * its credential for the execution at hand.
 *
 * Opening is lazy. Building the Orchestrator must not require every declared
 * database to be reachable, and a connection no tool uses is never opened.
 */
export interface ConnectionHandle<TResource = unknown> {
  /** Name of the connection, as keyed in the config. */
  readonly name: string;
  /** The declared configuration. */
  readonly config: ConnectionConfig;

  /**
   * Returns the live resource, opening it on first use.
   *
   * Concurrent callers share one opening attempt; a failed attempt is not
   * cached, so the next call retries.
   *
   * @param context - Context of the execution needing the resource.
   * @throws {@link import('../errors/index.js').ConnectionError} when no driver
   *         is registered, or the resource cannot be opened.
   */
  resource(context: ExecutionContext): Promise<TResource>;

  /**
   * Resolves this connection's credential for the given execution.
   *
   * Called per execution rather than cached, so a provider can hand back a
   * freshly refreshed or per-user credential.
   *
   * @param context - Context of the execution needing the credential.
   * @returns `{ kind: 'none' }` when the connection declares no credential.
   */
  credential(context: ExecutionContext): Promise<Credential>;

  /**
   * The driver registered for this connection.
   *
   * Tools need it even when the resource was injected by the host: the resource
   * is an opaque pool, and the driver is what knows how to run a query on it.
   *
   * @throws {@link import('../errors/index.js').ConnectionError} when the
   *         connection type has no driver, or none is registered for its id.
   */
  driver(): ConnectionDriver;
}

/**
 * A connection the host opened itself and hands to the SDK.
 *
 * Takes priority over a declared entry of the same name. The host keeps
 * ownership: `Orchestrator.shutdown()` closes only what the SDK opened.
 */
export interface InjectedConnection<TResource = unknown> {
  /** The live resource (a pool, a client), passed to tools as-is. */
  resource: TResource;
  /**
   * Descriptive configuration — limits, relations, base URL.
   *
   * Required when no `connections` entry of the same name exists; when one
   * does, this is merged over it.
   */
  config?: ConnectionConfig;
}
