import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpConnectionError, McpToolError } from '../errors/index.js';
import type { EventBus } from '../events/EventBus.js';
import type { JSONSchema } from '../types/index.js';
import type {
  McpCallResult,
  McpContentBlock,
  McpServerConfig,
  McpToolAnnotations,
  McpToolInfo,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & options
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Identity this SDK advertises to MCP servers during the handshake. */
const CLIENT_INFO = { name: 'agent349', version: '0.1.0' } as const;

/** Constructor options for {@link McpClient}. */
export interface McpClientOptions {
  /**
   * Timeout applied to the handshake and to every subsequent request.
   * @default 30_000
   */
  requestTimeoutMs?: number;
  /**
   * Event sink for connection diagnostics. When supplied the client emits
   * `mcp.server.connect`, `mcp.server.close`, `mcp.server.error` and
   * `mcp.server.stderr`.
   */
  eventBus?: EventBus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes the top-level `$schema` keyword from a remote JSON Schema.
 *
 * MCP servers built on `zod-to-json-schema` routinely advertise
 * `"$schema": ".../draft/2020-12/schema"`, but the `ToolExecutor` validates
 * with AJV 8 in its default draft-07 mode, which **throws** on an unrecognised
 * `$schema`. Stripping the keyword lets AJV compile the schema with its default
 * dialect instead of rejecting the tool outright.
 */
function stripSchemaDialect(schema: JSONSchema): JSONSchema {
  if (!('$schema' in schema)) return schema;
  const rest = { ...schema };
  delete rest['$schema'];
  return rest;
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalises one `tools/list` entry into an {@link McpToolInfo}. */
function toToolInfo(raw: Record<string, unknown>): McpToolInfo {
  const info: McpToolInfo = {
    name: String(raw['name']),
    inputSchema: isRecord(raw['inputSchema'])
      ? stripSchemaDialect(raw['inputSchema'])
      : { type: 'object' },
  };

  // Conditional assignment required by `exactOptionalPropertyTypes`.
  if (typeof raw['description'] === 'string') info.description = raw['description'];
  if (isRecord(raw['outputSchema'])) info.outputSchema = stripSchemaDialect(raw['outputSchema']);
  if (isRecord(raw['annotations'])) info.annotations = raw['annotations'] as McpToolAnnotations;

  return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// McpClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A thin, SDK-flavoured wrapper around the official MCP client.
 *
 * It owns one connection to one MCP server and exposes only the two operations
 * the tool layer needs — {@link listTools} and {@link callTool} — normalising
 * the protocol's response shapes into this SDK's own types so that the MCP
 * SDK never leaks past this module.
 *
 * ### Optional dependency
 * `@modelcontextprotocol/sdk` is an **optional** dependency, imported
 * dynamically on first connect. Projects that do not use MCP are not forced to
 * install it; those that do get a clear {@link McpConnectionError} if it is
 * missing.
 *
 * ### Lifecycle
 * {@link connect} is idempotent and safe to call concurrently — overlapping
 * calls share a single in-flight handshake. {@link listTools} and
 * {@link callTool} connect on demand, so callers rarely need to call it
 * directly. Always {@link close} the client on shutdown to reap child
 * processes and release HTTP sessions.
 *
 * @example
 * ```typescript
 * const client = new McpClient('filesystem', {
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
 * }, { eventBus: bus });
 *
 * const tools = await client.listTools();
 * const result = await client.callTool('read_file', { path: '/data/a.txt' });
 * await client.close();
 * ```
 */
export class McpClient {
  /** Logical name of this server, used to namespace its tools. */
  readonly name: string;

  readonly #config: McpServerConfig;
  readonly #timeoutMs: number;
  readonly #bus: EventBus | undefined;

  #client: Client | undefined;
  /** In-flight handshake, shared by concurrent `connect()` callers. */
  #connecting: Promise<Client> | undefined;
  #closed = false;

  /**
   * @param name    - Logical server name. Becomes the default tool namespace,
   *                  so keep it short and stable (e.g. `'filesystem'`).
   * @param config  - Transport and connection settings.
   * @param options - Timeouts and event wiring.
   */
  constructor(name: string, config: McpServerConfig, options: McpClientOptions = {}) {
    this.name = name;
    this.#config = config;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#bus = options.eventBus;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /** Whether the handshake has completed and the client has not been closed. */
  get connected(): boolean {
    return this.#client !== undefined && !this.#closed;
  }

  /**
   * Opens the connection and performs the MCP handshake.
   *
   * Idempotent: returns immediately if already connected, and concurrent calls
   * share one handshake rather than opening duplicate connections.
   *
   * @throws {@link McpConnectionError} if the optional MCP SDK is missing, the
   *         client has been closed, or the handshake fails.
   */
  async connect(): Promise<void> {
    await this.#ensureClient();
  }

  /**
   * Lists every tool the server exposes, following `nextCursor` pagination
   * until the server reports no further pages.
   *
   * @returns Normalised tool descriptors, in server order.
   * @throws {@link McpConnectionError} if the connection cannot be established.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const client = await this.#ensureClient();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;

    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: this.#timeoutMs,
      });

      for (const raw of page.tools) {
        tools.push(toToolInfo(raw as unknown as Record<string, unknown>));
      }

      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor !== undefined);

    return tools;
  }

  /**
   * Invokes a tool on the server.
   *
   * A tool that runs but reports failure comes back as a normal result with
   * `isError: true` — only protocol-level failures throw.
   *
   * @param remoteName - Tool name as exposed by the server (not namespaced).
   * @param args       - Arguments object, matching the tool's `inputSchema`.
   * @returns The normalised call result.
   * @throws {@link McpToolError} on a JSON-RPC error or request timeout.
   * @throws {@link McpConnectionError} if the connection cannot be established.
   */
  async callTool(remoteName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = await this.#ensureClient();

    let raw: Awaited<ReturnType<Client['callTool']>>;
    try {
      raw = await client.callTool({ name: remoteName, arguments: args }, undefined, {
        timeout: this.#timeoutMs,
      });
    } catch (err) {
      throw new McpToolError(
        this.name,
        remoteName,
        err instanceof Error ? err.message : String(err),
        {
          cause: err instanceof Error ? err : undefined,
        },
      );
    }

    const result: McpCallResult = {
      content: Array.isArray(raw.content) ? (raw.content as McpContentBlock[]) : [],
    };
    if (raw.structuredContent !== undefined) result.structuredContent = raw.structuredContent;
    if (raw.isError === true) result.isError = true;

    return result;
  }

  /**
   * Closes the connection, terminating the child process (stdio) or ending the
   * session (HTTP). Idempotent — calling it more than once is safe, and a
   * client that was never connected closes cleanly.
   *
   * Once closed the client cannot be reconnected; construct a new one instead.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    // Let an in-flight handshake settle so we never leak a half-open connection.
    const pending = this.#connecting;
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }

    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    if (client === undefined) return;

    try {
      await client.close();
      this.#bus?.emit('mcp.server.close', { server: this.name });
    } catch (err) {
      // Surface but never throw from shutdown — callers close many clients at once.
      this.#bus?.emit('mcp.server.error', {
        server: this.name,
        phase: 'close',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Returns the connected client, performing the handshake on first use.
   * Concurrent callers await the same in-flight promise.
   */
  async #ensureClient(): Promise<Client> {
    if (this.#closed) {
      throw new McpConnectionError(this.name, 'client is closed');
    }
    if (this.#client !== undefined) return this.#client;
    if (this.#connecting !== undefined) return this.#connecting;

    this.#connecting = this.#doConnect();
    try {
      const client = await this.#connecting;

      // `close()` may have been called while the handshake was in flight. Reap
      // the freshly-opened connection instead of publishing it, otherwise a
      // child process would outlive the client that owns it.
      if (this.#closed) {
        await client.close().catch(() => undefined);
        throw new McpConnectionError(this.name, 'client was closed during connect');
      }

      this.#client = client;
      return client;
    } finally {
      this.#connecting = undefined;
    }
  }

  /** Performs the actual dynamic import, transport build, and handshake. */
  async #doConnect(): Promise<Client> {
    const { Client: McpSdkClient } = await this.#importSdk();

    // Transport construction is as failure-prone as the handshake itself — a
    // malformed URL, a spawn error, or a throwing custom factory all land here
    // — so it shares the same error translation.
    let transport: unknown;
    let client: Client;
    try {
      transport = await this.#createTransport();
      client = new McpSdkClient(CLIENT_INFO);
      await client.connect(transport as Parameters<Client['connect']>[0], {
        timeout: this.#timeoutMs,
      });
    } catch (err) {
      this.#bus?.emit('mcp.server.error', {
        server: this.name,
        phase: 'connect',
        error: err instanceof Error ? err.message : String(err),
      });
      throw new McpConnectionError(
        this.name,
        `connection failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    this.#drainStderr(transport);
    this.#bus?.emit('mcp.server.connect', {
      server: this.name,
      transport: this.#config.transport,
    });

    return client;
  }

  /**
   * Dynamically imports the optional MCP SDK, translating a missing package
   * into an actionable {@link McpConnectionError}.
   */
  async #importSdk(): Promise<typeof import('@modelcontextprotocol/sdk/client/index.js')> {
    try {
      return await import('@modelcontextprotocol/sdk/client/index.js');
    } catch (err) {
      throw new McpConnectionError(
        this.name,
        "the optional dependency '@modelcontextprotocol/sdk' is not installed. " +
          'Run `npm install @modelcontextprotocol/sdk` to enable MCP support.',
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  /** Builds the transport described by the server config. */
  async #createTransport(): Promise<unknown> {
    const config = this.#config;

    if (config.transport === 'custom') {
      return await config.create();
    }

    if (config.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      return new StdioClientTransport({
        command: config.command,
        ...(config.args !== undefined && { args: config.args }),
        ...(config.env !== undefined && { env: config.env }),
        ...(config.cwd !== undefined && { cwd: config.cwd }),
        // Never let a child process write to the host's stderr: the SDK owns no
        // output streams. Piped output is drained into the EventBus instead.
        stderr: 'pipe',
      });
    }

    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.headers !== undefined && { requestInit: { headers: config.headers } }),
    });
  }

  /**
   * Attaches a reader to a stdio child's stderr.
   *
   * The stream is drained unconditionally — an unread piped stream applies
   * backpressure and can stall the child process — while lines are forwarded
   * to the EventBus only when one is configured.
   */
  #drainStderr(transport: unknown): void {
    if (this.#config.transport !== 'stdio') return;

    const stream = (
      transport as { stderr?: { on?: (e: string, cb: (c: unknown) => void) => void } }
    ).stderr;
    if (stream?.on === undefined) return;

    stream.on('data', (chunk: unknown) => {
      const message = String(chunk).trimEnd();
      if (message.length > 0) {
        this.#bus?.emit('mcp.server.stderr', { server: this.name, message });
      }
    });
  }
}
