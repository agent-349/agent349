import { McpToolError } from '../errors/index.js';
import type { ExecutionContext, RetryPolicy, Tool, ToolResult } from '../types/index.js';
import type { McpClient } from './McpClient.js';
import type { McpCallResult, McpContentBlock, McpToolInfo } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safety net for oversized tool output. Base64 image/audio blocks can be
 * megabytes; feeding those verbatim to an LLM wastes the context window and
 * the request usually fails anyway. Truncation is always marked inline.
 */
const DEFAULT_MAX_TEXT_LENGTH = 100_000;

/** Options controlling how remote tools are mapped onto SDK {@link Tool}s. */
export interface McpToolBridgeOptions {
  /**
   * Prefix for generated tool names.
   * @default the client's `name`
   */
  namespace?: string;
  /**
   * Separator between namespace and remote tool name. The default matches the
   * SDK's existing convention (`rag.search`, `finance.getBalance`), and the
   * OpenAI provider already rewrites dots for its stricter name rules.
   * @default '.'
   */
  separator?: string;
  /**
   * Tags applied to every bridged tool, used for ACL matching and filtering.
   * @default `['mcp', <namespace>]`
   */
  tags?: string[];
  /** Per-tool execution timeout in ms, forwarded to the `ToolExecutor`. */
  timeout?: number;
  /** Retry policy for the bridged tools. */
  retryPolicy?: RetryPolicy;
  /**
   * Sets the `requiresApproval` flag on every bridged tool.
   *
   * Left unset by default, exactly like a locally-registered tool. Set it to
   * `true` for a server you do not fully trust — that judgement belongs to the
   * deployment, not to the protocol, and cannot be derived from anything the
   * remote server says about itself.
   */
  requiresApproval?: boolean;
  /** Predicate deciding which remote tools are bridged. Omit to bridge all. */
  filter?: (info: McpToolInfo) => boolean;
  /**
   * Maximum length of the textual payload placed in `ToolResult.data`.
   * Longer output is truncated with an explicit marker.
   * @default 100_000
   */
  maxTextLength?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Type guard for text blocks. */
function isTextBlock(block: McpContentBlock): block is Extract<McpContentBlock, { type: 'text' }> {
  return block.type === 'text';
}

/** Joins the text blocks of a result, ignoring non-text content. */
function textOf(content: McpContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n');
}

/** Truncates `value` to `max` characters, marking the cut inline. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters]`;
}

/**
 * Maps a protocol-level {@link McpCallResult} onto this SDK's {@link ToolResult}.
 *
 * Precedence:
 * 1. `isError` → a failed result carrying the server's text as the message.
 * 2. `structuredContent` → used verbatim as `data` (the server validated it
 *    against its own `outputSchema`).
 * 3. All-text content → the blocks joined with newlines.
 * 4. Mixed content → the raw block array, so binary and resource blocks survive.
 */
function mapCallResult(result: McpCallResult, maxTextLength: number): ToolResult {
  if (result.isError === true) {
    const message = textOf(result.content);
    return {
      success: false,
      error: truncate(message.length > 0 ? message : 'MCP tool reported an error', maxTextLength),
    };
  }

  if (result.structuredContent !== undefined) {
    return { success: true, data: result.structuredContent };
  }

  if (result.content.length === 0) {
    return { success: true, data: null };
  }

  if (result.content.every(isTextBlock)) {
    return { success: true, data: truncate(textOf(result.content), maxTextLength) };
  }

  return { success: true, data: result.content };
}

// ─────────────────────────────────────────────────────────────────────────────
// McpToolBridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turns the tools advertised by one MCP server into {@link Tool} objects that
 * can be handed straight to a `ToolRegistry`.
 *
 * Bridged tools are ordinary SDK tools: the `ToolExecutor` validates their
 * input against the remote `inputSchema`, applies the timeout and retry policy,
 * and emits the usual `tool.call.*` events. Nothing downstream — the agent
 * loop, ACL, masking, audit — needs to know the implementation lives in another
 * process.
 *
 * ### Trust model
 * A remote server controls its own tool **names, descriptions, and results**,
 * all of which reach the LLM verbatim. Treat every MCP server as untrusted
 * input in the prompt-injection sense:
 *
 * - Tool names are namespaced (`<server>.<tool>`) so a server cannot shadow a
 *   first-party tool by claiming its name.
 * - The {@link ExecutionContext} is **not** forwarded to the server: MCP has no
 *   tenant or user identity in `tools/call`. Multi-tenant isolation must be
 *   enforced on this side (ACL policies, per-tenant server instances), never
 *   assumed of the remote.
 *
 * ### Approval
 * Bridged tools carry no `requiresApproval` flag unless one is configured. They
 * are not treated as riskier than a local tool merely for living in another
 * process: risk follows what a tool *does* and how much the deployment trusts
 * its source, neither of which the transport reveals.
 *
 * In particular, `annotations.readOnlyHint` is **not** used to pick a default.
 * It is supplied by the very party being judged, so a hostile server would only
 * have to claim it. Use {@link McpToolBridgeOptions.requiresApproval} to mark an
 * untrusted server, and remember the flag is metadata: real gating happens
 * through `ApprovalService` triggers.
 *
 * @example
 * ```typescript
 * const bridge = new McpToolBridge(client, { tags: ['mcp', 'files'] });
 * registry.registerMany(await bridge.createTools());
 * ```
 */
export class McpToolBridge {
  readonly #client: McpClient;
  readonly #options: McpToolBridgeOptions;
  readonly #namespace: string;
  readonly #separator: string;
  readonly #maxTextLength: number;

