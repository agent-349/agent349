import type { DeclarativeSkill, Skill, Tool, ToolDefinition } from '../types/index.js';
import { ConfigError, SDKError, ToolLoadError } from '../errors/index.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import type { InternalToolContext } from '../tools/internalTools.js';
import { INTERNAL_TOOL_FACTORIES, INTERNAL_TOOL_IDS } from '../tools/internalTools.js';
import type { McpToolBridge } from '../mcp/McpToolBridge.js';
import { ModuleResolver } from './ModuleResolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** How the loader reacts to a tool that fails to load. */
export type DeclarativeLoadMode = 'strict' | 'tolerant';

/** Collaborators the declarative loader writes into and resolves against. */
export interface DeclarativeLoadContext {
  /** Registry that receives the instantiated tools. */
  toolRegistry: ToolRegistry;
  /** Registry that receives the resolved skills. */
  skillRegistry: SkillRegistry;
  /** Services injected into internal (`kind: 'internal'`) tool factories. */
  internalToolContext: InternalToolContext;
  /** Resolver for external (`kind: 'module'`) tool specifiers. */
  resolver: ModuleResolver;
  /**
   * Bridges for MCP (`kind: 'mcp'`) tools, keyed by server name — produced by
   * `loadMcpServers`. Omit when no MCP servers are declared.
   */
  mcpBridges?: Map<string, McpToolBridge>;
  /** `'strict'` aborts on the first failure; `'tolerant'` skips and emits an event. */
  loadMode: DeclarativeLoadMode;
  /** Event sink for non-fatal diagnostics (wired to the EventBus). */
  emit: (event: string, data: Record<string, unknown>) => void;
}

