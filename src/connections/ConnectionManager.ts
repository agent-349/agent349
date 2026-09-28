import { ConfigError, ConnectionError } from '../errors/index.js';
import type { ExecutionContext } from '../types/index.js';
import type { CredentialProvider } from '../credentials/CredentialProvider.js';
import type { Credential, CredentialSpec } from '../credentials/types.js';
import type {
  ConnectionConfig,
  ConnectionDriver,
  ConnectionHandle,
  ConnectionsConfig,
  InjectedConnection,
} from './types.js';

/** Event sink, wired to the EventBus by the Orchestrator. */
type Emit = (event: string, data: Record<string, unknown>) => void;

/**
 * Whether two declarations describe the same connection.
 *
 * Structural, order-insensitive comparison. A cheap `JSON.stringify` would
 * report a difference for the same connection rebuilt with its keys in another
 * order — which is exactly what a host does when it reassembles the config from
 * a database row on every request.
 */
function sameConfig(a: ConnectionConfig | undefined, b: ConnectionConfig): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  return deepEqual(a as unknown, b as unknown);
}

/** Structural equality for plain config values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => key in rb && deepEqual(ra[key], rb[key]));
}

/** Constructor options for {@link ConnectionManager}. */
export interface ConnectionManagerOptions {
  /** The `connections` config section. */
  connections?: ConnectionsConfig;
  /** Resolver for credential references. */
  credentials: CredentialProvider;
  /** Host-opened connections, keyed by name. Take priority over declared ones. */
  injected?: Record<string, InjectedConnection>;
  /** Drivers available for opening stateful connections, keyed by driver id. */
  drivers?: Record<string, ConnectionDriver>;
  /** Event sink for lifecycle diagnostics. */
  emit?: Emit;
}

/**
 * Owns the named connections declared in config and the ones injected by the
 * host, and hands tools a {@link ConnectionHandle} for each.
 *
 * ### Lazy by construction
 * Nothing is opened here. A connection opens on the first `resource()` call
 * and stays open until {@link close}. Two consequences, both deliberate:
 * building an Orchestrator never requires the databases to be reachable, and a
 * connection no tool ends up using is never opened at all.
 *
 * ### Ownership
 * Only resources this manager opened are closed by {@link close}. An injected
 * connection belongs to the host — the same rule the Orchestrator already
 * applies to injected audit stores.
 *
 * @example
 * ```typescript
 * const manager = new ConnectionManager({
 *   connections: { erp: { type: 'sql', driver: 'postgres', database: 'erp' } },
 *   credentials: new ConfigCredentialProvider(cfg.credentials),
 *   drivers: { postgres: new PostgresDriver() },
 * });
 *
 * const handle = manager.get('erp');
 * const pool = await handle.resource(context);  // opens here, once
 * ```
 */
export class ConnectionManager {
  readonly #configs: Record<string, ConnectionConfig>;
  readonly #credentials: CredentialProvider;
  readonly #injected: Record<string, InjectedConnection>;
  readonly #drivers: Map<string, ConnectionDriver>;
  readonly #emit: Emit;

  /** Resources this manager opened, and therefore must close. */
  readonly #owned = new Map<string, { resource: unknown; driver: ConnectionDriver }>();
  /** In-flight opens, so concurrent callers share one attempt. */
  readonly #opening = new Map<string, Promise<unknown>>();
  /** Handles are stable per name: tools may hold on to them. */
  readonly #handles = new Map<string, ConnectionHandle>();

  #closed = false;

  /**
   * @param options - Declared connections, credential provider, injected
   *                  connections, drivers, and the event sink.
   */
  constructor(options: ConnectionManagerOptions) {
    // Copied, not aliased: `register()` mutates this map and the caller's
    // config object must not change underneath them.
    this.#configs = { ...(options.connections ?? {}) };
    this.#credentials = options.credentials;
    this.#injected = options.injected ?? {};
    this.#drivers = new Map(Object.entries(options.drivers ?? {}));
    this.#emit = options.emit ?? ((): void => {});
  }

  /**
   * Registers a driver, making connections that name it openable.
   *
   * Drivers arrive with the tools that need them, so registration happens
   * after construction. Re-registering an id replaces the previous driver.
   *
   * @param driver - The driver; its `name` is the id matched against config.
   */
  registerDriver(driver: ConnectionDriver): void {
    this.#drivers.set(driver.name, driver);
  }

