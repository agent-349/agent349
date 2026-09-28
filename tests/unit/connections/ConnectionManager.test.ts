import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionManager } from '../../../src/connections/ConnectionManager.js';
import { ConnectionDriver } from '../../../src/connections/types.js';
import type { ConnectionConfig } from '../../../src/connections/types.js';
import { ConfigCredentialProvider } from '../../../src/credentials/ConfigCredentialProvider.js';
import { CredentialProvider } from '../../../src/credentials/CredentialProvider.js';
import type { Credential } from '../../../src/credentials/types.js';
import { ConfigError, ConnectionError } from '../../../src/errors/index.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

/** Records every open/close and hands back a distinguishable resource. */
class FakeDriver extends ConnectionDriver<{ id: number }> {
  override readonly name = 'fake';
  opens = 0;
  closes = 0;
  lastCredential: Credential | null = null;
  failNext = false;
  /** Resolves when the test lets a pending open finish. */
  gate: Promise<void> | null = null;

  override async open(_config: ConnectionConfig, credential: Credential): Promise<{ id: number }> {
    if (this.gate !== null) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('connection refused');
    }
    this.lastCredential = credential;
    this.opens += 1;
    return { id: this.opens };
  }

  override async close(_resource: { id: number }): Promise<void> {
    this.closes += 1;
  }
}

const SQL: ConnectionConfig = { type: 'sql', driver: 'fake', database: 'erp' };

let driver: FakeDriver;

function makeManager(
  overrides: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {},
): ConnectionManager {
  return new ConnectionManager({
    connections: { erp: SQL },
    credentials: new ConfigCredentialProvider(),
    drivers: { fake: driver },
    ...overrides,
  });
}

