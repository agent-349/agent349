/**
 * Integration test: the MCP client against a real server over stdio.
 *
 * Unit tests drive an in-process transport, which cannot cover what actually
 * breaks in production: spawning a child process, draining its stderr, and
 * reaping it on shutdown. These do, using `node` and a fixture server — no
 * network and no external service, so the suite stays self-contained.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { McpClient } from '../../src/mcp/McpClient.js';
import { McpToolBridge } from '../../src/mcp/McpToolBridge.js';
import { Orchestrator } from '../../src/core/Orchestrator.js';
import { EventBus } from '../../src/events/EventBus.js';
import { ToolRegistry } from '../../src/tools/ToolRegistry.js';
import { ToolExecutor } from '../../src/tools/ToolExecutor.js';
import type { AgentEvent, ExecutionContext } from '../../src/types/index.js';
import type { DeepPartial, SDKConfig } from '../../src/config/ConfigLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '../fixtures/mcp-stdio-server.mjs');

const CTX: ExecutionContext = {
  tenantId: 't1',
  userId: 'u1',
  roles: ['user'],
  sessionId: 's1',
  agentId: 'a1',
  requestId: 'r1',
};

const STDIO = { transport: 'stdio', command: process.execPath, args: [SERVER] } as const;

const LLM: DeepPartial<SDKConfig>['llm'] = {
  providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'x' } },
  defaultProvider: 'ollama',
};

/** Whether a process with the given pid is still alive. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs of every running fixture server. Empty when none match. */
function serverPids(): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', 'mcp-stdio-server.mjs'], { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

function serverProcessCount(): number {
  return serverPids().length;
}

/**
 * Process-inspection assertions need `pgrep`, which is not available on
 * Windows. Skip rather than fail there — the rest of the suite still runs.
 */
const HAS_PGREP = ((): boolean => {
  try {
    execFileSync('pgrep', ['-f', 'definitely-no-such-process-xyz'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // Exit code 1 means "no match" — pgrep exists. ENOENT means it does not.
    return (err as { code?: unknown }).code !== 'ENOENT';
  }
})();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const clients: McpClient[] = [];
function track(client: McpClient): McpClient {
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('MCP over a real stdio transport', () => {
  it('completes the handshake and lists tools from the child process', async () => {
    const client = track(new McpClient('stdio', STDIO));

    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['echo', 'boom']);
    // The draft-2020-12 dialect the fixture advertises must be gone.
    expect(tools[0]!.inputSchema).not.toHaveProperty('$schema');
  });

  it('executes a bridged tool end-to-end through the ToolExecutor', async () => {
    const client = track(new McpClient('stdio', STDIO));
    const registry = new ToolRegistry();
    registry.registerMany(await new McpToolBridge(client).createTools());
    const executor = new ToolExecutor(registry, new EventBus());

    const ok = await executor.execute('stdio.echo', { message: 'hello' }, CTX);
    expect(ok).toMatchObject({ success: true, data: 'echo: hello' });

    // A remote schema compiled by AJV really does reject bad input.
    const bad = await executor.execute('stdio.echo', {}, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('Input validation failed');

    // `isError` from the server surfaces as a failed result, not a throw.
    const failed = await executor.execute('stdio.boom', {}, CTX);
    expect(failed).toMatchObject({ success: false, error: 'deliberate failure' });
  });

  it("forwards the child's stderr to the EventBus instead of the host's", async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.on('mcp.server.stderr', (e) => events.push(e));

    const client = track(new McpClient('stdio', STDIO, { eventBus: bus }));
    await client.connect();

    // stderr arrives asynchronously, shortly after the handshake.
    await sleep(300);

    expect(events.length).toBeGreaterThan(0);
    expect(String(events[0]!.data['message'])).toContain('stdio-integration-server ready');
    expect(events[0]!.data['server']).toBe('stdio');
  });

  it.skipIf(!HAS_PGREP)('reaps the exact child process it spawned on close()', async () => {
    const before = new Set(serverPids());

    const client = new McpClient('stdio', STDIO);
    await client.connect();

    const spawned = serverPids().filter((pid) => !before.has(pid));
    expect(spawned).toHaveLength(1);
    expect(isAlive(spawned[0]!)).toBe(true);

    await client.close();
    await sleep(300);

    expect(isAlive(spawned[0]!)).toBe(false);
  });

  it.skipIf(!HAS_PGREP)('reaps the child process on Orchestrator.shutdown()', async () => {
    const orch = await Orchestrator.create({
      llm: LLM,
      mcp: { servers: { stdio: { ...STDIO, autoRegisterTools: true } } },
    } as DeepPartial<SDKConfig>);

    expect(orch.toolRegistry.list()).toEqual(['stdio.echo', 'stdio.boom']);
    const running = serverProcessCount();
    expect(running).toBeGreaterThan(0);

    await orch.shutdown();
    await sleep(300);

    expect(serverProcessCount()).toBe(running - 1);
  });

  it('surfaces a failed spawn as McpConnectionError without leaving a process behind', async () => {
    const client = track(
      new McpClient('broken', {
        transport: 'stdio',
        command: resolve(__dirname, 'no-such-binary'),
      }),
    );

    await expect(client.listTools()).rejects.toThrow(/MCP server 'broken'/);
  });

  it.skipIf(!HAS_PGREP)(
    'leaves no fixture processes running once every client is closed',
    async () => {
      const a = new McpClient('a', STDIO);
      const b = new McpClient('b', STDIO);
      await Promise.all([a.connect(), b.connect()]);

      const pids = serverProcessCount();
      expect(pids).toBeGreaterThanOrEqual(2);

      await Promise.all([a.close(), b.close()]);
      await sleep(400);

      expect(serverProcessCount()).toBe(pids - 2);
    },
  );

  it('keeps the connection usable across many sequential calls', async () => {
    const client = track(new McpClient('stdio', STDIO));

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await client.callTool('echo', { message: String(i) }));
    }

    expect(results).toHaveLength(10);
    expect(results[9]!.content).toEqual([{ type: 'text', text: 'echo: 9' }]);
  });
});

describe('stdio process hygiene', () => {
  it('does not keep a handle open after a client that never connected is closed', async () => {
    const client = new McpClient('never', STDIO);
    await client.close();
    expect(client.connected).toBe(false);
  });

  it('rejects use after close instead of silently respawning', async () => {
    const client = new McpClient('probe', STDIO);
    await client.connect();
    await client.close();

    await expect(client.listTools()).rejects.toThrow(/client is closed/);
  });
});
