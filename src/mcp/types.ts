import type { JSONSchema } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// SERVER CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An MCP server launched as a child process and spoken to over stdio.
 *
 * The `command` is executed verbatim — treat it as trusted input and never
 * build it from end-user data. See the security notes in the MCP manual.
 */
export interface McpStdioServerConfig {
  /** Discriminator: child process over stdin/stdout. */
  transport: 'stdio';
  /** Executable to spawn (e.g. `'npx'`). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /**
   * Environment for the child process. When omitted the MCP SDK passes a
   * curated safe subset of the parent environment — it does **not** inherit
   * everything, so secrets must be forwarded explicitly.
   */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
}

/**
 * A remote MCP server reachable over Streamable HTTP.
 */
export interface McpHttpServerConfig {
  /** Discriminator: remote server over Streamable HTTP. */
  transport: 'http';
  /** Full endpoint URL of the MCP server. */
  url: string;
  /** Extra headers sent on every request (e.g. `Authorization`). */
  headers?: Record<string, string>;
}

/**
 * An escape hatch for transports the SDK does not wrap natively (SSE,
 * WebSocket, or a custom in-process transport used by tests).
 *
 * Unlike the other variants this is **not serialisable**, so it can only be
 * supplied programmatically — never from `agent349.config.json`.
 */
export interface McpCustomServerConfig {
  /** Discriminator: caller-supplied transport. */
  transport: 'custom';
  /**
   * Factory returning an MCP `Transport` instance, synchronously or as a
   * promise (the client awaits the result either way).
   *
   * Typed as `unknown` so that the MCP SDK's types never leak into this
   * package's public surface; the returned value is passed straight to
   * `Client.connect()`.
   */
  create: () => unknown;
}

/** Connection settings for a single MCP server, discriminated by `transport`. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpCustomServerConfig;

/**
 * Bridging options attached to a server declared in `agent349.config.json`.
 * They map onto `McpToolBridgeOptions` and `McpClientOptions`.
 */
export interface McpBridgeSettings {
  /**
   * Register every tool the server advertises, namespaced under the server
   * name. Convenient for trusted first-party servers; prefer explicit
   * `kind: 'mcp'` tool definitions in production, where per-tool tags and ACL
   * policies matter.
   *
   * Enabling this connects to the server during startup, since the tool
   * schemas have to be fetched before they can be registered.
   *
   * @default false
   */
  autoRegisterTools?: boolean;
  /** Overrides the tool-name prefix. Defaults to the server's config key. */
  namespace?: string;
  /** Tags applied to the server's bridged tools. Defaults to `['mcp', <name>]`. */
  tags?: string[];
  /**
   * Sets `requiresApproval` on every tool of this server. Omitted by default —
   * set it to `true` to mark a server the deployment does not fully trust.
   */
  requiresApproval?: boolean;
  /** Per-tool execution timeout in ms, applied by the `ToolExecutor`. */
  toolTimeoutMs?: number;
  /** Handshake and per-request timeout in ms. @default 30_000 */
  requestTimeoutMs?: number;
  /** Maximum length of textual tool output before truncation. @default 100_000 */
  maxTextLength?: number;
}

/**
 * A **serialisable** MCP server declaration, as written in the `mcp.servers`
 * section of `agent349.config.json`.
 *
 * The `custom` transport is deliberately excluded: it carries a function and
 * therefore cannot survive a round-trip through JSON.
 */
export type McpServerDeclaration = (McpStdioServerConfig | McpHttpServerConfig) & McpBridgeSettings;

/**
 * Any server entry the loader accepts, including the programmatic-only
 * `custom` transport.
 *
 * A config read from a JSON file can only ever produce an
 * {@link McpServerDeclaration}; `custom` is reachable when the config is built
 * in code and passed to `Orchestrator.create()` directly.
 */
export type McpServerEntry = McpServerConfig & McpBridgeSettings;

// ─────────────────────────────────────────────────────────────────────────────
// TOOL METADATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Behavioural hints a server may attach to a tool.
 *
 * These are **hints, not guarantees** — they are asserted by the remote server
 * about itself, so the SDK never derives a security decision from them. They
 * are surfaced for display and for filtering (see
 * {@link McpToolBridgeOptions.filter}), where the caller stays in control of
 * what the claim is worth.
 */
export interface McpToolAnnotations {
  /** Human-readable title for display purposes. */
  title?: string;
  /** The tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates. */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** The tool interacts with an open world of external entities. */
  openWorldHint?: boolean;
}

/**
 * A tool as advertised by an MCP server's `tools/list` response, normalised
 * into the shape this SDK works with.
 */
export interface McpToolInfo {
  /** Tool name as exposed by the remote server (not namespaced). */
  name: string;
  /** Description supplied by the server, if any. */
  description?: string;
  /** JSON Schema for the tool's arguments. Always an object schema per spec. */
  inputSchema: JSONSchema;
  /** JSON Schema for structured output, when the server declares one. */
  outputSchema?: JSONSchema;
  /** Behavioural hints declared by the server. */
  annotations?: McpToolAnnotations;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALL RESULTS
// ─────────────────────────────────────────────────────────────────────────────

/** A textual result block. */
export interface McpTextContent {
  type: 'text';
  text: string;
}

/** A binary result block (image or audio), carrying base64 data. */
export interface McpBinaryContent {
  type: 'image' | 'audio';
  /** Base64-encoded payload. May be large — see `maxTextLength` on the bridge. */
  data: string;
  mimeType: string;
}

/** An embedded or linked resource returned by a tool. */
export interface McpResourceContent {
  type: 'resource' | 'resource_link';
  /** Loosely typed: the shape varies between embedded and linked resources. */
  resource?: Record<string, unknown>;
  uri?: string;
  mimeType?: string;
  text?: string;
}

/** Any content block an MCP tool can return. */
export type McpContentBlock = McpTextContent | McpBinaryContent | McpResourceContent;

/**
 * Normalised result of a `tools/call` request.
 */
export interface McpCallResult {
  /** Content blocks returned by the tool. */
  content: McpContentBlock[];
  /**
   * Structured output validated against the tool's `outputSchema`, when the
   * server declares one. Preferred over `content` when present.
   */
  structuredContent?: unknown;
  /**
   * Set by the server when the tool itself failed. This is an *application*
   * error the LLM is expected to see and react to — not a protocol error.
   */
  isError?: boolean;
}
