import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../errors/index.js';
import type {
  AgentConfig,
  AuditCategory,
  DeclarativeSkill,
  ResourceLimits,
  ToolDefinition,
} from '../types/index.js';
import type { McpServerDeclaration } from '../mcp/types.js';
import type { ConnectionsConfig } from '../connections/types.js';
import type { CredentialsConfig } from '../credentials/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Storage backend config types
// ─────────────────────────────────────────────────────────────────────────────

/** In-process storage — data is lost on process exit. For development and tests. */
export interface MemoryBackendConfig {
  type: 'memory';
}

/** Redis storage via ioredis. Install `ioredis` to use this backend. */
export interface RedisBackendConfig {
  type: 'redis';
  /** Redis host. Default: `'localhost'`. */
  host?: string;
  /** Redis port. Default: `6379`. */
  port?: number;
  /** Database index. Default: `0`. */
  db?: number;
  /** ACL username (Redis 6+). */
  username?: string;
  /** Password / auth token. */
  password?: string;
  /** Enable TLS. Default: `false`. */
  tls?: boolean;
  /**
   * Prefix prepended to every key written by this backend.
   * Use to namespace multiple adapters on a shared Redis instance.
   */
  keyPrefix?: string;
  /**
   * Full Redis connection URL (`redis://` or `rediss://`).
   * When provided, individual host/port/db/tls fields are ignored.
   */
  url?: string;
  /** Connection timeout in milliseconds. Default: `5000`. */
  connectTimeout?: number;
  /** Max retries per command before failing. Default: `3`. `null` for unlimited. */
  maxRetriesPerRequest?: number | null;
}

/** MongoDB storage via the official `mongodb` driver. Install `mongodb` to use this backend. */
export interface MongoBackendConfig {
  type: 'mongo';
  /** MongoDB connection URI, e.g. `'mongodb://localhost:27017'`. */
  uri: string;
  /** Database name. */
  database: string;
  /** Collection name. Each logical storage layer should use its own collection. */
  collection: string;
  /**
   * Name of the document field used for TTL-based expiry.
   * A TTL index on this field is created automatically on first connection.
   * Default: `'expiresAt'`.
   */
  ttlField?: string;
}

/** Union of all supported storage backend configs, discriminated by `type`. */
export type StorageBackendConfig = MemoryBackendConfig | RedisBackendConfig | MongoBackendConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Audit store config types
// ─────────────────────────────────────────────────────────────────────────────

/** In-process audit store — non-persistent. For development and tests. */
export interface AuditMemoryStoreConfig {
  type: 'memory';
}

/** MongoDB audit store via the official `mongodb` driver. Install `mongodb` to use. */
export interface AuditMongoStoreConfig {
  type: 'mongo';
  /** MongoDB connection URI, e.g. `'mongodb://localhost:27017'`. */
  uri: string;
  /** Database name. */
  database: string;
  /** Collection name. Default: `'audit_records'`. */
  collection?: string;
  /** Days after which records expire via a TTL index. Omit to disable auto-expiry. */
  retentionDays?: number;
  /** Insert write concern. `'majority'` (default) for compliance-grade durability. */
  writeConcern?: 'majority' | number;
}

/** Union of supported audit store configs, discriminated by `type`. */
export type AuditStoreConfig = AuditMemoryStoreConfig | AuditMongoStoreConfig;

/** SIEM forwarding disabled (the default). */
export interface AuditSIEMNoneConfig {
  type: 'none';
}

/** Real-time forwarding to an HTTP endpoint. */
export interface AuditSIEMWebhookConfig {
  type: 'webhook';
  /** Destination URL that receives POSTed batches. */
  url: string;
  /** Payload format. Default: `'json'`. */
  format?: 'json' | 'cef' | 'leef';
  /** Extra HTTP headers (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default: `10000`. */
  timeoutMs?: number;
}

/** Union of supported SIEM forwarder configs, discriminated by `type`. */
export type AuditSIEMConfig = AuditSIEMNoneConfig | AuditSIEMWebhookConfig;

// ─────────────────────────────────────────────────────────────────────────────
// LLM provider config types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapter type backing an LLM provider instance.
 *
 * - `'openai'` — official OpenAI (or Azure OpenAI when `apiVersion` is set).
 * - `'openai-compatible'` — any server exposing the OpenAI Chat Completions API
 *   (vLLM, gateways, self-hosted proxies). Requires `baseUrl`.
 * - `'claude'` — Anthropic Claude (Messages API).
 * - `'gemini'` — Google Gemini (Interactions API for calls, Batch API for jobs).
 * - `'ollama'` — local Ollama HTTP API. Requires `baseUrl`.
 *
 * New adapters extend this union and register a factory
 * (`Orchestrator.registerLLMAdapterFactory`) — no wiring changes required.
 */
export type LLMProviderType = 'openai' | 'openai-compatible' | 'claude' | 'gemini' | 'ollama';

/** Reasoning-effort levels mirrored from {@link LLMRequest.reasoningEffort}. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Configuration for a single, named LLM **provider instance**.
 *
 * The key under `llm.providers` is the instance identity (an arbitrary, unique
 * name used for selection, routing, metrics, token tracking, auditing and the
 * circuit breaker). It is **not** a model name — a single instance can serve
 * many models via each request's `model` field.
 *
 * `type` selects the adapter. For the historical keys `openai`, `claude` and
 * `ollama`, `type` is optional and inferred from the key (backward
 * compatibility); for any other instance name it is required.
 *
 * This is a permissive superset shared by every adapter (config is dynamic and
 * JSON-sourced): which fields are required is enforced per `type` at load time
 * (see {@link resolveLLMProviderType}) and honoured by the adapter factory.
 * Public field names follow Agent349 conventions (`baseUrl`, `headers`); the
 * wiring translates them to each underlying SDK's own names (`baseURL`,
 * `defaultHeaders`) so no SDK-internal naming leaks into the public contract.
 */
export interface LLMProviderConfig {
  /**
   * Adapter type. Optional (inferred) for keys `openai`/`claude`/`ollama`;
   * required for any other instance name. Accepts the built-in
   * {@link LLMProviderType} values (with editor autocompletion) or any custom
   * type backed by a factory registered via `overrides.llmAdapters`.
   */