/** Declarative sections extracted from the SDK config. */
export interface DeclarativeSections {
  tools?: ToolDefinition[];
  skills?: DeclarativeSkill[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instantiates and registers declaratively-configured tools and skills.
 *
 * Tools are loaded first (internal factories and external modules), then skills
 * are built by resolving their tool-name references against the now-populated
 * `ToolRegistry`. Agents are intentionally left to the caller, which owns the
 * agent map.
 *
 * In `'strict'` mode any tool failure throws; in `'tolerant'` mode the failure
 * is reported via {@link DeclarativeLoadContext.emit} and loading continues.
 *
 * @throws {@link ToolLoadError}  when a tool cannot be built (strict mode).
 * @throws {@link ConfigError}    when a skill references an unknown tool.
 */
export async function loadDeclarativeConfig(
  sections: DeclarativeSections,
  ctx: DeclarativeLoadContext,
): Promise<void> {
  // ── Tools ──────────────────────────────────────────────────────────────────
  for (const def of sections.tools ?? []) {
    try {
      const tool = await buildTool(def, ctx);
      ctx.toolRegistry.register(applyOverrides(tool, def));
    } catch (err) {
      const loadErr =
        err instanceof SDKError
          ? err
          : new ToolLoadError(
              def.name,
              err instanceof Error ? err.message : String(err),
              undefined,
              {
                cause: err instanceof Error ? err : undefined,
              },
            );
      if (ctx.loadMode === 'tolerant') {
        ctx.emit('config.tool.load.error', {
          toolName: def.name,
          error: loadErr.message,
        });
        continue;
      }
      throw loadErr;
    }
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  for (const decl of sections.skills ?? []) {
    ctx.skillRegistry.register(resolveSkill(decl, ctx.toolRegistry));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a single tool from its definition (internal factory or module import). */
async function buildTool(def: ToolDefinition, ctx: DeclarativeLoadContext): Promise<Tool> {
  if (def.kind === 'internal') {
    const factory = INTERNAL_TOOL_FACTORIES[def.ref];
    if (factory === undefined) {
      throw new ToolLoadError(
        def.name,
        `unknown internal ref '${def.ref}'. Known refs: ${INTERNAL_TOOL_IDS.join(', ')}`,
        def.ref,
      );
    }
    return factory(def.config, ctx.internalToolContext);
  }

  if (def.kind === 'mcp') {
    const bridge = ctx.mcpBridges?.get(def.server);
    if (bridge === undefined) {
      const known = [...(ctx.mcpBridges?.keys() ?? [])].join(', ');
      throw new ToolLoadError(
        def.name,
        `unknown MCP server '${def.server}'. Declare it under mcp.servers. ` +
          `Known servers: ${known || '(none)'}`,
        def.server,
      );
    }
    // Connects on demand and fetches the remote schema.
    return await bridge.createTool(def.remoteName);
  }

  const specifier = ctx.resolver.resolve(def.module);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: Record<string, any>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod = (await import(specifier)) as Record<string, any>;
  } catch (err) {
    throw new ToolLoadError(def.name, 'module import failed', def.module, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  const exported = pickExport(mod, def, specifier);
  const tool: unknown =
    typeof exported === 'function'
      ? (exported as (config: unknown) => unknown)(def.config)
      : exported;

  assertTool(tool, def, def.module);
  return tool;
}

/** Selects the configured export from a loaded module. */
function pickExport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod: Record<string, any>,
  def: Extract<ToolDefinition, { kind: 'module' }>,
  source: string,
): unknown {
  if (def.export !== undefined) {
    if (!(def.export in mod)) {
      throw new ToolLoadError(def.name, `module has no export '${def.export}'`, source);
    }
    return mod[def.export];
  }

  if (def.name in mod) {
    return mod[def.name];
  }

  // Fall back to the sole named export (ignoring the synthetic `default`).
  const named = Object.keys(mod).filter((k) => k !== 'default');
  if (named.length === 1) {
    return mod[named[0]!];
  }

  throw new ToolLoadError(
    def.name,
    `cannot pick an export. Set 'export' in the tool definition. Available: ${named.join(', ') || '(none)'}`,
    source,
  );
}

/** Validates that an arbitrary value is a usable {@link Tool}. */
function assertTool(value: unknown, def: ToolDefinition, source: string): asserts value is Tool {
  const hasExecute =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { execute?: unknown }).execute === 'function';

  if (!hasExecute) {
    throw new ToolLoadError(
      def.name,
      'resolved value is not a Tool (missing execute()). Export a Tool object or a (config) => Tool factory.',
      source,
    );
  }
}

/**
 * Returns a shallow copy of `tool` with the definition's name and metadata
 * overrides applied. The execute closure is preserved by reference.
 */
function applyOverrides(tool: Tool, def: ToolDefinition): Tool {
  return {
    ...tool,
    name: def.name,
    ...(def.tags !== undefined && { tags: def.tags }),
    ...(def.requiresApproval !== undefined && { requiresApproval: def.requiresApproval }),
    ...(def.sideEffects !== undefined && { sideEffects: def.sideEffects }),
    ...(def.timeout !== undefined && { timeout: def.timeout }),
    ...(def.retryPolicy !== undefined && { retryPolicy: def.retryPolicy }),
  };
}

/** Builds a runtime {@link Skill} by resolving tool-name references. */
function resolveSkill(decl: DeclarativeSkill, registry: ToolRegistry): Skill {
  const tools: Tool[] = decl.tools.map((name) => {
    const tool = registry.get(name);
    if (tool === undefined) {
      throw new ConfigError(
        `Skill '${decl.name}' references unknown tool '${name}'. ` +
          `Declare it in tools.definitions or register it in code before loading.`,
        `skills.${decl.name}.tools`,
      );
    }
    return tool;
  });

  return {
    name: decl.name,
    description: decl.description,
    tools,
    ...(decl.systemPromptAddition !== undefined && {
      systemPromptAddition: decl.systemPromptAddition,
    }),
    ...(decl.requiredRoles !== undefined && { requiredRoles: decl.requiredRoles }),
  };
}
