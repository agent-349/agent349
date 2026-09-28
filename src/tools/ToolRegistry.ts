import type { Tool, ToolDescriptor, ToolFilter } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the pure {@link ToolDescriptor} fields from a {@link Tool},
 * deliberately excluding the `execute` implementation so that the object
 * returned by {@link ToolRegistry.getDescriptors} is safe to serialise and
 * forward to an LLM provider.
 */
function toDescriptor(tool: Tool): ToolDescriptor {
  const base: ToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };

  // Conditional assignment required by `exactOptionalPropertyTypes`.
  if (tool.outputSchema !== undefined) base.outputSchema = tool.outputSchema;
  if (tool.tags !== undefined) base.tags = tool.tags;
  if (tool.requiresApproval !== undefined) base.requiresApproval = tool.requiresApproval;
  if (tool.timeout !== undefined) base.timeout = tool.timeout;
  if (tool.retryPolicy !== undefined) base.retryPolicy = tool.retryPolicy;

  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolRegistry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central registry of all {@link Tool | tools} available to agents.
 *
 * Tools are stored by their unique `name`. Registering a tool whose name is
 * already present **replaces** the existing entry (last write wins).
 *
 * ### Skill association
 * An optional `skillName` can be supplied when registering tools so that
 * {@link getDescriptors} can filter by skill. The `SkillRegistry` sets this
 * automatically when it registers a skill's tools.
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry();
 * registry.register(getBalanceTool, 'finance');
 * registry.registerMany([searchTool, summaryTool], 'rag');
 *
 * // All finance descriptors (safe to pass to the LLM)
 * const descs = registry.getDescriptors({ skillName: 'finance' });
 * ```
 */
export class ToolRegistry {
  /** Stored tools keyed by tool name. */
  readonly #tools = new Map<string, Tool>();

  /**
   * Maps each tool name to the skill it was registered under.
   * Only set when a `skillName` is provided at registration time.
   */
  readonly #skillMap = new Map<string, string>();

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a single tool.
   * If a tool with the same `name` already exists it is replaced.
   *
   * @param tool      - The tool to register.
   * @param skillName - Optional skill this tool belongs to (used by `getDescriptors` filter).
   */
  register(tool: Tool, skillName?: string): void {
    this.#tools.set(tool.name, tool);
    if (skillName !== undefined) {
      this.#skillMap.set(tool.name, skillName);
    } else {
      // Clear any previous skill association when re-registering without one.
      this.#skillMap.delete(tool.name);
    }
  }

  /**
   * Registers multiple tools in one call.
   * Equivalent to calling {@link register} for each tool individually.
   *
   * @param tools     - Array of tools to register.
   * @param skillName - Optional skill all these tools belong to.
   */
  registerMany(tools: Tool[], skillName?: string): void {
    for (const tool of tools) {
      this.register(tool, skillName);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lookup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves the full {@link Tool} (including `execute`) by name.
   *
   * @param name - Exact tool name.
   * @returns The tool, or `undefined` if not registered.
   */
  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /**
   * Returns `true` if a tool with the given name is registered.
   *
   * @param name - Exact tool name.
   */
  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * Returns the names of all registered tools, in insertion order.
   */
  list(): string[] {
    return [...this.#tools.keys()];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Descriptor access
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns an array of {@link ToolDescriptor} objects for tools that match
   * the optional filter. All filters are applied together (AND semantics).
   *
   * **Filter rules:**
   * - `names`     — tool name must be in the provided list.
   * - `tags`      — tool must carry **every** tag in the list.
   * - `skillName` — tool must have been registered under that skill name.
   *
   * Omitting a filter criterion means "match all" for that criterion.
   *
   * @param filter - Optional filter criteria. Omit to get all descriptors.
   * @returns Array of matching descriptors (safe to serialise to JSON).
   */
  getDescriptors(filter?: ToolFilter): ToolDescriptor[] {
    const result: ToolDescriptor[] = [];

    for (const tool of this.#tools.values()) {
      if (filter !== undefined) {
        if (filter.names !== undefined && !filter.names.includes(tool.name)) continue;

        if (filter.tags !== undefined) {
          const toolTags = tool.tags ?? [];
          const allMatch = filter.tags.every((tag) => toolTags.includes(tag));
          if (!allMatch) continue;
        }

        if (filter.skillName !== undefined) {
          if (this.#skillMap.get(tool.name) !== filter.skillName) continue;
        }
      }

      result.push(toDescriptor(tool));
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Removal
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Removes a tool from the registry.
   *
   * @param name - Exact tool name to remove.
   * @returns `true` if the tool existed and was removed, `false` if not found.
   * @remarks Never throws — returns `false` instead, so callers can decide
   *          whether a missing tool is an error in their context.
   */
  unregister(name: string): boolean {
    if (!this.#tools.has(name)) return false;
    this.#tools.delete(name);
    this.#skillMap.delete(name);
    return true;
  }
}