  type?: LLMProviderType | (string & {});
  /**
   * API key — typically resolved from an environment variable. Bearer
   * authentication for `openai`/`openai-compatible`/`claude` when the adapter
   * supports it. Omit for endpoints that require no authentication.
   */
  apiKey?: string;
  /**
   * Public base URL of the instance endpoint. Required for `ollama` and
   * `openai-compatible`; optional for `openai` (proxy or Azure resource host).
   * Translated to the underlying SDK's `baseURL` at wiring time.
   */
  baseUrl?: string;
  /**
   * Azure OpenAI API version. When present on an `openai` instance the adapter
   * switches to Azure mode and treats `baseUrl` as the Azure resource endpoint.
   */
  apiVersion?: string;
  /** OpenAI organisation id (ignored by non-OpenAI adapters). */
  organization?: string;
  /**
   * Extra HTTP headers for gateways / corporate infrastructure. Translated to
   * the underlying SDK's `defaultHeaders`. If a header `Authorization` is set
   * here it takes precedence over `apiKey`-derived bearer auth.
   */
  headers?: Record<string, string>;
  /**
   * Default reasoning effort applied to this instance's requests. Only sent by
   * adapters/models that support it; endpoints that reject it are recovered via
   * the adapter's parameter-relaxation mechanism.
   */
  reasoningEffort?: ReasoningEffort;
  /** Default model identifier for this instance (used when a request omits `model`). */
  defaultModel?: string;
  /** Maximum number of automatic retries on transient failures. */
  maxRetries?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Per-model pricing overrides (USD / 1 000 tokens), merged on top of the
   * adapter's built-in defaults — only the models that are new or whose rate
   * changed need an entry here. `openai-compatible` instances have no built-in
   * pricing table, so cost is reported only for models listed here.
   */
  pricing?: Record<
    string,
    {
      /** USD per 1 000 input tokens. */
      input: number;
      /** USD per 1 000 output tokens. */
      output: number;
      /** USD per 1 000 input tokens for batch jobs, when the provider differs. */
      batchInput?: number;
      /** USD per 1 000 output tokens for batch jobs, when the provider differs. */
      batchOutput?: number;
    }
  >;
  /**
   * Declared capability overrides for this instance.
   *
   * Only meaningful for `openai-compatible` endpoints, whose feature set the
   * SDK cannot infer: the adapter starts from a conservative default (images
   * yes, documents no, JSON mode without schema, no files, no batch) and this
   * field declares what the server actually implements. Over-declaring turns a
   * clear SDK error into an opaque provider error.
   */
  capabilities?: Partial<import('../types/index.js').ProviderCapabilities>;
}

/**
 * @deprecated Use {@link LLMProviderConfig} with `type: 'ollama'`. Retained as a
 * structural alias for backward compatibility of existing imports.
 */
