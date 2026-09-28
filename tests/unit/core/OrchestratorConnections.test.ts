import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConnectionDriver } from '../../../src/connections/types.js';
import type { ConnectionConfig } from '../../../src/connections/types.js';
import { CredentialProvider } from '../../../src/credentials/CredentialProvider.js';
import type { Credential } from '../../../src/credentials/types.js';
import { ConfigError } from '../../../src/errors/index.js';
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

class FakeDriver extends ConnectionDriver<{ open: boolean }> {
  override readonly name = 'fake';
  opens = 0;
  closes = 0;

  override async open(_c: ConnectionConfig, _cr: Credential): Promise<{ open: boolean }> {
    this.opens += 1;
    return { open: true };
  }

  override async close(): Promise<void> {
    this.closes += 1;
  }
}

const CONNECTIONS = {
  erp: { type: 'sql' as const, driver: 'fake', database: 'erp', credential: { ref: 'erp-ro' } },
};

const CREDENTIALS = {
  'erp-ro': { kind: 'basic' as const, username: 'ro', password: 'pw' },
};

/** Same connection without a credential, for tests that only exercise opening. */
const OPEN_CONNECTIONS = {
  erp: { type: 'sql' as const, driver: 'fake', database: 'erp' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Config validation
// ─────────────────────────────────────────────────────────────────────────────

describe('connections config validation', () => {
  it('accepts a config with no connections section at all', () => {
    expect(() => ConfigLoader.from().get()).not.toThrow();
  });

  it('rejects a sql connection with no driver', () => {
    expect(() =>
      ConfigLoader.from({ connections: { db: { type: 'sql', database: 'x' } } } as never).get(),
    ).toThrow(ConfigError);
  });

  it('rejects a sql connection with neither url nor database', () => {
    expect(() =>
      ConfigLoader.from({ connections: { db: { type: 'sql', driver: 'fake' } } } as never).get(),
    ).toThrow(ConfigError);
  });

  it('rejects an http connection with a malformed baseUrl', () => {
    expect(() =>
      ConfigLoader.from({
        connections: { api: { type: 'http', baseUrl: 'not-a-url' } },
      } as never).get(),
    ).toThrow(/not a valid URL/);
  });

  it('rejects an unknown connection type', () => {
    expect(() => ConfigLoader.from({ connections: { x: { type: 'ftp' } } } as never).get()).toThrow(
      /unknown/,
    );
  });

  // The SDK ships no mail transport: saying so at load time beats failing on
  // the first send.
  it('rejects a mail connection asking for a transport the SDK does not ship', () => {
    expect(() =>
      ConfigLoader.from({ connections: { m: { type: 'mail', transport: 'smtp' } } } as never).get(),
    ).toThrow(/injected/);
  });

  // A ref pointing nowhere is a typo, and finding it on the first query means
  // finding it in production.
  it('rejects a credential ref that is not declared', () => {
    expect(() =>
      ConfigLoader.from({
        connections: CONNECTIONS,
        credentials: { other: { kind: 'none' } },
      } as never).get(),
    ).toThrow(/is not declared/);
  });

  // Refs resolved by an injected provider are unknown to the config, so the
  // check only applies when a credentials section exists.
  it('allows an unresolvable ref when no credentials section is declared', () => {
    expect(() => ConfigLoader.from({ connections: CONNECTIONS } as never).get()).not.toThrow();
  });

  it('rejects an unknown credential kind', () => {
    expect(() =>
      ConfigLoader.from({ credentials: { x: { kind: 'magic' } } } as never).get(),
    ).toThrow(/kind must be one of/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator connection wiring', () => {
  it('exposes declared connections without opening them', async () => {
    const config = ConfigLoader.from({
      connections: CONNECTIONS,
      credentials: CREDENTIALS,
    } as never).get();
    const orch = await Orchestrator.fromConfig(config);
    const driver = new FakeDriver();
    orch.connections.registerDriver(driver);

    expect(orch.connections.names()).toEqual(['erp']);
    expect(driver.opens).toBe(0);

    await orch.shutdown();
  });

  it('resolves credentials from the config section through the handle', async () => {
    const config = ConfigLoader.from({
      connections: CONNECTIONS,
      credentials: CREDENTIALS,
    } as never).get();
    const orch = await Orchestrator.fromConfig(config);

    await expect(orch.connections.get('erp').credential(CTX)).resolves.toEqual({
      kind: 'basic',
      username: 'ro',
      password: 'pw',
    });

    await orch.shutdown();
  });

  // This is the seam OAuth arrives through: the SDK keeps no token state.
  it('lets an injected provider take priority over the credentials section', async () => {
    class Injected extends CredentialProvider {
      override readonly name = 'injected';

      override async get(_ref: string, context: ExecutionContext): Promise<Credential> {
        return { kind: 'bearer', token: `fresh-for-${context.userId}` };
      }
    }

    const config = ConfigLoader.from({
      connections: CONNECTIONS,
      credentials: CREDENTIALS,
    } as never).get();
    const orch = await Orchestrator.fromConfig(config, { credentialProvider: new Injected() });

    await expect(orch.connections.get('erp').credential(CTX)).resolves.toEqual({
      kind: 'bearer',
      token: 'fresh-for-u1',
    });

    await orch.shutdown();
  });

  it('serves a host-injected connection instead of opening its own', async () => {
    const pool = { host: true };
    const config = ConfigLoader.from({ connections: CONNECTIONS } as never).get();
    const orch = await Orchestrator.fromConfig(config, {
      connections: { erp: { resource: pool } },
    });
    const driver = new FakeDriver();
    orch.connections.registerDriver(driver);

    await expect(orch.connections.get('erp').resource(CTX)).resolves.toBe(pool);
    expect(driver.opens).toBe(0);

    await orch.shutdown();
  });

  it('closes connections it opened on shutdown', async () => {
    const config = ConfigLoader.from({ connections: OPEN_CONNECTIONS } as never).get();
    const orch = await Orchestrator.fromConfig(config);
    const driver = new FakeDriver();
    orch.connections.registerDriver(driver);
    await orch.connections.get('erp').resource(CTX);

    await orch.shutdown();

    expect(driver.closes).toBe(1);
  });

  // Injected connections belong to the host, like injected audit stores.
  it('leaves host-injected connections open on shutdown', async () => {
    const config = ConfigLoader.from({ connections: CONNECTIONS } as never).get();
    const orch = await Orchestrator.fromConfig(config, {
      connections: { erp: { resource: {} } },
    });
    const driver = new FakeDriver();
    orch.connections.registerDriver(driver);
    await orch.connections.get('erp').resource(CTX);

    await orch.shutdown();

    expect(driver.closes).toBe(0);
  });

  it('forwards connection lifecycle events to the event bus', async () => {
    const config = ConfigLoader.from({ connections: OPEN_CONNECTIONS } as never).get();
    const orch = await Orchestrator.fromConfig(config);
    orch.connections.registerDriver(new FakeDriver());
    const opened = vi.fn();
    orch.events.on('connection.opened', opened);

    await orch.connections.get('erp').resource(CTX);

    expect(opened).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toolServices
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.toolServices', () => {
  it('exposes the same services the declarative loader injects', async () => {
    const config = ConfigLoader.from({
      connections: CONNECTIONS,
      credentials: CREDENTIALS,
    } as never).get();
    const orch = await Orchestrator.fromConfig(config);

    const services = orch.toolServices;
    expect(services.getConnection('erp').name).toBe('erp');
    await expect(services.getCredential('erp-ro', CTX)).resolves.toMatchObject({ kind: 'basic' });

    await orch.shutdown();
  });

  it('is stable across accesses, so tools share one set of services', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    expect(orch.toolServices).toBe(orch.toolServices);
    await orch.shutdown();
  });

  // A renamed connection must fail while the tool is being built, not on the
  // first query months later.
  it('reports an unknown connection as a ConfigError at build time', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    expect(() => orch.toolServices.getConnection('ghost')).toThrow(ConfigError);
    await orch.shutdown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime registration
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.registerConnection', () => {
  it('makes a connection created after startup usable by a tool', async () => {
    const driver = new FakeDriver();
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.connections.registerDriver(driver);

    await orch.registerConnection('ds_42', {
      type: 'sql',
      driver: 'fake',
      database: 'tenant_42',
    });
    const handle = orch.toolServices.getConnection('ds_42');
    await handle.resource(CTX);

    expect(handle.name).toBe('ds_42');
    expect(driver.opens).toBe(1);
    await orch.shutdown();
  });

  it('opens nothing at registration time', async () => {
    const driver = new FakeDriver();
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.connections.registerDriver(driver);

    await orch.registerConnection('ds_42', { type: 'sql', driver: 'fake', database: 't42' });

    expect(driver.opens).toBe(0);
    await orch.shutdown();
  });

  it('closes the old pool when a connection is re-pointed', async () => {
    const driver = new FakeDriver();
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.connections.registerDriver(driver);
    await orch.registerConnection('ds_42', { type: 'sql', driver: 'fake', database: 'old' });
    await orch.toolServices.getConnection('ds_42').resource(CTX);

    await orch.registerConnection('ds_42', { type: 'sql', driver: 'fake', database: 'new' });

    expect(driver.closes).toBe(1);
    expect(orch.toolServices.getConnection('ds_42').config).toMatchObject({ database: 'new' });
    await orch.shutdown();
  });

  it('unregisters, closing the pool and forgetting the name', async () => {
    const driver = new FakeDriver();
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.connections.registerDriver(driver);
    await orch.registerConnection('ds_42', { type: 'sql', driver: 'fake', database: 't42' });
    await orch.toolServices.getConnection('ds_42').resource(CTX);

    await expect(orch.unregisterConnection('ds_42')).resolves.toBe(true);

    expect(driver.closes).toBe(1);
    expect(() => orch.toolServices.getConnection('ds_42')).toThrow(ConfigError);
    await orch.shutdown();
  });

  it('closes runtime-registered connections on shutdown', async () => {
    const driver = new FakeDriver();
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.connections.registerDriver(driver);
    await orch.registerConnection('ds_42', { type: 'sql', driver: 'fake', database: 't42' });
    await orch.toolServices.getConnection('ds_42').resource(CTX);

    await orch.shutdown();

    expect(driver.closes).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Host-initiated tool execution
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.executeTool', () => {
  const echo = {
    name: 'echo',
    description: 'Returns what it is given.',
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute: async (input: { value: string }) => ({ success: true, data: { echoed: input.value } }),
  };

  it('runs a registered tool with no LLM involved', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.registerTool(echo);

    const result = await orch.executeTool('echo', { value: 'hola' }, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echoed: 'hola' });
    await orch.shutdown();
  });

  // The reason to go through the executor rather than calling tool.execute():
  // the host-initiated call is observed exactly like one the agent made.
  it('emits the tool.call.* events the audit trail is built from', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.registerTool(echo);
    const started = vi.fn();
    const ended = vi.fn();
    orch.events.on('tool.call.start', started);
    orch.events.on('tool.call.end', ended);

    await orch.executeTool('echo', { value: 'hola' }, CTX);

    expect(started).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });

  it('validates the input against the tool schema and fails without executing', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    const spy = vi.fn().mockResolvedValue({ success: true, data: {} });
    orch.registerTool({ ...echo, execute: spy });

    const result = await orch.executeTool('echo', { wrong: 1 }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/validation/i);
    expect(spy).not.toHaveBeenCalled();
    await orch.shutdown();
  });

  it('tracks provenance, so untrusted content entering the turn is reported', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.registerTool({
      ...echo,
      name: 'web',
      execute: async () => ({ success: true, data: { text: 'x' }, untrusted: true }),
    });
    const inflow = vi.fn();
    orch.events.on('security.untrusted.inflow', inflow);

    await orch.executeTool('web', { value: 'x' }, CTX);

    expect(inflow).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });

  it('throws ToolNotFoundError for an unregistered tool', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    await expect(orch.executeTool('ghost', {}, CTX)).rejects.toThrow(/ghost/);
    await orch.shutdown();
  });
});
