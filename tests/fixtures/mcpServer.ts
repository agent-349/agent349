import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpCustomServerConfig } from '../../src/mcp/types.js';

/**
 * Declaration of a tool exposed by the in-process test server.
 *
 * `inputSchema` and the handler's return value are passed onto the wire almost
 * verbatim, so tests can reproduce exactly what a real server would send —
 * including quirks such as a `$schema` dialect the SDK has to strip.
 */
export interface FakeToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Returns the raw `tools/call` result, or throws to produce a JSON-RPC error. */
  handler?: (args: Record<string, unknown>) => unknown;
}

/** Handle returned by {@link startTestMcpServer}. */
export interface TestMcpServer {
  /** Server config to hand to an `McpClient`. */
  config: McpCustomServerConfig;
  /** Arguments received by each `tools/call`, in order. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Number of `tools/list` requests served (used to assert handshake reuse). */
  readonly listCount: number;
  /** Number of times a transport was created (i.e. connections opened). */
  readonly connectCount: number;
  /**
   * Replaces the advertised catalogue, simulating a server that gains or drops
   * tools while the client is connected.
   */
  setTools(tools: FakeToolSpec[]): void;
  close(): Promise<void>;
}

/**
 * Starts a real MCP server wired to an in-memory transport pair.
 *
 * Using the genuine `Server` implementation (rather than a hand-rolled JSON-RPC
 * fake) means these stay honest about the protocol while running entirely
 * in-process — no child processes, no sockets, no network.
 *
 * @param options.tools    - Tools the server advertises.
 * @param options.pageSize - When set, `tools/list` paginates at this size so
 *                           cursor-following can be exercised.
 */
export async function startTestMcpServer(options: {
  tools: FakeToolSpec[];
  pageSize?: number;
}): Promise<TestMcpServer> {
  const { pageSize } = options;
  let tools = options.tools;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let listCount = 0;
  let connectCount = 0;

  const server = new Server(
    { name: 'test-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    listCount += 1;

    const descriptors = tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      inputSchema: t.inputSchema,
      ...(t.outputSchema !== undefined && { outputSchema: t.outputSchema }),
      ...(t.annotations !== undefined && { annotations: t.annotations }),
    }));

    if (pageSize === undefined) {
      return { tools: descriptors } as never;
    }

    const start = Number(request.params?.cursor ?? '0');
    const page = descriptors.slice(start, start + pageSize);
    const next = start + pageSize;

    return {
      tools: page,
      ...(next < descriptors.length && { nextCursor: String(next) }),
    } as never;
  });

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    calls.push({ name, args });

    const spec = tools.find((t) => t.name === name);
    if (spec?.handler === undefined) {
      throw new Error(`unknown tool: ${name}`);
    }
    return spec.handler(args) as never;
  });

  const serverTransports: InMemoryTransport[] = [];

  const config: McpCustomServerConfig = {
    transport: 'custom',
    create: async () => {
      connectCount += 1;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      serverTransports.push(serverTransport);
      // Connect the server first so the handshake has a listener waiting.
      await server.connect(serverTransport);
      return clientTransport;
    },
  };

  return {
    config,
    calls,
    setTools: (next: FakeToolSpec[]) => {
      tools = next;
    },
    get listCount() {
      return listCount;
    },
    get connectCount() {
      return connectCount;
    },
    close: async () => {
      await server.close();
      await Promise.all(serverTransports.map((t) => t.close()));
    },
  };
}