export interface OllamaProviderConfig {
  /** Base URL of the Ollama HTTP API. */
  baseUrl: string;
  /** Default local model name (e.g. `'llama3'`). */
  defaultModel: string;
  /** Request timeout in milliseconds (local models can be slower). */
  timeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDKConfig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level SDK configuration object.
 * Matches the structure of `defaults.json` and `agent349.config.json`.
 */
export interface SDKConfig {
  /**
   * Application home directory used as the base for resolving relative tool
   * module paths declared in `tools.definitions`. If relative, it is resolved
   * against the config file's directory, then `process.cwd()`.
   */
  appHome?: string;
  /**
   * Named storage backends. Each entry is a fully-described connection config.
   * Layers (`memory.session`, `memory.longTerm`, `session`, `tokens`) reference
   * backends by name via their `backend` field.
   */
  storage: {
    backends: Record<string, StorageBackendConfig>;
  };
  llm: {
    /**
     * Name of the provider **instance** used when an agent's `llmConfig.provider`
     * is not set. Must match a key in `providers` (a configured instance name,
     * e.g. `'openai'`, `'vllm-local'`), or a provider registered programmatically.
     */
    defaultProvider?: string;
    /**
     * Model identifier used when an agent's `llmConfig.model` is not set.
     * When absent, the `defaultModel` of the resolved instance is used instead.
     */
    defaultModel?: string;
    /**
     * Named LLM provider instances, keyed by an arbitrary unique instance name.
     * Each entry selects an adapter via `type` (inferred for the historical keys
     * `openai`/`claude`/`ollama`). Multiple instances of the same adapter type
     * are allowed (different endpoints, credentials, timeouts, pricing, …).
     */
    providers: Record<string, LLMProviderConfig>;
    circuitBreaker: {
      /** Number of consecutive failures before opening the circuit. */
      failureThreshold: number;
      /** Time in milliseconds before attempting to close the circuit again. */
      recoveryTimeMs: number;
    };
  };
  memory: {
    session: {
      /**
       * Name of the backend (key in `storage.backends`) used for
       * session conversation history (Level-1 memory).
       */
      backend: string;
      /** Session TTL in seconds. */
      ttlSeconds: number;
      /** Default memory compression strategy for agents. */
      strategy: 'sliding_window' | 'incremental_summary';
      /** Message count that triggers compression / sliding window size. */
      maxMessagesBeforeCompress: number;
      /**
       * What happens to binary content (images, documents) when a conversation
       * is written to the session store.
       *
       * - `'omit'` (default) — inline content is replaced by an explicit
       *   placeholder that stays visible in the history and is rendered to the
       *   model as a note on later turns; provider file references are kept.
       * - `'full'` — everything is stored verbatim. Only for stores sized for
       *   it: a base64 PDF is megabytes per turn.
       */
      mediaPersistence?: 'omit' | 'full';
    };
    longTerm: {
      /**
       * Name of the backend (key in `storage.backends`) used for
       * persistent user facts (Level-2 memory).
       */
      backend: string;
      /** Maximum number of long-term facts stored per user. */
      maxFactsPerUser: number;
    };
  };
  /** SessionManager storage configuration. */
  session: {
    /** Name of the backend (key in `storage.backends`) for session records. */
    backend: string;
  };
  tools: {
    /** Default execution timeout for tools, in milliseconds. */
    defaultTimeoutMs: number;
    /** Default maximum retry count for tool execution failures. */
    maxRetries: number;
    /** Base backoff interval between retries, in milliseconds. */
    retryBackoffMs: number;
    /**
     * Declarative tool definitions loaded and registered at startup.
     * External modules are imported dynamically; internal tools are built from
     * SDK factories. Omit to register tools only in code.
     */
    definitions?: ToolDefinition[];
    /**
     * Optional allowlist of root directories for external tool modules.
     * When set, every resolved module path must live inside one of these roots.
     */
    moduleRoots?: string[];
    /**
     * Behaviour when a declarative tool fails to load.
     * `'strict'` (default) aborts startup; `'tolerant'` skips the tool and
     * emits a `config.tool.load.error` event.
     */
    loadMode?: 'strict' | 'tolerant';
    /**
     * Fallback caps for integration tools, used when neither the tool nor its
     * connection sets one. Conservative on purpose: an unbounded result burns
     * the context window and the token budget in a single call.
     */
    defaultLimits: ResourceLimits;
  };
  /**
   * Named connections to external systems (databases, HTTP APIs, mail), shared
   * by the integration tools that reference them by name.
   *
   * A connection is not owned by any one tool — several may use the same one —
   * which is why this sits at the top level rather than under `tools`.
   *
   * Nothing here is opened at startup: a connection opens on first use, and one
   * that no tool ends up using is never opened at all.
   */
  connections?: ConnectionsConfig;
  /**
   * Static credentials, keyed by the `ref` a connection points at. Secrets are
   * written as `${ENV_VAR}` and substituted at load time.
   *
   * Covers credentials that do not expire. Anything with a lifecycle (OAuth
   * refresh, rotation) belongs in a `CredentialProvider` injected through
   * `OrchestratorOverrides.credentialProvider`, which takes priority over this
   * section.
   */
  credentials?: CredentialsConfig;
  /**
   * External MCP (Model Context Protocol) servers this SDK consumes as a
   * client. Each entry is connected at startup when `autoRegisterTools` is set,
   * and on first use otherwise.
   *
   * Omit the section entirely to disable MCP — no connection is opened and the
   * optional `@modelcontextprotocol/sdk` dependency is never imported.
   */
  mcp?: {
    /**
     * Servers keyed by logical name, which doubles as the tool namespace.
     *
     * Only the `stdio` and `http` transports are expressible here: the config
     * is deep-cloned and must stay serialisable, so a `custom` transport (which
     * carries a factory function) has to be injected via
     * `OrchestratorOverrides.mcpClients` instead.
     */
    servers?: Record<string, McpServerDeclaration>;
    /**
     * Allowlist of executables that `transport: "stdio"` servers may spawn.
     * Counterpart to `tools.moduleRoots`, which guards external tool modules.
     *
     * Matching is an **exact string comparison** against `command`, so entries
     * must be written exactly as the server declares them (`'npx'` does not
     * cover `'/usr/bin/npx'`, or vice versa). Omit the field to allow any
     * command.
     *
     * Note this constrains the **binary, not the full argv**: allowing a
     * general-purpose launcher such as `npx` still permits it to fetch and run
     * arbitrary packages. Pin concrete executables
     * (`'/opt/erp/mcp-server'`) for the guard to be worth much.
     */
    allowedCommands?: string[];
  };
  /**
   * Declarative skills. Each references its tools by name; the loader resolves
   * them against tools registered from `tools.definitions` or in code.
   */
  skills?: DeclarativeSkill[];
  /** Declarative agents registered at startup. */
  agents?: AgentConfig[];
  agent: {
    /** Hard cap on tool-calling iterations per `AgentLoop.run()` call. */
    maxLoopIterations: number;
    /** LLM sampling temperature applied when none is specified by the agent. */
    defaultTemperature: number;
    /** Maximum output tokens when none is specified by the agent. */
    defaultMaxTokens: number;
  };
  tokens: {
    /** Name of the backend (key in `storage.backends`) for token usage records. */
    backend: string;
    /**
     * `enforce` blocks requests that exceed a quota, `observe` only reports
     * quota violations, and `disabled` skips both enforcement and recording.
     */
    limitMode: 'enforce' | 'observe' | 'disabled';
    limits: {
      perTenant: { daily: number; monthly: number };
      perUser: { daily: number; monthly: number };
    };
    /** Cost per 1 000 tokens, keyed by model identifier. */
    pricing: Record<string, { input: number; output: number }>;
  };
  logging: {
    /** Minimum technical-log level forwarded to the adapter. */
    level: 'debug' | 'info' | 'warn' | 'error';
    /** Whether token usage is included in log events. */
    includeTokenUsage: boolean;
    /**
     * Technical log sink. `'noop'` (default) keeps the SDK silent; `'console'`
     * writes structured lines to stdout/stderr. Inject a custom adapter via the
     * `logger` Orchestrator override for other backends (pino, Loki, …).
     */
    adapter?: 'noop' | 'console';
    /** Console output format when `adapter` is `'console'`. Default: `'json'`. */
    format?: 'json' | 'pretty';
    /** Include the event payload in each log entry's `data`. Default: `true`. */
    includeData?: boolean;
    /** Field names to redact from technical-log payloads. */
    redactFields?: string[];
  };
  /**
   * Functional audit configuration. When `enabled` is `false` (the default) the
   * Orchestrator builds no AuditLogger and captures nothing — identical to the
   * pre-audit behaviour. When `true`, events on the EventBus are captured into
   * immutable {@link AuditRecord}s and persisted through the configured store.
   */
  audit: {
    /** Master switch. Default: `false` (opt-in). */
    enabled: boolean;
    /**
     * Global verbosity.
     * - `'minimal'`  — correlation + outcome only.
     * - `'standard'` — adds sanitised inputs/outputs and token metrics.
     * - `'verbose'`  — adds full LLM messages and tool-call chain.
     */
    verbosity: 'minimal' | 'standard' | 'verbose';
    /** Per-category verbosity overrides. Takes precedence over `verbosity`. */
    verbosityOverrides?: Partial<Record<AuditCategory, 'minimal' | 'standard' | 'verbose'>>;
    /** Asynchronous write buffer tuning. */
    buffer: {
      /** Max buffered records before an automatic flush. */
      maxSize: number;
      /** Milliseconds between periodic flushes. */
      flushIntervalMs: number;
    };
    /**
     * Retention applied by {@link AuditLogger.applyRetention}. `default` is the
     * fallback age (days); per-category overrides can extend e.g. security logs.
     */
    retention?: {
      default?: number;
      security?: number;
    };
    /**
     * Sensitive-data redaction. JSON config supports field-name redaction;
     * regex-based `customPatterns` are only configurable from code via the
     * `auditLogger` override.
     */
    sensitiveData: {
      /** Enable redaction before records reach the store. Default: `true`. */
      enabled: boolean;
      /** Field names whose values are always replaced with `'[REDACTED]'`. */
      globalRedactFields?: string[];
    };
    /** Backing store. `memory` for dev/tests; `mongo` for production. */
    store: AuditStoreConfig;
    /**
     * Real-time SIEM forwarding. `none` (default) disables it. When set, each
     * flushed batch is also shipped to the configured destination after it is
     * durably written to the store.
     */
    siem?: AuditSIEMConfig;
  };
  rag: {
    /**
     * Vector store backend.
     * `'in-memory'`: for development and tests — no persistence.
     * `'meilisearch'`, `'pgvector'`, `'qdrant'`, `'pinecone'`, `'weaviate'`,
     * `'milvus'`: persistent stores; the section named after the adapter holds
     * its connection settings.
     */
    vectorStore: {
      adapter:
        | 'in-memory'
        | 'meilisearch'
        | 'pgvector'
        | 'qdrant'
        | 'pinecone'
        | 'weaviate'
        | 'milvus';
      meilisearch?: {
        /** Base URL of the Meilisearch instance. Default: `'http://localhost:7700'`. */
        url: string;
        /** API key. Omit for unauthenticated instances. */
        apiKey?: string;
        /** Request timeout in milliseconds. Default: 10 000. */
        requestTimeout: number;
      };
      /** PostgreSQL + pgvector. Requires the `pg` package. */
      pgvector?: {
        /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
        connectionString?: string;
        host?: string;
        port?: number;
        database?: string;
        user?: string;
        password?: string;
        ssl?: boolean;
        /** Maximum pool size. Default: 10. */
        maxConnections?: number;
        /** Schema for the tables. Default: `'public'`. */
        schema?: string;
        /** Table name prefix. Default: `'agent349_'`. */
        tablePrefix?: string;
        /** Full-text search configuration (`'simple'`, `'english'`, `'spanish'`…). Default: `'simple'`. */
        textSearchConfig?: string;
        /** Run `CREATE EXTENSION IF NOT EXISTS vector`. Default: `true`. */
        createExtension?: boolean;
      };
      /** Qdrant (self-hosted or Qdrant Cloud). */
      qdrant?: {
        /** REST endpoint. Default: `'http://localhost:6333'`. */
        url?: string;
        apiKey?: string;
        timeoutMs?: number;
        /** Collection name prefix. Default: `''`. */
        collectionPrefix?: string;
      };
      /** Pinecone: one index, one namespace per collection. Vector search only. */
      pinecone?: {
        apiKey?: string;
        /** Index shared by every collection. */
        indexName: string;
        /** Create the index (serverless) when missing. */
        createIndex?: { cloud: 'aws' | 'gcp' | 'azure'; region: string };
        /** Control-plane URL. Default: `'https://api.pinecone.io'`. */
        controlPlaneUrl?: string;
        /** Data-plane URL of the index. Default: discovered. */
        indexHost?: string;
        namespacePrefix?: string;
        apiVersion?: string;
        timeoutMs?: number;
      };
      /** Weaviate (self-hosted or Weaviate Cloud). */
      weaviate?: {
        /** REST endpoint. Default: `'http://localhost:8080'`. */
        url?: string;
        apiKey?: string;
        headers?: Record<string, string>;
        timeoutMs?: number;
        /** Class name prefix; must start with an uppercase letter. Default: `'Agent349_'`. */
        classPrefix?: string;
      };
      /** Milvus 2.5+ or Zilliz Cloud. */
      milvus?: {
        /** Endpoint. Default: `'http://localhost:19530'`. */
        url?: string;
        /** `user:password` or a Zilliz Cloud API key. */
        token?: string;
        /** Database. Default: `'default'`. */
        database?: string;
        timeoutMs?: number;
        collectionPrefix?: string;
        /** Consistency level of new collections. Default: `'Strong'`. */
        consistencyLevel?: 'Strong' | 'Bounded' | 'Session' | 'Eventually';
      };
    };
    embedding: {
      defaultProvider: string;
      defaultModel: string;
      defaultDimensions: number;
      providers: {
        openai?: { apiKey: string };
        cohere?: { apiKey: string };
        ollama?: { baseUrl: string };
      };
    };
    retrieval: {
      topK: number;
      finalTopK: number;
      hybridAlpha: number;
      searchMode: 'vector' | 'keyword' | 'hybrid';
      minScore: number;
      rerank: boolean;
      /**
       * What to do when `rerank` is enabled but the re-ranker fails.
       *
       * - `'require'` (default) — surface a `RerankerError`. Retrieval scores are
       *   normalised per collection, so without the re-ranker `minScore` cannot
       *   discriminate and irrelevant passages are returned as confident matches.
       * - `'degrade'` — fall back to retrieval order and continue. Only for
       *   callers that prefer approximate results to an error.
       */
      rerankPolicy: 'require' | 'degrade';
      rrfK: number;
    };
    queryRewriting?: {
      strategy: 'contextual' | 'hyde' | false;
      model?: string;
      llmProvider?: string;
    };
    reranker?: {
      provider: 'llm' | 'cohere' | 'tei';
      model?: string;
      batchSize?: number;
      apiKey?: string;
      llmProvider?: string;
      /**
       * LLM: max completion tokens requested per batch call, sent as-is
       * regardless of batch size. Default: computed per batch with headroom
       * for reasoning-capable models — see `LLMRerankerConfig.maxTokens`.
       * Raise this if a reasoning model (e.g. GPT-5) fails to return a
       * parseable score array (its hidden reasoning tokens share this budget
       * with the visible JSON output).
       */
      maxTokens?: number;
      /**
       * LLM: reasoning effort hint for reasoning-capable models (e.g. GPT-5).
       * Ignored by providers/models that don't support it — always safe to
       * set. Default: `'minimal'`, since relevance scoring needs no deep
       * reasoning. See `LLMRerankerConfig.reasoningEffort`.
       */
      reasoningEffort?: ReasoningEffort;
      /** TEI: base URL of the Text Embeddings Inference server. */
      baseUrl?: string;
      /** TEI: observability label for the served cross-encoder model. */
      modelLabel?: string;
      /** TEI: request raw logits instead of normalised [0,1] scores. Default: false. */
      rawScores?: boolean;
      /** TEI: request timeout in milliseconds. */
      timeoutMs?: number;
      /** TEI: max passages per request (batching). */
      maxBatchSize?: number;
      /** TEI: max concurrent batch requests. */
      concurrency?: number;
      /** Extra HTTP headers (TEI). */
      headers?: Record<string, string>;
    };
  };
}

/**
 * Recursively makes all properties of `T` optional, allowing partial
 * overrides at every nesting level.
 */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — loaded once at module initialisation from defaults.json
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The built-in production defaults shipped with the SDK. */
const DEFAULTS: SDKConfig = JSON.parse(
  readFileSync(join(__dirname, 'defaults.json'), 'utf-8'),
) as SDKConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively replaces every `${VAR_NAME}` placeholder in string values
 * with the corresponding `process.env` value.
 * Unresolved variables are replaced with an empty string.
 */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Deep-merges `override` on top of a clone of `base`.
 * Plain objects are merged recursively; arrays and primitives are replaced.
 * Keys with `undefined` values in `override` are skipped.
 */
function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  const src = override as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    const srcVal = src[key];
    if (srcVal === undefined) continue;