beforeEach(() => {
  driver = new FakeDriver();
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager.get', () => {
  it('returns a handle carrying the declared config', () => {
    const handle = makeManager().get('erp');

    expect(handle.name).toBe('erp');
    expect(handle.config).toEqual(SQL);
  });

  // Failing here rather than at execution time turns a renamed connection into
  // a load-time error instead of a production surprise.
  it('throws ConfigError for an unknown connection, listing the known ones', () => {
    expect(() => makeManager().get('nope')).toThrow(ConfigError);
    expect(() => makeManager().get('nope')).toThrow(/erp/);
  });

  it('returns the same handle for repeated lookups', () => {
    const manager = makeManager();
    expect(manager.get('erp')).toBe(manager.get('erp'));
  });

  it('lists declared and injected connections together', () => {
    const manager = makeManager({
      injected: { legacy: { resource: {}, config: SQL } },
    });
    expect(manager.names().sort()).toEqual(['erp', 'legacy']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy opening
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager lazy opening', () => {
  // Building an Orchestrator must not require every declared database to be up.
  it('opens nothing until a resource is actually requested', () => {
    const manager = makeManager();
    manager.get('erp');

    expect(driver.opens).toBe(0);
  });

  it('opens once and reuses the resource', async () => {
    const handle = makeManager().get('erp');

    const first = await handle.resource(CTX);
    const second = await handle.resource(CTX);

    expect(driver.opens).toBe(1);
    expect(second).toBe(first);
  });

  it('shares a single opening attempt between concurrent callers', async () => {
    let release = (): void => {};
    driver.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const handle = makeManager().get('erp');
    const both = Promise.all([handle.resource(CTX), handle.resource(CTX)]);
    release();
    const [a, b] = await both;

    expect(driver.opens).toBe(1);
    expect(a).toBe(b);
  });

  it('wraps a driver failure in ConnectionError naming the connection', async () => {
    driver.failNext = true;
    const handle = makeManager().get('erp');

    await expect(handle.resource(CTX)).rejects.toThrow(ConnectionError);
  });

  // A cached rejection would make one transient outage permanent for the
  // lifetime of the process.
  it('retries after a failed open instead of caching the rejection', async () => {
    driver.failNext = true;
    const handle = makeManager().get('erp');

    await expect(handle.resource(CTX)).rejects.toThrow(ConnectionError);
    await expect(handle.resource(CTX)).resolves.toEqual({ id: 1 });
  });

  it('reports a missing driver with the ids that are registered', async () => {
    const manager = new ConnectionManager({
      connections: { erp: { type: 'sql', driver: 'postgres', database: 'erp' } },
      credentials: new ConfigCredentialProvider(),
      drivers: { fake: driver },
    });

    await expect(manager.get('erp').resource(CTX)).rejects.toThrow(/no driver registered/);
  });

  it('accepts a driver registered after construction', async () => {
    const manager = new ConnectionManager({
      connections: { erp: SQL },
      credentials: new ConfigCredentialProvider(),
    });
    manager.registerDriver(driver);

    await expect(manager.get('erp').resource(CTX)).resolves.toEqual({ id: 1 });
  });

  it('explains that http and mail connections hold no resource', async () => {
    const manager = new ConnectionManager({
      connections: { api: { type: 'http', baseUrl: 'https://example.com' } },
      credentials: new ConfigCredentialProvider(),
    });

    await expect(manager.get('api').resource(CTX)).rejects.toThrow(/hold no resource/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager credentials', () => {
  it('returns kind "none" when the connection declares no credential', async () => {
    await expect(makeManager().get('erp').credential(CTX)).resolves.toEqual({ kind: 'none' });
  });

  it('resolves a ref through the provider', async () => {
    const manager = makeManager({
      connections: { erp: { ...SQL, credential: { ref: 'erp-ro' } } },
      credentials: new ConfigCredentialProvider({
        'erp-ro': { kind: 'basic', username: 'ro', password: 'pw' },
      }),
    });

    await expect(manager.get('erp').credential(CTX)).resolves.toEqual({
      kind: 'basic',
      username: 'ro',
      password: 'pw',
    });
  });

  it('passes inline credential material straight through', async () => {
    const manager = makeManager({
      connections: { erp: { ...SQL, credential: { kind: 'bearer', token: 't' } } },
    });

    await expect(manager.get('erp').credential(CTX)).resolves.toEqual({
      kind: 'bearer',
      token: 't',
    });
  });

  it('hands the resolved credential to the driver when opening', async () => {
    const manager = makeManager({
      connections: { erp: { ...SQL, credential: { kind: 'bearer', token: 'abc' } } },
    });
    await manager.get('erp').resource(CTX);

    expect(driver.lastCredential).toEqual({ kind: 'bearer', token: 'abc' });
  });

  // A provider keyed on the caller is what makes per-user OAuth expressible;
  // without the context reaching it, only service credentials would work.
  it('gives the provider the execution context so it can vary per user', async () => {
    class PerUserProvider extends CredentialProvider {
      override readonly name = 'per-user';
      override async get(ref: string, context: ExecutionContext): Promise<Credential> {
        return { kind: 'bearer', token: `${ref}:${context.userId}` };
      }
    }

    const manager = makeManager({
      connections: { erp: { ...SQL, credential: { ref: 'mailbox' } } },
      credentials: new PerUserProvider(),
    });

    await expect(manager.get('erp').credential(CTX)).resolves.toEqual({
      kind: 'bearer',
      token: 'mailbox:u1',
    });
  });

  it('re-resolves on every call rather than caching', async () => {
    const get = vi.fn(async (): Promise<Credential> => ({ kind: 'bearer', token: 't' }));
    class Counting extends CredentialProvider {
      override readonly name = 'counting';
      override get = get;
    }

    const manager = makeManager({
      connections: { erp: { ...SQL, credential: { ref: 'x' } } },
      credentials: new Counting(),
    });
    await manager.get('erp').credential(CTX);
    await manager.get('erp').credential(CTX);

    expect(get).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injected connections and ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager injected connections', () => {
  it('hands back the injected resource without calling any driver', async () => {
    const pool = { host: true };
    const manager = makeManager({ injected: { erp: { resource: pool } } });

    await expect(manager.get('erp').resource(CTX)).resolves.toBe(pool);
    expect(driver.opens).toBe(0);
  });

  it('merges an injected config over the declared one', () => {
    const manager = makeManager({
      injected: {
        erp: { resource: {}, config: { type: 'sql', driver: 'fake', database: 'erp_replica' } },
      },
    });

    expect((manager.get('erp').config as { database?: string }).database).toBe('erp_replica');
  });

  it('keeps the declared config when the injected entry carries none', () => {
    const manager = makeManager({ injected: { erp: { resource: {} } } });
    expect(manager.get('erp').config).toEqual(SQL);
  });

  it('serves an injected connection that was never declared', async () => {
    const pool = {};
    const manager = makeManager({
      injected: { extra: { resource: pool, config: SQL } },
    });

    await expect(manager.get('extra').resource(CTX)).resolves.toBe(pool);
  });
});

describe('ConnectionManager.close', () => {
  it('closes what it opened', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);
    await manager.close();

    expect(driver.closes).toBe(1);
  });

  // Injected connections belong to the host — the same rule the Orchestrator
  // already applies to injected audit stores.
  it('leaves injected connections alone', async () => {
    const manager = makeManager({ injected: { erp: { resource: {} } } });
    await manager.get('erp').resource(CTX);
    await manager.close();

    expect(driver.closes).toBe(0);
  });

  it('does not open anything that was never used', async () => {
    await makeManager().close();
    expect(driver.closes).toBe(0);
  });

  // Shutdown must not be blocked by one misbehaving driver.
  it('reports a failing close as an event instead of rejecting', async () => {
    const emit = vi.fn();
    const manager = makeManager({ emit });
    await manager.get('erp').resource(CTX);
    driver.close = (): Promise<void> => Promise.reject(new Error('stuck'));

    await expect(manager.close()).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(
      'connection.error',
      expect.objectContaining({ connection: 'erp', phase: 'close' }),
    );
  });

  it('refuses to open after close', async () => {
    const manager = makeManager();
    await manager.close();

    await expect(manager.get('erp').resource(CTX)).rejects.toThrow(ConnectionError);
  });

  // Otherwise a resource opened during shutdown is leaked with nobody left to
  // close it.
  it('closes a resource whose open landed after close was called', async () => {
    let release = (): void => {};
    driver.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const manager = makeManager();
    const pending = manager.get('erp').resource(CTX);
    const closing = manager.close();
    release();

    await expect(pending).rejects.toThrow(ConnectionError);
    await closing;
    expect(driver.closes).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager events', () => {
  it('emits connection.opened on a successful open', async () => {
    const emit = vi.fn();
    await makeManager({ emit }).get('erp').resource(CTX);

    expect(emit).toHaveBeenCalledWith('connection.opened', {
      connection: 'erp',
      driver: 'fake',
    });
  });

  // The driver's own message is what tells an operator what to fix — most often
  // "install this package". Losing it in the wrapper turns an actionable error
  // into a shrug.
  it('carries the driver error message into the thrown error', async () => {
    driver.failNext = true;

    await expect(makeManager().get('erp').resource(CTX)).rejects.toThrow(/connection refused/);
  });

  it('emits connection.error on a failed open', async () => {
    const emit = vi.fn();
    driver.failNext = true;

    await expect(makeManager({ emit }).get('erp').resource(CTX)).rejects.toThrow();
    expect(emit).toHaveBeenCalledWith(
      'connection.error',
      expect.objectContaining({ connection: 'erp', phase: 'open' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime registration
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionManager.register', () => {
  it('declares a connection that was not in the config', async () => {
    const manager = makeManager();
    expect(manager.has('crm')).toBe(false);

    await manager.register('crm', { type: 'sql', driver: 'fake', database: 'crm' });

    expect(manager.has('crm')).toBe(true);
    expect(manager.names()).toEqual(expect.arrayContaining(['erp', 'crm']));
    expect(manager.get('crm').config).toEqual({ type: 'sql', driver: 'fake', database: 'crm' });
  });

  // Registering is meant to be safe on a request path: it must not contact
  // anything, or a data source being declared would fail when its host is down.
  it('opens nothing', async () => {
    const manager = makeManager();

    await manager.register('crm', { type: 'sql', driver: 'fake', database: 'crm' });

    expect(driver.opens).toBe(0);
  });

  it('does not mutate the config object it was constructed with', async () => {
    const connections = { erp: SQL };
    const manager = new ConnectionManager({
      connections,
      credentials: new ConfigCredentialProvider(),
      drivers: { fake: driver },
    });

    await manager.register('crm', { type: 'sql', driver: 'fake', database: 'crm' });

    expect(Object.keys(connections)).toEqual(['erp']);
  });

  // Re-registering the same declaration is what a host does on a request path
  // to make sure a runtime connection exists. If that closed the pool, every
  // call would reopen it — and would close it out from under a query in flight.
  it('does nothing when the config is identical', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);

    await manager.register('erp', { ...SQL });

    expect(driver.closes).toBe(0);
    expect(driver.opens).toBe(1);
  });

  it('compares structurally, so key order does not force a reconnect', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);

    await manager.register('erp', { database: 'erp', driver: 'fake', type: 'sql' });

    expect(driver.closes).toBe(0);
  });

  it('still replaces when a field actually changed', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);

    await manager.register('erp', { ...SQL, database: 'otro' });

    expect(driver.closes).toBe(1);
  });

  // The whole point of replacing: a connection that now points elsewhere must
  // not keep serving queries from the pool opened for the old target.
  it('closes the resource it had opened when a name is replaced', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);
    expect(driver.opens).toBe(1);

    await manager.register('erp', { type: 'sql', driver: 'fake', database: 'erp_new' });

    expect(driver.closes).toBe(1);
    expect(manager.get('erp').config).toEqual({
      type: 'sql',
      driver: 'fake',
      database: 'erp_new',
    });

    await manager.get('erp').resource(CTX);
    expect(driver.opens).toBe(2);
  });

  it('waits for an in-flight open before replacing, so nothing is orphaned', async () => {
    const manager = makeManager();
    let release!: () => void;
    driver.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const opening = manager.get('erp').resource(CTX);
    const replacing = manager.register('erp', { type: 'sql', driver: 'fake', database: 'other' });
    driver.gate = null;
    release();

    await opening;
    await replacing;

    expect(driver.opens).toBe(1);
    expect(driver.closes).toBe(1);
  });

  it('reports a close failure through connection.error instead of rejecting', async () => {
    const emit = vi.fn();
    const manager = makeManager({ emit });
    await manager.get('erp').resource(CTX);
    driver.close = vi.fn().mockRejectedValue(new Error('socket hung up'));

    await expect(
      manager.register('erp', { type: 'sql', driver: 'fake', database: 'other' }),
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith(
      'connection.error',
      expect.objectContaining({ connection: 'erp', phase: 'close' }),
    );
  });

  it('throws ConfigError after close, since a closed manager opens nothing', async () => {
    const manager = makeManager();
    await manager.close();

    await expect(
      manager.register('crm', { type: 'sql', driver: 'fake', database: 'crm' }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('ConnectionManager.unregister', () => {
  it('removes the declaration and closes what it had opened', async () => {
    const manager = makeManager();
    await manager.get('erp').resource(CTX);

    await expect(manager.unregister('erp')).resolves.toBe(true);

    expect(driver.closes).toBe(1);
    expect(manager.has('erp')).toBe(false);
    expect(() => manager.get('erp')).toThrow(ConfigError);
  });

  it('returns false for a name that was never declared', async () => {
    await expect(makeManager().unregister('nope')).resolves.toBe(false);
  });

  // An injected connection belongs to the host: the SDK never closes it, and
  // dropping the declared entry must not make it disappear.
  it('leaves an injected connection of the same name in place', async () => {
    const hostResource = { id: 99 };
    const manager = makeManager({
      injected: { erp: { resource: hostResource } },
    });

    await expect(manager.unregister('erp')).resolves.toBe(true);

    expect(manager.has('erp')).toBe(true);
    expect(driver.closes).toBe(0);
  });
});
