import { describe, it, expect } from 'vitest';
import { loadMcpServers } from '../../../src/config/McpLoader.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { McpConnectionError, ToolLoadError } from '../../../src/errors/index.js';
import { startTestMcpServer } from '../../fixtures/mcpServer.js';
import type { McpServerEntry } from '../../../src/mcp/types.js';
import type { AgentEvent } from '../../../src/types/index.js';

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

const ECHO_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
};

/** Builds the loader context, capturing emitted diagnostics. */
function makeCtx(loadMode: 'strict' | 'tolerant' = 'strict'): {
  toolRegistry: ToolRegistry;
  loadMode: 'strict' | 'tolerant';
  emit: (event: string, data: Record<string, unknown>) => void;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    toolRegistry: new ToolRegistry(),
    loadMode,
    emit: (event, data) => events.push({ event, data }),
    events,
  };
}

describe('loadMcpServers()', () => {
  it('is a no-op when no servers are declared', async () => {
    const ctx = makeCtx();
    const result = await loadMcpServers(undefined, ctx);

    expect(result.clients.size).toBe(0);
    expect(result.bridges.size).toBe(0);
    expect(ctx.toolRegistry.list()).toEqual([]);
  });

  it('auto-registers every tool when autoRegisterTools is set', async () => {
    const server = await startTestMcpServer({
      tools: [
        { name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') },
        { name: 'write_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') },
      ],
    });
    const ctx = makeCtx();

    const result = await loadMcpServers(
      { fs: { ...server.config, autoRegisterTools: true } as McpServerEntry },
      ctx,
    );

    expect(ctx.toolRegistry.list()).toEqual(['fs.read_file', 'fs.write_file']);
    expect(ctx.events).toContainEqual({
      event: 'config.mcp.server.loaded',
      data: { server: 'fs', toolCount: 2 },
    });

    await result.clients.get('fs')!.close();
    await server.close();
  });

  it('does not contact a server that has no autoRegisterTools', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });
    const ctx = makeCtx();

    const result = await loadMcpServers({ fs: server.config as McpServerEntry }, ctx);

    // A client and bridge exist, but startup opened no connection.
    expect(result.clients.get('fs')).toBeDefined();
    expect(result.bridges.get('fs')).toBeDefined();
    expect(server.connectCount).toBe(0);
    expect(ctx.toolRegistry.list()).toEqual([]);

    await result.clients.get('fs')!.close();
    await server.close();
  });

  it('applies namespace, tags and requiresApproval from the declaration', async () => {
    const server = await startTestMcpServer({
      tools: [
        {
          name: 'read_file',
          inputSchema: ECHO_SCHEMA,
          annotations: { readOnlyHint: true },
          handler: () => textResult('ok'),
        },
      ],
    });
    const ctx = makeCtx();

    const result = await loadMcpServers(
      {
        fs: {
          ...server.config,
          autoRegisterTools: true,
          namespace: 'files',
          tags: ['mcp', 'storage'],
          requiresApproval: true,
          toolTimeoutMs: 5000,
        } as McpServerEntry,
      },
      ctx,
    );

    const tool = ctx.toolRegistry.get('files.read_file');
    expect(tool).toBeDefined();
    expect(tool!.tags).toEqual(['mcp', 'storage']);
    // Declared per server: trust is a deployment decision, not a protocol one.
    expect(tool!.requiresApproval).toBe(true);
    expect(tool!.timeout).toBe(5000);

    await result.clients.get('fs')!.close();
    await server.close();
  });

  it('aborts startup in strict mode when a server is unreachable', async () => {
    const ctx = makeCtx('strict');

    await expect(
      loadMcpServers(
        {
          broken: {
            transport: 'custom',
            create: () => {
              throw new Error('server down');
            },
            autoRegisterTools: true,
          } as McpServerEntry,
        },
        ctx,
      ),
    ).rejects.toThrow(/server down/);
  });

  it('skips an unreachable server in tolerant mode and keeps loading the rest', async () => {
    const good = await startTestMcpServer({
      tools: [{ name: 'ok_tool', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });
    const ctx = makeCtx('tolerant');

    const result = await loadMcpServers(
      {
        broken: {
          transport: 'custom',
          create: () => {
            throw new Error('server down');
          },
          autoRegisterTools: true,
        } as McpServerEntry,
        good: { ...good.config, autoRegisterTools: true } as McpServerEntry,
      },
      ctx,
    );

    expect(ctx.toolRegistry.list()).toEqual(['good.ok_tool']);
    expect(ctx.events.map((e) => e.event)).toContain('config.mcp.server.error');

    await result.clients.get('good')!.close();
    await result.clients.get('broken')!.close();
    await good.close();
  });

  it('forwards the EventBus to each client for connection events', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    bus.on('mcp.*', (e) => seen.push(e));

    const result = await loadMcpServers(
      { fs: { ...server.config, autoRegisterTools: true } as McpServerEntry },
      { ...makeCtx(), eventBus: bus },
    );

    expect(seen.map((e) => e.type)).toContain('mcp.server.connect');

    await result.clients.get('fs')!.close();
    await server.close();
  });

  it('surfaces the failing server name in the tolerant-mode diagnostic', async () => {
    const ctx = makeCtx('tolerant');
    await loadMcpServers(
      {
        broken: {
          transport: 'custom',
          create: () => {
            throw new Error('boom');
          },
          autoRegisterTools: true,
        } as McpServerEntry,
      },
      ctx,
    );

    const errEvent = ctx.events.find((e) => e.event === 'config.mcp.server.error');
    expect(errEvent!.data['server']).toBe('broken');
    expect(String(errEvent!.data['error'])).toContain('boom');
  });

  it('preserves an SDK error instead of double-wrapping it in ToolLoadError', async () => {
    // A connection failure already carries precise diagnostics, so the loader
    // rethrows it as-is; only foreign errors get wrapped.
    const server = await startTestMcpServer({ tools: [] });
    const ctx = makeCtx('strict');

    const failing = {
      transport: 'custom',
      create: async () => {
        const transport = await server.config.create();
        // Close the server side so the handshake cannot complete.
        await server.close();
        return transport;
      },
      autoRegisterTools: true,
      requestTimeoutMs: 200,
    } as McpServerEntry;

    const error = await loadMcpServers({ flaky: failing }, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpConnectionError);
    expect(error).not.toBeInstanceOf(ToolLoadError);
  });
});