    const dstVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      dstVal !== null &&
      typeof dstVal === 'object' &&
      !Array.isArray(dstVal)
    ) {
      result[key] = deepMerge(dstVal, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }

  return result as T;
}

/** Instance keys whose adapter type is inferred when `type` is omitted (backward compatibility). */
const HISTORICAL_PROVIDER_TYPES: Readonly<Record<string, LLMProviderType>> = {
  openai: 'openai',
  claude: 'claude',
  gemini: 'gemini',
  ollama: 'ollama',
};

/**
 * Resolves the adapter type of a provider instance from its explicit `type`,
 * falling back to inference for the historical keys `openai`/`claude`/`ollama`.
 *
 * An explicit `type` is returned as-is (not restricted to the built-in
 * {@link LLMProviderType} set) so custom adapter types registered via
 * `overrides.llmAdapters` are accepted; the adapter registry raises a clear
 * error if no factory is registered for the type.
 *
 * @param name - Instance name (key under `llm.providers`).
 * @param cfg  - Instance configuration.
 * @returns The resolved adapter type name.
 * @throws {@link ConfigError} when `type` is missing for a non-historical key.
 */
export function resolveLLMProviderType(name: string, cfg: LLMProviderConfig): string {
  if (cfg.type !== undefined && cfg.type !== '') {
    return cfg.type;
  }
  const inferred = HISTORICAL_PROVIDER_TYPES[name];
  if (inferred === undefined) {
    throw new ConfigError(
      `llm.providers.${name}.type is required. ` +
        `Only 'openai', 'claude', 'gemini' and 'ollama' are inferred from the instance key.`,
      `llm.providers.${name}.type`,
    );
  }
  return inferred;
}

