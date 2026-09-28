import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigError } from '../../../src/errors/index.js';
import { McpClient } from '../../../src/mcp/McpClient.js';
import { startTestMcpServer } from '../../fixtures/mcpServer.js';
import type { FakeToolSpec, TestMcpServer } from '../../fixtures/mcpServer.js';
import type { DeepPartial, SDKConfig } from '../../../src/config/ConfigLoader.js';
import type { AgentEvent } from '../../../src/types/index.js';

const SCHEMA = { type: 'object', properties: { message: { type: 'string' } } };

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

function tool(name: string): FakeToolSpec {
  return { name, inputSchema: SCHEMA, handler: () => textResult(name) };
}

const LLM: DeepPartial<SDKConfig>['llm'] = {
  providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'x' } },
  defaultProvider: 'ollama',
};

/** Orchestrator wired to an in-process server via the injection escape hatch. */
async function build(
  server: TestMcpServer,
  extra: Record<string, unknown> = {},
): Promise<Orchestrator> {
  return Orchestrator.create(
    {
      llm: LLM,
      mcp: {
        servers: { files: { transport: 'stdio', command: 'ignored', autoRegisterTools: true } },
      },
      ...extra,
    } as DeepPartial<SDKConfig>,
    { mcpClients: { files: new McpClient('files', server.config) } },
  );
}

describe('Orchestrator.refreshMcpTools()', () => {
  it('picks up a tool the server added after startup', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);

    expect(orch.toolRegistry.list()).toEqual(['files.read']);

    server.setTools([tool('read'), tool('write')]);
    const [result] = await orch.refreshMcpTools('files');

    expect(orch.toolRegistry.list()).toEqual(['files.read', 'files.write']);
    expect(result).toMatchObject({
      server: 'files',
      added: ['files.write'],
      updated: ['files.read'],
      removed: [],
    });

    await orch.shutdown();
    await server.close();
  });

  it('removes a tool the server no longer exposes', async () => {
    const server = await startTestMcpServer({ tools: [tool('read'), tool('write')] });
    const orch = await build(server);

    server.setTools([tool('read')]);
    const [result] = await orch.refreshMcpTools('files');

    expect(orch.toolRegistry.list()).toEqual(['files.read']);
    expect(result!.removed).toEqual(['files.write']);
    expect(orch.toolRegistry.get('files.write')).toBeUndefined();

    await orch.shutdown();
    await server.close();
  });

  it('re-registers an existing tool so schema changes take effect', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);

    server.setTools([
      {
        name: 'read',
        description: 'now documented',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: () => textResult('ok'),
      },
    ]);
    await orch.refreshMcpTools('files');

    const refreshed = orch.toolRegistry.get('files.read')!;
    expect(refreshed.description).toBe('now documented');
    expect(refreshed.inputSchema).toMatchObject({ required: ['path'] });

    await orch.shutdown();
    await server.close();
  });

  it('never overwrites a tool claimed by tools.definitions', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server, {
      tools: {
        definitions: [
          {
            kind: 'mcp',
            name: 'files.read',
            server: 'files',
            remoteName: 'read',
            tags: ['pinned'],
          },
        ],
      },
    });

    expect(orch.toolRegistry.get('files.read')!.tags).toEqual(['pinned']);

    const [result] = await orch.refreshMcpTools('files');

    // The explicit declaration keeps winning, exactly as it does at startup.
    expect(orch.toolRegistry.get('files.read')!.tags).toEqual(['pinned']);
    expect(result!.skipped).toEqual(['files.read']);
    expect(result!.updated).toEqual([]);

    await orch.shutdown();
    await server.close();
  });

  it('does not remove a declared tool even when the server drops it', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server, {
      tools: {
        definitions: [{ kind: 'mcp', name: 'files.read', server: 'files', remoteName: 'read' }],
      },
    });

    server.setTools([]);
    await orch.refreshMcpTools('files');

    expect(orch.toolRegistry.get('files.read')).toBeDefined();

    await orch.shutdown();
    await server.close();
  });

  it('leaves tools registered in code alone', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);

    orch.registerTool({
      name: 'local.calculator',
      description: 'local',
      inputSchema: { type: 'object' },
      execute: () => Promise.resolve({ success: true }),
    });

    server.setTools([]);
    await orch.refreshMcpTools('files');

    expect(orch.toolRegistry.list()).toEqual(['local.calculator']);

    await orch.shutdown();
    await server.close();
  });

  it('emits mcp.tools.refreshed with the change counts', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);
    const events: AgentEvent[] = [];
    orch.events.on('mcp.tools.refreshed', (e) => events.push(e));

    server.setTools([tool('write')]);
    await orch.refreshMcpTools('files');

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      server: 'files',
      added: 1,
      updated: 0,
      removed: 1,
    });

    await orch.shutdown();
    await server.close();
  });

  it('refreshes every auto-registered server when no name is given', async () => {
    const a = await startTestMcpServer({ tools: [tool('a1')] });
    const b = await startTestMcpServer({ tools: [tool('b1')] });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: {
          servers: {
            sa: { transport: 'stdio', command: 'x', autoRegisterTools: true },
            sb: { transport: 'stdio', command: 'x', autoRegisterTools: true },
          },
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: { sa: new McpClient('sa', a.config), sb: new McpClient('sb', b.config) } },
    );

    a.setTools([tool('a1'), tool('a2')]);
    b.setTools([tool('b2')]);

    const results = await orch.refreshMcpTools();

    expect(results.map((r) => r.server).sort()).toEqual(['sa', 'sb']);
    expect(orch.toolRegistry.list().sort()).toEqual(['sa.a1', 'sa.a2', 'sb.b2']);

    await orch.shutdown();
    await a.close();
    await b.close();
  });

  it('is a no-op for a server that was not auto-registered', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: { servers: { files: { transport: 'stdio', command: 'x' } } },
        tools: {
          definitions: [{ kind: 'mcp', name: 'files.read', server: 'files', remoteName: 'read' }],
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: { files: new McpClient('files', server.config) } },
    );

    // Its tools are pinned by explicit definitions, so there is nothing to sync.
    expect(await orch.refreshMcpTools('files')).toEqual([]);
    expect(orch.toolRegistry.list()).toEqual(['files.read']);

    await orch.shutdown();
    await server.close();
  });

  it('throws for an unknown server name', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);

    await expect(orch.refreshMcpTools('ghost')).rejects.toThrow(ConfigError);
    await expect(orch.refreshMcpTools('ghost')).rejects.toThrow(/Declared servers: files/);

    await orch.shutdown();
    await server.close();
  });

  it('propagates a connection failure instead of silently emptying the registry', async () => {
    const server = await startTestMcpServer({ tools: [tool('read')] });
    const orch = await build(server);

    // Kill the server behind the client's back.
    await server.close();

    await expect(orch.refreshMcpTools('files')).rejects.toThrow();
    // The previous catalogue survives a failed refresh.
    expect(orch.toolRegistry.list()).toEqual(['files.read']);

    await orch.shutdown();
  });
});