  /**
   * @param client  - Connected (or connectable) MCP client to bridge.
   * @param options - Naming, tagging, and safety overrides.
   */
  constructor(client: McpClient, options: McpToolBridgeOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.#namespace = options.namespace ?? client.name;
    this.#separator = options.separator ?? '.';
    this.#maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Lists the remote tools that pass the configured {@link
   * McpToolBridgeOptions.filter}.
   *
   * @returns Matching remote tool descriptors.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const all = await this.#client.listTools();
    const filter = this.#options.filter;
    return filter === undefined ? all : all.filter(filter);
  }

  /**
   * Bridges every remote tool that passes the filter.
   *
   * @returns Ready-to-register tools, namespaced under the server name.
   */
  async createTools(): Promise<Tool[]> {
    const infos = await this.listTools();
    return infos.map((info) => this.toTool(info));
  }

  /**
   * Bridges a single remote tool by its remote name.
   *
   * Used by declarative config, where each MCP tool is declared explicitly so
   * that tags and ACL policies can be attached per tool.
   *
   * @param remoteName - Tool name as exposed by the server.
   * @returns The bridged tool.
   * @throws {@link McpToolError} if the server does not expose that tool.
   */
  async createTool(remoteName: string): Promise<Tool> {
    const infos = await this.#client.listTools();
    const info = infos.find((t) => t.name === remoteName);
    if (info === undefined) {
      const available = infos.map((t) => t.name).join(', ');
      throw new McpToolError(
        this.#client.name,
        remoteName,
        `not exposed by the server. Available tools: ${available || '(none)'}`,
      );
    }
    return this.toTool(info);
  }

  /**
   * Maps one remote tool descriptor onto a {@link Tool}. Pure — it performs no
   * I/O, so it can be used when the descriptor is already in hand.
   *
   * @param info - Remote tool descriptor.
   * @returns The bridged tool.
   */
  toTool(info: McpToolInfo): Tool {
    const opts = this.#options;
    const client = this.#client;
    const remoteName = info.name;
    const maxTextLength = this.#maxTextLength;

    const tool: Tool = {
      name: `${this.#namespace}${this.#separator}${remoteName}`,
      description: info.description ?? info.annotations?.title ?? `MCP tool '${remoteName}'`,
      inputSchema: info.inputSchema,
      tags: opts.tags ?? ['mcp', this.#namespace],

      async execute(input: unknown, _context: ExecutionContext): Promise<ToolResult> {
        // Protocol failures propagate so the ToolExecutor can apply its retry
        // policy; application failures come back as `isError` and are mapped
        // to a failed result for the LLM to read.
        const result = await client.callTool(remoteName, (input ?? {}) as Record<string, unknown>);
        return mapCallResult(result, maxTextLength);
      },
    };

    // Conditional assignment required by `exactOptionalPropertyTypes`.
    // `requiresApproval` is left unset unless configured: a bridged tool behaves
    // like any other tool, and trust in a server is a deployment decision.
    if (info.outputSchema !== undefined) tool.outputSchema = info.outputSchema;
    if (opts.requiresApproval !== undefined) tool.requiresApproval = opts.requiresApproval;
    if (opts.timeout !== undefined) tool.timeout = opts.timeout;
    if (opts.retryPolicy !== undefined) tool.retryPolicy = opts.retryPolicy;

    return tool;
  }
}