/** Valid logging level values for use in validation. */
const VALID_LOG_LEVELS: ReadonlyArray<SDKConfig['logging']['level']> = [
  'debug',
  'info',
  'warn',
  'error',
];

/**
 * Validates that a fully-merged `SDKConfig` contains sensible values.
 * Throws {@link ConfigError} with the dot-notation field path on failure.
 */
function validate(cfg: SDKConfig): void {
  // ── Storage backends ────────────────────────────────────────────────────────
  const backends = cfg.storage.backends;

  const layers: Array<{ field: string; backend: string }> = [
    { field: 'memory.session.backend', backend: cfg.memory.session.backend },
    { field: 'memory.longTerm.backend', backend: cfg.memory.longTerm.backend },
    { field: 'session.backend', backend: cfg.session.backend },
    { field: 'tokens.backend', backend: cfg.tokens.backend },
  ];

  for (const { field, backend } of layers) {
    if (!(backend in backends)) {
      throw new ConfigError(
        `${field} references unknown backend '${backend}'. ` +
          `Add it to storage.backends or register it in a StorageRegistry.`,
        field,
      );
    }
  }

  for (const [name, backend] of Object.entries(backends)) {
    if (backend.type === 'mongo') {
      if (!backend.uri) {
        throw new ConfigError(
          `storage.backends.${name}.uri is required for mongo backends`,
          `storage.backends.${name}.uri`,
        );
      }
      if (!backend.database) {
        throw new ConfigError(
          `storage.backends.${name}.database is required for mongo backends`,
          `storage.backends.${name}.database`,
        );
      }
      if (!backend.collection) {
        throw new ConfigError(
          `storage.backends.${name}.collection is required for mongo backends`,
          `storage.backends.${name}.collection`,
        );
      }
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  if (cfg.audit.enabled) {
    const store = cfg.audit.store;
    if (store.type === 'mongo') {
      if (!store.uri) {
        throw new ConfigError(
          'audit.store.uri is required for mongo audit store',
          'audit.store.uri',
        );
      }
      if (!store.database) {
        throw new ConfigError(
          'audit.store.database is required for mongo audit store',
          'audit.store.database',
        );
      }
    }
    const validVerbosity = ['minimal', 'standard', 'verbose'];
    if (!validVerbosity.includes(cfg.audit.verbosity)) {
      throw new ConfigError(
        `audit.verbosity must be one of ${validVerbosity.join(', ')}`,
        'audit.verbosity',
      );
    }
    const siem = cfg.audit.siem;
    if (siem !== undefined && siem.type === 'webhook' && !siem.url) {
      throw new ConfigError(
        'audit.siem.url is required for webhook SIEM forwarding',
        'audit.siem.url',
      );
    }
  }

  // ── Agent ───────────────────────────────────────────────────────────────────
  if (cfg.agent.maxLoopIterations <= 0) {
    throw new ConfigError(
      'agent.maxLoopIterations must be greater than 0',
      'agent.maxLoopIterations',
    );
  }
  if (cfg.agent.defaultTemperature < 0 || cfg.agent.defaultTemperature > 1) {
    throw new ConfigError(
      'agent.defaultTemperature must be between 0 and 1',
      'agent.defaultTemperature',
    );
  }
  if (cfg.agent.defaultMaxTokens <= 0) {
    throw new ConfigError(
      'agent.defaultMaxTokens must be greater than 0',
      'agent.defaultMaxTokens',
    );
  }

  // ── Tools ───────────────────────────────────────────────────────────────────
  if (cfg.tools.defaultTimeoutMs <= 0) {
    throw new ConfigError(
      'tools.defaultTimeoutMs must be greater than 0',
      'tools.defaultTimeoutMs',
    );
  }
  if (cfg.tools.maxRetries < 0) {
    throw new ConfigError('tools.maxRetries must be >= 0', 'tools.maxRetries');
  }
  if (cfg.tools.retryBackoffMs <= 0) {
    throw new ConfigError('tools.retryBackoffMs must be greater than 0', 'tools.retryBackoffMs');
  }

  // ── Memory ──────────────────────────────────────────────────────────────────
  if (cfg.memory.session.ttlSeconds <= 0) {
    throw new ConfigError(
      'memory.session.ttlSeconds must be greater than 0',
      'memory.session.ttlSeconds',
    );
  }
  if (cfg.memory.session.maxMessagesBeforeCompress <= 0) {
    throw new ConfigError(
      'memory.session.maxMessagesBeforeCompress must be greater than 0',
      'memory.session.maxMessagesBeforeCompress',
    );
  }
  if (cfg.memory.longTerm.maxFactsPerUser <= 0) {
    throw new ConfigError(
      'memory.longTerm.maxFactsPerUser must be greater than 0',
      'memory.longTerm.maxFactsPerUser',
    );
  }

  // ── Logging ─────────────────────────────────────────────────────────────────
  if (!VALID_LOG_LEVELS.includes(cfg.logging.level)) {
    throw new ConfigError(
      `logging.level must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
      'logging.level',
    );
  }

  // ── LLM ─────────────────────────────────────────────────────────────────────
  if (cfg.llm.circuitBreaker.failureThreshold <= 0) {
    throw new ConfigError(
      'llm.circuitBreaker.failureThreshold must be greater than 0',
      'llm.circuitBreaker.failureThreshold',
    );
  }
  if (cfg.llm.circuitBreaker.recoveryTimeMs <= 0) {
    throw new ConfigError(
      'llm.circuitBreaker.recoveryTimeMs must be greater than 0',
      'llm.circuitBreaker.recoveryTimeMs',
    );
  }

  // ── LLM provider instances ──────────────────────────────────────────────────
  // Each entry must resolve to a valid adapter type (explicit or inferred), and
  // endpoint-based adapters require a base URL. Reference validation for
  // `defaultProvider` / `llmProvider` is deferred to resolve time (the router),
  // since a referenced instance may be registered programmatically.
  for (const [name, entry] of Object.entries(cfg.llm.providers)) {
    const type = resolveLLMProviderType(name, entry);
    // `openai-compatible` has no sensible default endpoint, so a base URL is
    // mandatory. `ollama` is intentionally NOT required: the adapter defaults to
    // http://localhost:11434, preserving compatibility with historical configs
    // that reference an (optionally empty) `${OLLAMA_BASE_URL}`.
    if (type === 'openai-compatible' && (entry.baseUrl === undefined || entry.baseUrl === '')) {
      throw new ConfigError(
        `llm.providers.${name}.baseUrl is required for type '${type}'`,
        `llm.providers.${name}.baseUrl`,
      );
    }
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────
  if (!['enforce', 'observe', 'disabled'].includes(cfg.tokens.limitMode)) {
    throw new ConfigError(
      'tokens.limitMode must be one of: enforce, observe, disabled',
      'tokens.limitMode',
    );
  }
  for (const [field, value] of Object.entries({
    'tokens.limits.perTenant.daily': cfg.tokens.limits.perTenant.daily,
    'tokens.limits.perTenant.monthly': cfg.tokens.limits.perTenant.monthly,
    'tokens.limits.perUser.daily': cfg.tokens.limits.perUser.daily,
    'tokens.limits.perUser.monthly': cfg.tokens.limits.perUser.monthly,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${field} must be a finite number greater than 0`, field);
    }
  }

  // ── RAG ─────────────────────────────────────────────────────────────────────
  if (cfg.rag.retrieval.topK <= 0) {
    throw new ConfigError('rag.retrieval.topK must be > 0', 'rag.retrieval.topK');
  }
  if (cfg.rag.retrieval.finalTopK <= 0) {
    throw new ConfigError('rag.retrieval.finalTopK must be > 0', 'rag.retrieval.finalTopK');
  }
  if (cfg.rag.retrieval.finalTopK > cfg.rag.retrieval.topK) {
    throw new ConfigError(
      'rag.retrieval.finalTopK must be <= rag.retrieval.topK',
      'rag.retrieval.finalTopK',
    );
  }
  if (cfg.rag.retrieval.hybridAlpha < 0 || cfg.rag.retrieval.hybridAlpha > 1) {
    throw new ConfigError(
      'rag.retrieval.hybridAlpha must be between 0 and 1',
      'rag.retrieval.hybridAlpha',
    );
  }
  if (cfg.rag.retrieval.minScore < 0 || cfg.rag.retrieval.minScore > 1) {
    throw new ConfigError(
      'rag.retrieval.minScore must be between 0 and 1',
      'rag.retrieval.minScore',
    );
  }
  if (
    cfg.rag.retrieval.rerankPolicy !== 'require' &&
    cfg.rag.retrieval.rerankPolicy !== 'degrade'
  ) {
    throw new ConfigError(
      "rag.retrieval.rerankPolicy must be 'require' or 'degrade'",
      'rag.retrieval.rerankPolicy',
    );
  }
  if (cfg.rag.retrieval.rrfK <= 0) {
    throw new ConfigError('rag.retrieval.rrfK must be > 0', 'rag.retrieval.rrfK');
  }
  if (
    cfg.rag.vectorStore.adapter === 'meilisearch' &&
    cfg.rag.vectorStore.meilisearch === undefined
  ) {
    throw new ConfigError(
      'rag.vectorStore.meilisearch config is required when adapter is "meilisearch"',
      'rag.vectorStore.meilisearch',
    );
  }
  validateVectorStore(cfg.rag);
  if (
    cfg.rag.reranker?.provider === 'cohere' &&
    (cfg.rag.reranker.apiKey === undefined || cfg.rag.reranker.apiKey === '')
  ) {
    throw new ConfigError(
      'rag.reranker.apiKey is required when provider is "cohere"',
      'rag.reranker.apiKey',
    );
  }
  if (
    cfg.rag.reranker?.provider === 'tei' &&
    (cfg.rag.reranker.baseUrl === undefined || cfg.rag.reranker.baseUrl === '')
  ) {
    throw new ConfigError(
      'rag.reranker.baseUrl is required when provider is "tei"',
      'rag.reranker.baseUrl',
    );
  }

  validateConnections(cfg);
  validateDeclarative(cfg);
}

/**
 * Validates the optional `connections` and `credentials` sections.
 *
 * Whether a service is actually reachable is not checked — connections are
 * opened lazily and a database being down must not stop the process from
 * starting. What is checked here is everything that is a typo rather than an
 * outage: an unknown type, a missing required field, a credential reference
 * with nothing behind it.
 */
function validateConnections(cfg: SDKConfig): void {
  const credentials = cfg.credentials ?? {};

  for (const [name, credential] of Object.entries(credentials)) {
    const path = `credentials.${name}`;
    const kinds = ['none', 'basic', 'bearer', 'apiKey', 'custom'];
    if (!kinds.includes(credential.kind)) {
      throw new ConfigError(`${path}.kind must be one of: ${kinds.join(', ')}`, `${path}.kind`);
    }
  }

  for (const [name, connection] of Object.entries(cfg.connections ?? {})) {
    const path = `connections.${name}`;

    switch (connection.type) {
      case 'sql':
        if (typeof connection.driver !== 'string' || connection.driver === '') {
          throw new ConfigError(
            `${path}.driver is required for sql connections (e.g. "postgres")`,
            `${path}.driver`,
          );
        }
        if (connection.url === undefined && connection.database === undefined) {
          throw new ConfigError(
            `${path} needs either a url or a database name`,
            `${path}.database`,
          );
        }
        break;

      case 'mongo':
        if (connection.url === undefined) {
          throw new ConfigError(`${path}.url is required for mongo connections`, `${path}.url`);
        }
        break;

      case 'http':
        if (typeof connection.baseUrl !== 'string' || connection.baseUrl === '') {
          throw new ConfigError(
            `${path}.baseUrl is required for http connections`,
            `${path}.baseUrl`,
          );
        }
        try {
          new URL(connection.baseUrl);
        } catch {
          throw new ConfigError(
            `${path}.baseUrl is not a valid URL: '${connection.baseUrl}'`,
            `${path}.baseUrl`,
          );
        }
        if (
          connection.blockPrivateAddresses !== undefined &&
          typeof connection.blockPrivateAddresses !== 'boolean'
        ) {
          throw new ConfigError(
            `${path}.blockPrivateAddresses must be true or false`,
            `${path}.blockPrivateAddresses`,
          );
        }
        break;

      case 'mail':
        if (connection.transport !== 'injected') {
          throw new ConfigError(
            `${path}.transport must be "injected". The SDK ships no built-in mail ` +
              'transport; provide one via OrchestratorOverrides.mailTransport.',
            `${path}.transport`,
          );
        }
        break;

      default: {
        const { type } = connection as { type: string };
        throw new ConfigError(
          `${path}.type '${type}' is unknown. Use sql, mongo, http, or mail.`,
          `${path}.type`,
        );
      }
    }

    // A credential ref pointing nowhere is a typo worth catching at load time:
    // discovering it on the first query means discovering it in production.
    // Only checked against the config section — an injected CredentialProvider
    // resolves refs the config knows nothing about.
    const credential = connection.credential;
    if (
      credential !== undefined &&
      'ref' in credential &&
      cfg.credentials !== undefined &&
      !(credential.ref in credentials)
    ) {
      throw new ConfigError(
        `${path}.credential.ref '${credential.ref}' is not declared in the ` +
          `credentials section. Declared: ${Object.keys(credentials).join(', ') || '(none)'}. ` +
          'Omit the credentials section entirely if refs are resolved by an injected provider.',
        `${path}.credential.ref`,
      );
    }
  }
}

/**
 * Validates the optional declarative sections (`tools.definitions`, `skills`,
 * `agents`). Cross-references are checked structurally here; whether an
 * internal `ref` or external module actually resolves is verified at load time.
 */
function validateDeclarative(cfg: SDKConfig): void {
  // ── MCP servers ──────────────────────────────────────────────────────────
  // Validated before tool definitions so that `kind: 'mcp'` tools can be
  // cross-checked against the set of declared server names.
  const mcpServers = cfg.mcp?.servers ?? {};
  for (const [name, server] of Object.entries(mcpServers)) {
    const path = `mcp.servers.${name}`;

    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || server.command === '') {
        throw new ConfigError(
          `${path}.command is required when transport is "stdio"`,
          `${path}.command`,
        );
      }
      // A stdio server is process execution, so the command is gated the same
      // way `tools.moduleRoots` gates external module paths.
      const allowed = cfg.mcp?.allowedCommands;
      if (allowed !== undefined && !allowed.includes(server.command)) {
        throw new ConfigError(
          `${path}.command '${server.command}' is not in mcp.allowedCommands. ` +
            `Allowed: ${allowed.join(', ') || '(none)'}`,
          `${path}.command`,
        );
      }
    } else if (server.transport === 'http') {
      if (typeof server.url !== 'string' || server.url === '') {
        throw new ConfigError(`${path}.url is required when transport is "http"`, `${path}.url`);
      }
      try {
        new URL(server.url);
      } catch {
        throw new ConfigError(`${path}.url is not a valid URL: '${server.url}'`, `${path}.url`);
      }
    } else {
      throw new ConfigError(
        `${path}.transport must be "stdio" or "http". A "custom" transport ` +
          'carries a function and cannot survive the config deep-clone; inject ' +
          'a pre-built client via OrchestratorOverrides.mcpClients instead.',
        `${path}.transport`,
      );
    }
  }

  // ── Tool definitions ─────────────────────────────────────────────────────
  const toolNames = new Set<string>();
  const definitions = cfg.tools.definitions ?? [];

  definitions.forEach((def, i) => {
    const path = `tools.definitions[${i}]`;
    if (typeof def.name !== 'string' || def.name === '') {
      throw new ConfigError(`${path}.name is required`, `${path}.name`);
    }
    if (toolNames.has(def.name)) {
      throw new ConfigError(`Duplicate tool name '${def.name}'`, `${path}.name`);
    }
    toolNames.add(def.name);

    if (def.kind === 'module') {
      if (typeof def.module !== 'string' || def.module === '') {
        throw new ConfigError(`${path}.module is required when kind is "module"`, `${path}.module`);
      }
    } else if (def.kind === 'internal') {
      if (typeof def.ref !== 'string' || def.ref === '') {
        throw new ConfigError(`${path}.ref is required when kind is "internal"`, `${path}.ref`);
      }
    } else if (def.kind === 'mcp') {
      if (typeof def.server !== 'string' || def.server === '') {
        throw new ConfigError(`${path}.server is required when kind is "mcp"`, `${path}.server`);
      }
      if (typeof def.remoteName !== 'string' || def.remoteName === '') {
        throw new ConfigError(
          `${path}.remoteName is required when kind is "mcp"`,
          `${path}.remoteName`,
        );
      }
    } else {
      throw new ConfigError(`${path}.kind must be "module", "internal" or "mcp"`, `${path}.kind`);
    }
  });

  if (cfg.tools.loadMode !== undefined && !['strict', 'tolerant'].includes(cfg.tools.loadMode)) {
    throw new ConfigError('tools.loadMode must be "strict" or "tolerant"', 'tools.loadMode');
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  // A skill may also reference tools registered in code, so unknown names are
  // only flagged when there are no in-code registrations to account for them:
  // the definitive check happens in the DeclarativeLoader at runtime.
  const skillNames = new Set<string>();
  const skills = cfg.skills ?? [];

  skills.forEach((skill, i) => {
    const path = `skills[${i}]`;
    if (typeof skill.name !== 'string' || skill.name === '') {
      throw new ConfigError(`${path}.name is required`, `${path}.name`);
    }
    if (skillNames.has(skill.name)) {
      throw new ConfigError(`Duplicate skill name '${skill.name}'`, `${path}.name`);
    }
    skillNames.add(skill.name);

    if (!Array.isArray(skill.tools)) {
      throw new ConfigError(`${path}.tools must be an array of tool names`, `${path}.tools`);
    }
  });

  // ── Agents ───────────────────────────────────────────────────────────────
  const agentIds = new Set<string>();
  const agents = cfg.agents ?? [];

  agents.forEach((agent, i) => {
    const path = `agents[${i}]`;
    if (typeof agent.id !== 'string' || agent.id === '') {
      throw new ConfigError(`${path}.id is required`, `${path}.id`);
    }
    if (agentIds.has(agent.id)) {
      throw new ConfigError(`Duplicate agent id '${agent.id}'`, `${path}.id`);
    }
    agentIds.add(agent.id);

    if (typeof agent.name !== 'string' || agent.name === '') {
      throw new ConfigError(`${path}.name is required`, `${path}.name`);
    }
    if (typeof agent.systemPrompt !== 'string' || agent.systemPrompt === '') {
      throw new ConfigError(`${path}.systemPrompt is required`, `${path}.systemPrompt`);
    }
    if (!Array.isArray(agent.skills)) {
      throw new ConfigError(`${path}.skills must be an array of skill names`, `${path}.skills`);
    }
    // Agent→skill references are not cross-checked here: a skill may be
    // registered in code rather than declared in `skills`. Unknown skills are
    // resolved (and skipped) at run time by the SkillRegistry.
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfigLoader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads, merges, and validates the SDK configuration.
 *
 * ### Merge order (later wins)
 * 1. Built-in defaults (`src/config/defaults.json`)
 * 2. User config file (JSON, with `${ENV_VAR}` resolution)
 * 3. Programmatic `overrides` passed to the factory method
 *
 * ### Factory methods
 * - {@link ConfigLoader.from} — synchronous, no file I/O.
 * - {@link ConfigLoader.load} — async, reads a JSON file.
 *
 * @example
 * ```typescript
 * // From file
 * const config = await ConfigLoader.load('./agent349.config.json');
 *
 * // Programmatic only
 * const config = ConfigLoader.from({ agent: { maxLoopIterations: 5 } });
 *
 * // Read a section
 * const { defaultTimeoutMs } = config.getSection('tools');
 * ```
 */
export class ConfigLoader {
  readonly #config: SDKConfig;
  readonly #sourceDir: string | undefined;

  private constructor(config: SDKConfig, sourceDir?: string) {
    this.#config = config;
    this.#sourceDir = sourceDir;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factories
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a `ConfigLoader` **without reading any file**.
   * Merges built-in defaults with optional programmatic overrides.
   *
   * @param overrides - Partial config values that override the defaults.
   * @throws {@link ConfigError} if the merged config fails validation.
   */
  static from(overrides?: DeepPartial<SDKConfig>): ConfigLoader {
    const unresolved = overrides ? deepMerge(DEFAULTS, overrides) : structuredClone(DEFAULTS);
    const merged = resolveEnvVars(unresolved) as SDKConfig;
    validate(merged);
    return new ConfigLoader(merged);
  }

  /**
   * Creates a `ConfigLoader` by reading a JSON config file, resolving
   * `${ENV_VAR}` placeholders, and applying optional programmatic overrides.
   *
   * @param filePath  - Absolute or relative path to the JSON config file.
   *                    Omit to use only defaults + overrides (no file read).
   * @param overrides - Programmatic overrides applied last (highest priority).
   * @throws {@link ConfigError} if the file cannot be read, is not valid JSON,
   *                             or the merged config fails validation.
   */
  static async load(filePath?: string, overrides?: DeepPartial<SDKConfig>): Promise<ConfigLoader> {
    let userConfig: DeepPartial<SDKConfig> = {};

    if (filePath !== undefined) {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (err) {
        throw new ConfigError(`Cannot read config file: ${filePath}`, 'filePath', {
          cause: err instanceof Error ? err : undefined,
        });
      }

      try {
        userConfig = JSON.parse(raw) as DeepPartial<SDKConfig>;
      } catch (err) {
        throw new ConfigError(`Config file is not valid JSON: ${filePath}`, 'filePath', {
          cause: err instanceof Error ? err : undefined,
        });
      }

      userConfig = resolveEnvVars(userConfig) as DeepPartial<SDKConfig>;
    }

    let merged = deepMerge(DEFAULTS, userConfig);
    if (overrides !== undefined) {
      merged = deepMerge(merged, overrides);
    }

    validate(merged);
    return new ConfigLoader(merged, filePath !== undefined ? dirname(filePath) : undefined);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a deep clone of the fully-resolved configuration.
   * Mutations to the returned object do not affect the loader's internal state.
   */
  get(): SDKConfig {
    return structuredClone(this.#config);
  }

  /**
   * Directory of the config file this loader was created from, or `undefined`
   * when the config was built without a file (via {@link ConfigLoader.from} or
   * {@link ConfigLoader.load} without a path). Used as the base for resolving
   * relative tool module paths.
   */
  get sourceDir(): string | undefined {
    return this.#sourceDir;
  }

  /**
   * Returns a deep clone of a single top-level configuration section.
   *
   * @param section - Key of the section to retrieve.
   */
  getSection<K extends keyof SDKConfig>(section: K): SDKConfig[K] {
    return structuredClone(this.#config[section]);
  }
}

const VECTOR_STORE_ADAPTERS = [
  'in-memory',
  'meilisearch',
  'pgvector',
  'qdrant',
  'pinecone',
  'weaviate',
  'milvus',
] as const;

/**
 * Validates the `rag.vectorStore` section for the database-backed adapters.
 *
 * @throws {@link ConfigError} on an unknown adapter, a missing required
 *         setting, or a retrieval mode the adapter cannot serve.
 */
function validateVectorStore(rag: SDKConfig['rag']): void {
  const vs = rag.vectorStore;
  if (!(VECTOR_STORE_ADAPTERS as readonly string[]).includes(vs.adapter)) {
    throw new ConfigError(
      `rag.vectorStore.adapter must be one of: ${VECTOR_STORE_ADAPTERS.join(', ')}`,
      'rag.vectorStore.adapter',
    );
  }
  if (vs.adapter === 'pgvector') {
    const pg = vs.pgvector;
    if (pg === undefined || ((pg.connectionString ?? '') === '' && (pg.host ?? '') === '')) {
      throw new ConfigError(
        'rag.vectorStore.pgvector.connectionString (or host) is required when adapter is "pgvector"',
        'rag.vectorStore.pgvector',
      );
    }
  }
  if (vs.adapter === 'pinecone') {
    if (vs.pinecone === undefined || (vs.pinecone.indexName ?? '') === '') {
      throw new ConfigError(
        'rag.vectorStore.pinecone.indexName is required when adapter is "pinecone"',
        'rag.vectorStore.pinecone.indexName',
      );
    }
    if (rag.retrieval.searchMode !== 'vector') {
      throw new ConfigError(
        'Pinecone supports vector search only: set rag.retrieval.searchMode to "vector"',
        'rag.retrieval.searchMode',
      );
    }
  }
  if (vs.adapter === 'weaviate' && vs.weaviate?.classPrefix !== undefined) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(vs.weaviate.classPrefix)) {
      throw new ConfigError(
        'rag.vectorStore.weaviate.classPrefix must start with an uppercase letter and contain only letters, digits and "_"',
        'rag.vectorStore.weaviate.classPrefix',
      );
    }
  }
}