  /**
   * Declares a connection after construction, or replaces one already declared.
   *
   * Connections normally arrive with the config, but a host whose data sources
   * are created at runtime — one per tenant, per project, per content item —
   * has no config file to put them in. Registering is cheap and opens nothing:
   * the connection still opens lazily on its first use.
   *
   * Replacing a name closes the resource this manager had opened for it, so a
   * connection that now points somewhere else cannot keep serving queries from
   * the old pool. An **injected** connection of the same name is untouched:
   * it belongs to the host, and it still wins when {@link get} resolves.
   *
   * **Re-registering an identical config does nothing.** A host that calls this
   * on a request path — to make sure a runtime connection exists before using
   * it — would otherwise close and reopen the pool on every call, and worse,
   * close it out from under a query already in flight. Comparing the
   * declaration is what makes the call safe to repeat.
   *
   * @param name   - Key the tools reference.
   * @param config - The connection.
   * @throws {@link ConfigError} after {@link close} — a closed manager opens
   *         nothing, so registering would silently do nothing.
   *
   * @example
   * ```typescript
   * await orch.connections.register(`tenant_${id}`, {
   *   type: 'sql', driver: 'postgres', database: `t_${id}`,
   *   credential: { ref: `tenant:${id}` }, readOnlyUser: true,
   * });
   * ```
   */
  async register(name: string, config: ConnectionConfig): Promise<void> {
    if (this.#closed) {
      throw new ConfigError(
        `Cannot register connection '${name}': the manager is closed.`,
        `connections.${name}`,
      );
    }
    if (sameConfig(this.#configs[name], config)) {
      // Declaration unchanged: nothing to tear down, and the open pool keeps
      // serving. Skipping here is what makes `register` idempotent.
      return;
    }
    await this.#release(name);
    this.#configs[name] = config;
  }

  /**
   * Removes a declared connection and closes it if this manager opened it.
   *
   * @param name - Key used at registration.
   * @returns `true` if a declaration was removed, `false` if there was none.
   */
  async unregister(name: string): Promise<boolean> {
    const declared = name in this.#configs;
    await this.#release(name);
    delete this.#configs[name];
    return declared;
  }

  /** Whether a connection with this name is known, declared or injected. */
  has(name: string): boolean {
    return name in this.#configs || name in this.#injected;
  }

  /** Names of every known connection, declared or injected. */
  names(): string[] {
    return [...new Set([...Object.keys(this.#configs), ...Object.keys(this.#injected)])];
  }

  /**
   * Returns the handle for a named connection.
   *
   * @param name - Key in the `connections` config section, or of an injected
   *               connection.
   * @throws {@link ConfigError} when no such connection is known. Failing here
   *         rather than at execution time turns a renamed connection into a
   *         load-time error instead of a runtime surprise.
   */
  get(name: string): ConnectionHandle {
    const existing = this.#handles.get(name);
    if (existing !== undefined) return existing;

    const config = this.#configFor(name);
    if (config === null) {
      const known = this.names();
      throw new ConfigError(
        `Unknown connection '${name}'. Declared: ${known.join(', ') || '(none)'}`,
        `connections.${name}`,
      );
    }

    const handle: ConnectionHandle = {
      name,
      config,
      resource: (context) => this.#resource(name, config, context),
      credential: (context) => this.#credential(config, context),
      driver: () => this.#driverFor(name, config),
    };
    this.#handles.set(name, handle);
    return handle;
  }

  /**
   * Closes every resource this manager opened, leaving injected ones alone.
   *
   * Never rejects: a driver that fails to close is reported through
   * `connection.error` so one bad connection cannot block shutdown of the rest.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const owned = [...this.#owned.entries()];
    this.#owned.clear();
    this.#opening.clear();

    await Promise.all(
      owned.map(async ([name, { resource, driver }]) => {
        try {
          await driver.close(resource);
        } catch (err) {
          this.#emit('connection.error', {
            connection: name,
            phase: 'close',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Drops the cached handle for a name and closes the resource this manager
   * opened for it, waiting first on an open still in flight so a connection
   * being established is not left orphaned.
   *
   * Never rejects: a driver that fails to close is reported through
   * `connection.error`, the same contract as {@link close}.
   */
  async #release(name: string): Promise<void> {
    this.#handles.delete(name);

    const opening = this.#opening.get(name);
    if (opening !== undefined) {
      await opening.catch(() => undefined);
    }

    const owned = this.#owned.get(name);
    if (owned === undefined) return;
    this.#owned.delete(name);
    try {
      await owned.driver.close(owned.resource);
    } catch (err) {
      this.#emit('connection.error', {
        connection: name,
        phase: 'close',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Merges the declared entry with an injected one of the same name, the
   * injected config winning field by field. Returns `null` when neither
   * exists, or when an injected connection carries no config and none is
   * declared for it.
   */
  #configFor(name: string): ConnectionConfig | null {
    const declared = this.#configs[name];
    const injected = this.#injected[name];

    if (injected === undefined) return declared ?? null;
    if (injected.config === undefined) return declared ?? null;
    if (declared === undefined) return injected.config;

    // Both present: the injected config overrides field by field. The cast is
    // safe for same-type merges and is what an override is expected to do;
    // a type mismatch is caught by validateConnections() at load time.
    return { ...declared, ...injected.config } as ConnectionConfig;
  }

  /** Resolves the credential declared by a connection, if any. */
  async #credential(config: ConnectionConfig, context: ExecutionContext): Promise<Credential> {
    const spec: CredentialSpec | undefined = config.credential;
    if (spec === undefined) return { kind: 'none' };
    if ('ref' in spec) return this.#credentials.get(spec.ref, context);
    return spec;
  }

  /** Opens (once) and returns the live resource for a connection. */
  async #resource(
    name: string,
    config: ConnectionConfig,
    context: ExecutionContext,
  ): Promise<unknown> {
    if (this.#closed) {
      throw new ConnectionError(name, 'the connection manager is already closed');
    }

    const injected = this.#injected[name];
    if (injected !== undefined) return injected.resource;

    const owned = this.#owned.get(name);
    if (owned !== undefined) return owned.resource;

    const inFlight = this.#opening.get(name);
    if (inFlight !== undefined) return inFlight;

    const attempt = this.#open(name, config, context);
    this.#opening.set(name, attempt);
    try {
      return await attempt;
    } finally {
      // Dropped either way: on success the resource lives in #owned, and on
      // failure the next call must be free to retry rather than replay the
      // rejection forever.
      this.#opening.delete(name);
    }
  }

  /** Performs the actual open, recording ownership on success. */
  async #open(name: string, config: ConnectionConfig, context: ExecutionContext): Promise<unknown> {
    const driver = this.#driverFor(name, config);
    const credential = await this.#credential(config, context);

    let resource: unknown;
    try {
      resource = await driver.open(config, credential);
    } catch (err) {
      this.#emit('connection.error', {
        connection: name,
        phase: 'open',
        driver: driver.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // The cause's message goes in the text, not only in `cause`. A driver
      // that cannot find its client package says exactly what to install, and
      // that sentence is worthless if the only thing the caller ever prints is
      // the wrapper.
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(name, `driver '${driver.name}' failed to open it: ${detail}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }

    // A close() that landed while the open was in flight must not leave a
    // resource behind with nobody left to close it.
    if (this.#closed) {
      await driver.close(resource).catch(() => undefined);
      throw new ConnectionError(name, 'the connection manager closed while opening');
    }

    this.#owned.set(name, { resource, driver });
    this.#emit('connection.opened', { connection: name, driver: driver.name });
    return resource;
  }

  /** Resolves the driver a connection needs, or explains what is missing. */
  #driverFor(name: string, config: ConnectionConfig): ConnectionDriver {
    if (config.type === 'http' || config.type === 'mail') {
      throw new ConnectionError(
        name,
        `connections of type '${config.type}' hold no resource to open. ` +
          (config.type === 'mail'
            ? 'Inject a MailTransport via OrchestratorOverrides.mailTransport.'
            : 'Use the connection config and credential directly.'),
      );
    }

    const id = config.type === 'sql' ? config.driver : 'mongo';
    const driver = this.#drivers.get(id);
    if (driver === undefined) {
      const known = [...this.#drivers.keys()];
      throw new ConnectionError(
        name,
        `no driver registered for '${id}'. Registered: ${known.join(', ') || '(none)'}`,
      );
    }
    return driver;
  }
}
