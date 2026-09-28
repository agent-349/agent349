import { describe, it, expect } from 'vitest';
import { McpClient } from '../../../src/mcp/McpClient.js';
import { McpConnectionError, McpToolError } from '../../../src/errors/index.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { startTestMcpServer } from '../../fixtures/mcpServer.js';
import type { AgentEvent } from '../../../src/types/index.js';

const ECHO_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

describe('McpClient', () => {
  describe('listTools', () => {
    it('normalises remote descriptors into McpToolInfo', async () => {
      const server = await startTestMcpServer({
        tools: [
          {
            name: 'echo',
            description: 'Echoes the message',
            inputSchema: ECHO_SCHEMA,
            outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
            annotations: { title: 'Echo', readOnlyHint: true },
            handler: (args) => textResult(String(args['message'])),
          },
        ],
      });
      const client = new McpClient('test', server.config);

      const tools = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'echo',
        description: 'Echoes the message',
        inputSchema: ECHO_SCHEMA,
        annotations: { title: 'Echo', readOnlyHint: true },
      });
      expect(tools[0]!.outputSchema).toEqual({
        type: 'object',
        properties: { echoed: { type: 'string' } },
      });

      await client.close();
      await server.close();
    });

    it('strips the $schema dialect so AJV can compile the schema', async () => {
      // Servers built on zod-to-json-schema advertise draft 2020-12, which the
      // ToolExecutor's default-mode AJV instance rejects outright.
      const server = await startTestMcpServer({
        tools: [
          {
            name: 'echo',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { message: { type: 'string' } },
            },
            handler: () => textResult('ok'),
          },
        ],
      });
      const client = new McpClient('test', server.config);

      const tools = await client.listTools();

      expect(tools[0]!.inputSchema).not.toHaveProperty('$schema');
      expect(tools[0]!.inputSchema).toMatchObject({ type: 'object' });

      await client.close();
      await server.close();
    });

    it('follows nextCursor pagination until exhausted', async () => {
      const tools = Array.from({ length: 5 }, (_, i) => ({
        name: `tool_${i}`,
        inputSchema: { type: 'object' },
        handler: () => textResult('ok'),
      }));
      const server = await startTestMcpServer({ tools, pageSize: 2 });
      const client = new McpClient('test', server.config);

      const listed = await client.listTools();

      expect(listed.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
      expect(server.listCount).toBe(3); // 2 + 2 + 1

      await client.close();
      await server.close();
    });
  });

  describe('callTool', () => {
    it('forwards arguments and returns normalised content', async () => {
      const server = await startTestMcpServer({
        tools: [
          {
            name: 'echo',
            inputSchema: ECHO_SCHEMA,
            handler: (args) => textResult(`echo: ${String(args['message'])}`),
          },
        ],
      });
      const client = new McpClient('test', server.config);

      const result = await client.callTool('echo', { message: 'hi' });

      expect(result.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
      expect(result.isError).toBeUndefined();
      expect(server.calls).toEqual([{ name: 'echo', args: { message: 'hi' } }]);

      await client.close();
      await server.close();
    });

    it('preserves isError and structuredContent', async () => {
      const server = await startTestMcpServer({
        tools: [
          {
            name: 'failing',
            inputSchema: { type: 'object' },
            handler: () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
          },
          {
            name: 'structured',
            inputSchema: { type: 'object' },
            handler: () => ({
              content: [{ type: 'text', text: '{"ok":true}' }],
              structuredContent: { ok: true },
            }),
          },
        ],
      });
      const client = new McpClient('test', server.config);

      const failed = await client.callTool('failing', {});
      expect(failed.isError).toBe(true);

      const structured = await client.callTool('structured', {});
      expect(structured.structuredContent).toEqual({ ok: true });

      await client.close();
      await server.close();
    });

    it('wraps protocol-level failures in McpToolError', async () => {
      const server = await startTestMcpServer({
        tools: [
          { name: 'known', inputSchema: { type: 'object' }, handler: () => textResult('ok') },
        ],
      });
      const client = new McpClient('test', server.config);

      await expect(client.callTool('does_not_exist', {})).rejects.toThrow(McpToolError);

      await client.close();
      await server.close();
    });
  });

  describe('lifecycle', () => {
    it('opens a single connection across concurrent and repeated calls', async () => {
      const server = await startTestMcpServer({
        tools: [{ name: 'echo', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
      });
      const client = new McpClient('test', server.config);

      await Promise.all([client.connect(), client.connect(), client.listTools()]);
      await client.connect();

      expect(server.connectCount).toBe(1);
      expect(client.connected).toBe(true);

      await client.close();
      await server.close();
    });

    it('rejects operations after close and closes idempotently', async () => {
      const server = await startTestMcpServer({
        tools: [{ name: 'echo', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
      });
      const client = new McpClient('test', server.config);
      await client.connect();

      await client.close();
      await client.close(); // idempotent

      expect(client.connected).toBe(false);
      await expect(client.listTools()).rejects.toThrow(McpConnectionError);

      await server.close();
    });

    it('closes cleanly when never connected', async () => {
      const client = new McpClient('test', { transport: 'stdio', command: 'nonexistent-binary' });
      await expect(client.close()).resolves.toBeUndefined();
    });

    it('does not leave a connection open when closed mid-handshake', async () => {
      const server = await startTestMcpServer({
        tools: [{ name: 'echo', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
      });
      const client = new McpClient('test', server.config);

      // Start connecting, then close before the handshake settles.
      const connecting = client.connect();
      const closing = client.close();

      await expect(connecting).rejects.toThrow(McpConnectionError);
      await closing;
      expect(client.connected).toBe(false);

      await server.close();
    });

    it('emits connection events on the EventBus', async () => {
      const server = await startTestMcpServer({
        tools: [{ name: 'echo', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
      });
      const bus = new EventBus();
      const events: AgentEvent[] = [];
      bus.on('mcp.*', (e) => events.push(e));

      const client = new McpClient('test', server.config, { eventBus: bus });
      await client.connect();
      await client.close();

      expect(events.map((e) => e.type)).toEqual(['mcp.server.connect', 'mcp.server.close']);
      expect(events[0]!.data['server']).toBe('test');

      await server.close();
    });

    it('surfaces a handshake failure as McpConnectionError', async () => {
      const client = new McpClient('broken', {
        transport: 'custom',
        create: () => {
          throw new Error('transport unavailable');
        },
      });

      await expect(client.connect()).rejects.toThrow(McpConnectionError);
    });

    it('allows retrying connect after a failed handshake', async () => {
      let attempts = 0;
      const server = await startTestMcpServer({
        tools: [{ name: 'echo', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
      });

      const client = new McpClient('flaky', {
        transport: 'custom',
        create: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary failure');
          return await server.config.create();
        },
      });

      await expect(client.connect()).rejects.toThrow(McpConnectionError);
      await expect(client.connect()).resolves.toBeUndefined();
      expect(client.connected).toBe(true);

      await client.close();
      await server.close();
    });
  });
});
