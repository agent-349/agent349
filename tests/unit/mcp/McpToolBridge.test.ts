import { describe, it, expect } from 'vitest';
import { McpClient } from '../../../src/mcp/McpClient.js';
import { McpToolBridge } from '../../../src/mcp/McpToolBridge.js';
import { McpToolError } from '../../../src/errors/index.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { startTestMcpServer } from '../../fixtures/mcpServer.js';
import type { FakeToolSpec, TestMcpServer } from '../../fixtures/mcpServer.js';
import type { ExecutionContext } from '../../../src/types/index.js';

const CONTEXT: ExecutionContext = {
  tenantId: 't1',
  userId: 'u1',
  roles: ['user'],
  sessionId: 's1',
  agentId: 'a1',
  requestId: 'r1',
};

const ECHO_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

/** Spins up a server + connected client + bridge for one test. */
async function setup(
  tools: FakeToolSpec[],
  options?: ConstructorParameters<typeof McpToolBridge>[1],
): Promise<{
  bridge: McpToolBridge;
  client: McpClient;
  server: TestMcpServer;
  cleanup: () => Promise<void>;
}> {
  const server = await startTestMcpServer({ tools });
  const client = new McpClient('files', server.config);
  const bridge = new McpToolBridge(client, options);
  return {
    bridge,
    client,
    server,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('McpToolBridge', () => {
  describe('descriptor mapping', () => {
    it('namespaces tool names under the server name', async () => {
      const { bridge, cleanup } = await setup([
        { name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') },
      ]);

      const [tool] = await bridge.createTools();

      expect(tool!.name).toBe('files.read_file');
      await cleanup();
    });

    it('honours a custom namespace and separator', async () => {
      const { bridge, cleanup } = await setup(
        [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
        { namespace: 'fs', separator: '__' },
      );

      const [tool] = await bridge.createTools();

      expect(tool!.name).toBe('fs__read_file');
      await cleanup();
    });

    it('falls back to the annotation title then a generated description', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'titled',
          inputSchema: { type: 'object' },
          annotations: { title: 'Titled Tool' },
          handler: () => textResult('ok'),
        },
        { name: 'bare', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
      ]);

      const tools = await bridge.createTools();

      expect(tools[0]!.description).toBe('Titled Tool');
      expect(tools[1]!.description).toBe("MCP tool 'bare'");
      await cleanup();
    });

    it("leaves requiresApproval unset, ignoring the server's readOnlyHint", async () => {
      // Risk follows what a tool does and how far the server is trusted —
      // neither of which a self-asserted annotation can establish. A hostile
      // server would only have to claim readOnlyHint to lower its own guard.
      const { bridge, cleanup } = await setup([
        { name: 'writer', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
        {
          name: 'reader',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
          handler: () => textResult('ok'),
        },
      ]);

      const tools = await bridge.createTools();

      expect(tools[0]!.requiresApproval).toBeUndefined();
      expect(tools[1]!.requiresApproval).toBeUndefined();
      await cleanup();
    });

    it('sets requiresApproval on every tool when configured', async () => {
      const { bridge, cleanup } = await setup(
        [
          {
            name: 'reader',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
            handler: () => textResult('ok'),
          },
          { name: 'writer', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
        ],
        { requiresApproval: true },
      );

      const tools = await bridge.createTools();

      // Applies uniformly: the hint does not carve out an exception.
      expect(tools.map((t) => t.requiresApproval)).toEqual([true, true]);
      await cleanup();
    });

    it('tags bridged tools with mcp and the namespace by default', async () => {
      const { bridge, cleanup } = await setup([
        { name: 'read_file', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
      ]);

      const [tool] = await bridge.createTools();

      expect(tool!.tags).toEqual(['mcp', 'files']);
      await cleanup();
    });

    it('carries timeout and retryPolicy onto every bridged tool', async () => {
      const retryPolicy = { maxRetries: 5, backoffMs: 10, backoffMultiplier: 2 };
      const { bridge, cleanup } = await setup(
        [{ name: 'read_file', inputSchema: { type: 'object' }, handler: () => textResult('ok') }],
        { timeout: 1234, retryPolicy },
      );

      const [tool] = await bridge.createTools();

      expect(tool!.timeout).toBe(1234);
      expect(tool!.retryPolicy).toEqual(retryPolicy);
      await cleanup();
    });

    it('applies the filter predicate', async () => {
      const { bridge, cleanup } = await setup(
        [
          { name: 'safe_read', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
          {
            name: 'danger_delete',
            inputSchema: { type: 'object' },
            handler: () => textResult('ok'),
          },
        ],
        { filter: (info) => info.name.startsWith('safe_') },
      );

      const tools = await bridge.createTools();

      expect(tools.map((t) => t.name)).toEqual(['files.safe_read']);
      await cleanup();
    });
  });

  describe('createTool', () => {
    it('bridges a single tool by remote name', async () => {
      const { bridge, cleanup } = await setup([
        { name: 'a', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
        { name: 'b', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
      ]);

      const tool = await bridge.createTool('b');

      expect(tool.name).toBe('files.b');
      await cleanup();
    });

    it('throws McpToolError listing available tools when unknown', async () => {
      const { bridge, cleanup } = await setup([
        { name: 'a', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
      ]);

      await expect(bridge.createTool('nope')).rejects.toThrow(/Available tools: a/);
      await expect(bridge.createTool('nope')).rejects.toThrow(McpToolError);
      await cleanup();
    });
  });

  describe('result mapping', () => {
    it('joins text blocks into a string', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'multi',
          inputSchema: { type: 'object' },
          handler: () => ({
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          }),
        },
      ]);

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result).toEqual({ success: true, data: 'line one\nline two' });
      await cleanup();
    });

    it('prefers structuredContent over text blocks', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'structured',
          inputSchema: { type: 'object' },
          handler: () => ({
            content: [{ type: 'text', text: '{"total":42}' }],
            structuredContent: { total: 42 },
          }),
        },
      ]);

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result).toEqual({ success: true, data: { total: 42 } });
      await cleanup();
    });

    it('maps isError to a failed ToolResult carrying the server message', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'failing',
          inputSchema: { type: 'object' },
          handler: () => ({ content: [{ type: 'text', text: 'file not found' }], isError: true }),
        },
      ]);

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result).toEqual({ success: false, error: 'file not found' });
      await cleanup();
    });

    it('returns null data for empty content', async () => {
      const { bridge, cleanup } = await setup([
        { name: 'silent', inputSchema: { type: 'object' }, handler: () => ({ content: [] }) },
      ]);

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result).toEqual({ success: true, data: null });
      await cleanup();
    });

    it('preserves the raw blocks when content is mixed', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'mixed',
          inputSchema: { type: 'object' },
          handler: () => ({
            content: [
              { type: 'text', text: 'here is a chart' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          }),
        },
      ]);

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        { type: 'text', text: 'here is a chart' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ]);
      await cleanup();
    });

    it('truncates oversized text with an explicit marker', async () => {
      const { bridge, cleanup } = await setup(
        [
          {
            name: 'huge',
            inputSchema: { type: 'object' },
            handler: () => textResult('x'.repeat(500)),
          },
        ],
        { maxTextLength: 100 },
      );

      const [tool] = await bridge.createTools();
      const result = await tool!.execute({}, CONTEXT);

      expect(result.data).toContain('…[truncated 400 characters]');
      expect(String(result.data).startsWith('x'.repeat(100))).toBe(true);
      await cleanup();
    });
  });

  describe('integration with the tool pipeline', () => {
    it('executes end-to-end through ToolRegistry and ToolExecutor', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'echo',
          description: 'Echoes input',
          inputSchema: ECHO_SCHEMA,
          handler: (args) => textResult(`echo: ${String(args['message'])}`),
        },
      ]);

      const bus = new EventBus();
      const events: string[] = [];
      bus.on('tool.*', (e) => events.push(e.type));

      const registry = new ToolRegistry();
      registry.registerMany(await bridge.createTools(), 'mcp-files');
      const executor = new ToolExecutor(registry, bus);

      const result = await executor.execute('files.echo', { message: 'hi' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(result.data).toBe('echo: hi');
      expect(events).toEqual(['tool.call.start', 'tool.call.end']);
      expect(registry.getDescriptors({ skillName: 'mcp-files' })).toHaveLength(1);

      await cleanup();
    });

    it('rejects input that violates the remote inputSchema before calling the server', async () => {
      const { bridge, server, cleanup } = await setup([
        {
          name: 'echo',
          inputSchema: ECHO_SCHEMA,
          handler: (args) => textResult(String(args['message'])),
        },
      ]);

      const registry = new ToolRegistry();
      registry.registerMany(await bridge.createTools());
      const executor = new ToolExecutor(registry, new EventBus());

      // `message` is required by the remote schema.
      const result = await executor.execute('files.echo', { wrong: 1 }, CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Input validation failed');
      expect(server.calls).toHaveLength(0);

      await cleanup();
    });

    it('compiles a draft-2020-12 remote schema without AJV rejecting it', async () => {
      const { bridge, cleanup } = await setup([
        {
          name: 'echo',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
          handler: (args) => textResult(String(args['message'])),
        },
      ]);

      const registry = new ToolRegistry();
      registry.registerMany(await bridge.createTools());
      const executor = new ToolExecutor(registry, new EventBus());

      const result = await executor.execute('files.echo', { message: 'ok' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(result.data).toBe('ok');

      await cleanup();
    });
  });
});
