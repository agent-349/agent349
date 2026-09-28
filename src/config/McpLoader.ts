import { SDKError, ToolLoadError } from '../errors/index.js';
import type { EventBus } from '../events/EventBus.js';
import { McpClient } from '../mcp/McpClient.js';
import { McpToolBridge } from '../mcp/McpToolBridge.js';
import type { McpToolBridgeOptions } from '../mcp/McpToolBridge.js';
import type { McpServerConfig, McpServerEntry } from '../mcp/types.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { DeclarativeLoadMode } from './DeclarativeLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Collaborators the MCP loader writes into. */
export interface McpLoadContext {
  /** Registry that receives auto-registered tools. */
  toolRegistry: ToolRegistry;
  /** `'strict'` aborts on the first failure; `'tolerant'` skips and emits. */
  loadMode: DeclarativeLoadMode;
  /** Event sink for non-fatal diagnostics (wired to the EventBus). */
  emit: (event: string, data: Record<string, unknown>) => void;
  /** Bus forwarded to each client for connection-level events. */
  eventBus?: EventBus;
  /**
   * Pre-built clients keyed by server name, taking priority over the connection
   * details in `servers`. Bridging options still come from the matching
   * declaration when one exists.
   */
  injectedClients?: Record<string, McpClient>;
}

/** Outcome of connecting the declared MCP servers. */
export interface McpLoadResult {
  /**
   * Every client that was created, keyed by server name. The caller owns their
   * lifecycle and must close them on shutdown.
   */
  clients: Map<string, McpClient>;
  /** Bridges keyed by server name, consumed by `kind: 'mcp'` tool definitions. */
  bridges: Map<string, McpToolBridge>;
  /**
   * Tool names registered by `autoRegisterTools`, keyed by server name.
   *
   * Recorded so a later refresh knows exactly which registry entries it owns
   * and may remove — everything else was put there by someone else.
   */
  autoRegistered: Map<string, string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds one {@link McpClient} and {@link McpToolBridge} per declared server,
 * and registers the tools of any server marked `autoRegisterTools`.
 *
 * Servers without `autoRegisterTools` are **not** contacted here — their client
 * connects lazily, on the first `listTools()`/`callTool()`. That keeps startup
 * fast and avoids opening connections for servers whose tools are never used.
 *
 * Auto-registration runs before declarative `tools.definitions` are processed,
 * so an explicit definition always wins over an auto-registered tool of the
 * same name (last write wins, as elsewhere in the config system).
 *
 * @param servers - The `mcp.servers` config section. Omit for a no-op.
 * @param ctx     - Registry, load mode, and event wiring.
 * @returns The created clients and bridges, keyed by server name.
 * @throws {@link ToolLoadError} in `'strict'` mode when a server cannot be
 *         reached or its tools cannot be listed.
 */
export async function loadMcpServers(
  servers: Record<string, McpServerEntry> | undefined,
  ctx: McpLoadContext,
): Promise<McpLoadResult> {
  const clients = new Map<string, McpClient>();
  const bridges = new Map<string, McpToolBridge>();
  const autoRegistered = new Map<string, string[]>();

  const declarations = servers ?? {};
  const injected = ctx.injectedClients ?? {};
  // An injected client may have no declaration at all, and a declaration may
  // have no injected client — the union covers both.
  const names = new Set([...Object.keys(declarations), ...Object.keys(injected)]);

  for (const name of names) {
    const declaration = declarations[name];
    const client =
      injected[name] ??
      new McpClient(name, toServerConfig(declaration!), {
        ...(declaration!.requestTimeoutMs !== undefined && {
          requestTimeoutMs: declaration!.requestTimeoutMs,
        }),
        ...(ctx.eventBus !== undefined && { eventBus: ctx.eventBus }),
      });
    const bridge = new McpToolBridge(client, toBridgeOptions(declaration));

    clients.set(name, client);
    bridges.set(name, bridge);

    if (declaration?.autoRegisterTools !== true) continue;

    try {
      const tools = await bridge.createTools();
      ctx.toolRegistry.registerMany(tools);
      autoRegistered.set(
        name,
        tools.map((t) => t.name),
      );
      ctx.emit('config.mcp.server.loaded', { server: name, toolCount: tools.length });
    } catch (err) {
      const loadErr =
        err instanceof SDKError
          ? err
          : new ToolLoadError(
              `mcp:${name}`,
              err instanceof Error ? err.message : String(err),
              name,
              { cause: err instanceof Error ? err : undefined },
            );

      if (ctx.loadMode === 'tolerant') {
        ctx.emit('config.mcp.server.error', { server: name, error: loadErr.message });
        continue;
      }
      // Reap the connection we just opened before aborting startup.
      await client.close();
      throw loadErr;
    }
  }

  return { clients, bridges, autoRegistered };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extracts the connection half of a declaration, dropping bridging options. */
function toServerConfig(declaration: McpServerEntry): McpServerConfig {
  if (declaration.transport === 'custom') {
    return { transport: 'custom', create: declaration.create };
  }
  if (declaration.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: declaration.command,
      ...(declaration.args !== undefined && { args: declaration.args }),
      ...(declaration.env !== undefined && { env: declaration.env }),
      ...(declaration.cwd !== undefined && { cwd: declaration.cwd }),
    };
  }
  return {
    transport: 'http',
    url: declaration.url,
    ...(declaration.headers !== undefined && { headers: declaration.headers }),
  };
}

/** Maps the bridging half of a declaration onto bridge options. */
function toBridgeOptions(declaration: McpServerEntry | undefined): McpToolBridgeOptions {
  if (declaration === undefined) return {};
  return {
    ...(declaration.namespace !== undefined && { namespace: declaration.namespace }),
    ...(declaration.tags !== undefined && { tags: declaration.tags }),
    ...(declaration.requiresApproval !== undefined && {
      requiresApproval: declaration.requiresApproval,
    }),
    ...(declaration.toolTimeoutMs !== undefined && { timeout: declaration.toolTimeoutMs }),
    ...(declaration.maxTextLength !== undefined && { maxTextLength: declaration.maxTextLength }),
  };
}
