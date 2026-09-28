/**
 * A real MCP server over stdio, spawned as a child process by the integration
 * tests.
 *
 * Plain `.mjs` so it can be launched with `node` directly — no loader, no
 * transpile step. Deliberately minimal: the point is to exercise the actual
 * stdio transport, process spawning, and reaping, not protocol breadth.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'stdio-integration-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the message back.',
      inputSchema: {
        // Mirrors what zod-based servers emit; the SDK must strip it so AJV
        // does not reject the schema outright.
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    {
      name: 'boom',
      description: 'Always reports an application-level failure.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};

  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${String(args.message)}` }] };
  }
  if (name === 'boom') {
    return { content: [{ type: 'text', text: 'deliberate failure' }], isError: true };
  }
  throw new Error(`unknown tool: ${name}`);
});

// stdout belongs to the protocol. Diagnostics go to stderr, which the SDK
// drains into `mcp.server.stderr` events.
process.stderr.write('stdio-integration-server ready\n');

await server.connect(new StdioServerTransport());
