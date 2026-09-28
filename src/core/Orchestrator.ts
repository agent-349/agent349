import { randomUUID } from 'node:crypto';
import type {
  AgentConfig,
  AgentResponse,
  BatchJob,
  BatchRequestItem,
  BatchResultItem,
  BatchSubmitOptions,
  ChatOptions,
  ExecutionContext,
  FileUploadInput,
  LLMMessage,
  MessageContent,
  ProviderCapabilities,
  ProviderFileRef,
  RunOptions,
  Skill,
  Tool,
  ToolResult,
  ProviderProbe,
} from '../types/index.js';
import {
  AccessDeniedError,
  ConfigError,
  TokenLimitError,
  UnsupportedCapabilityError,
} from '../errors/index.js';
import type { ApprovalService } from '../approval/ApprovalService.js';
import { DEFAULT_APPROVAL_MESSAGES, formatApprovalMessage } from '../approval/messages.js';
import type { PendingAction } from '../types/index.js';
import { ConfigLoader, resolveLLMProviderType } from '../config/ConfigLoader.js';
import type { SDKConfig, DeepPartial } from '../config/ConfigLoader.js';
import { ModuleResolver } from '../config/ModuleResolver.js';
import { loadDeclarativeConfig } from '../config/DeclarativeLoader.js';
import { loadMcpServers } from '../config/McpLoader.js';
import type { McpClient } from '../mcp/McpClient.js';
import type { McpToolBridge } from '../mcp/McpToolBridge.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import { UntrustedTracker } from '../security/UntrustedTracker.js';
import { ConnectionManager } from '../connections/ConnectionManager.js';
import type {
  ConnectionConfig,
  ConnectionHandle,
  InjectedConnection,
} from '../connections/types.js';
import { ConfigCredentialProvider } from '../credentials/ConfigCredentialProvider.js';
import { CredentialProvider } from '../credentials/CredentialProvider.js';
import { DocumentStore } from '../tools/builtin/doc/DocumentStore.js';
import { MailTransport } from '../tools/builtin/mail/MailTransport.js';
import type { Credential } from '../credentials/types.js';
import type { InternalToolContext } from '../tools/internalTools.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import {
  LLMProvider,
  textOnlyCapabilities,
  supportsBatch,
  supportsFiles,
} from '../llm/LLMProvider.js';
import type { BatchCapableProvider } from '../llm/LLMProvider.js';
import { LLMRouter } from '../llm/LLMRouter.js';
import { ContentResolver } from '../llm/ContentResolver.js';
import { LLMAdapterRegistry } from './LLMAdapterRegistry.js';
import type { LLMAdapterFactory } from './LLMAdapterRegistry.js';
import { DefaultMemoryManager } from '../memory/DefaultMemoryManager.js';
import { SlidingWindow } from '../memory/strategies/SlidingWindow.js';
import { createStorageAdapter } from '../memory/adapters/createStorageAdapter.js';
import type { StorageAdapter } from '../memory/adapters/StorageAdapter.js';
import type { StorageRegistry } from '../memory/adapters/StorageRegistry.js';
import { SessionManager } from '../session/SessionManager.js';
import { TokenTracker, estimateLLMRequestTokens } from '../tokens/TokenTracker.js';
import { PricingTable } from '../tokens/PricingTable.js';
import { AuditLogger } from '../audit/AuditLogger.js';
import type { AuditConfig } from '../audit/AuditLogger.js';
import { AuditStoreAdapter } from '../audit/store/AuditStoreAdapter.js';
import { createAuditStore } from '../audit/store/createAuditStore.js';
import { SIEMForwarder } from '../audit/siem/SIEMForwarder.js';
import { createSIEMForwarder } from '../audit/siem/createSIEMForwarder.js';
import { LoggerAdapter } from '../logging/LoggerAdapter.js';
import { ConsoleLoggerAdapter } from '../logging/ConsoleLoggerAdapter.js';
import { LogCollector } from '../logging/LogCollector.js';
import { Observability } from '../observability/Observability.js';
import type { LLMRequest, LLMResponse } from '../types/index.js';
import { AgentLoop } from './AgentLoop.js';
// Planner
import { Planner } from './Planner.js';
// RAG
import { createRAGTool } from '../rag/RAGTool.js';
import { EmbeddingRouter } from '../rag/embedding/EmbeddingRouter.js';
import { OpenAIEmbeddingProvider } from '../rag/embedding/OpenAIEmbedding.js';
import { CohereEmbeddingProvider } from '../rag/embedding/CohereEmbedding.js';
import { OllamaEmbeddingProvider } from '../rag/embedding/OllamaEmbedding.js';
import { InMemoryVectorStore } from '../rag/vectorstore/InMemoryVectorStore.js';
import { MeilisearchAdapter } from '../rag/vectorstore/MeilisearchAdapter.js';
import { createVectorStoreAdapter } from '../rag/vectorstore/createVectorStoreAdapter.js';
import type { VectorStoreAdapter } from '../rag/vectorstore/VectorStoreAdapter.js';
import { RAGPipeline } from '../rag/RAGPipeline.js';
import { RAGFacade } from '../rag/RAGFacade.js';
import { IngestionPipeline } from '../rag/ingestion/IngestionPipeline.js';
import { CollectionManager } from '../rag/collections/CollectionManager.js';
import { DocumentLoaderRegistry } from '../rag/ingestion/DocumentLoaderRegistry.js';
import { PlainTextLoader } from '../rag/ingestion/loaders/PlainTextLoader.js';
import { MarkdownLoader } from '../rag/ingestion/loaders/MarkdownLoader.js';
import { HTMLLoader } from '../rag/ingestion/loaders/HTMLLoader.js';
import { PDFLoader } from '../rag/ingestion/loaders/PDFLoader.js';
import { DOCXLoader } from '../rag/ingestion/loaders/DOCXLoader.js';
import { RecursiveChunker } from '../rag/ingestion/chunking/RecursiveChunker.js';
import { LLMReranker } from '../rag/reranker/LLMReranker.js';
import { CohereReranker } from '../rag/reranker/CohereReranker.js';
import { TEIReranker } from '../rag/reranker/TEIReranker.js';
import type { RerankerProvider } from '../rag/reranker/RerankerProvider.js';
import { ContextualRewriter } from '../rag/queryRewriting/ContextualRewriter.js';
import { HyDERewriter } from '../rag/queryRewriting/HyDERewriter.js';
import type { QueryRewriter } from '../rag/queryRewriting/QueryRewriter.js';
import type { ACLService } from '../security/ACLService.js';
import type { SecurityMiddlewareChain } from '../security/middleware/SecurityMiddlewareChain.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: AgentLLMAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thin `LLMProvider` shim that routes calls through `LLMRouter` using the
 * primary/fallback provider names specified in an `AgentConfig`.
 *
 * Created per-request so each `AgentLoop` instance holds a stable provider
 * reference while the underlying routing/circuit-breaker state is shared.
 */
/** Fully-resolved LLM configuration — all fields required except fallbacks. */
interface ResolvedLLMConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fallbackProvider?: string;
  fallbackModel?: string;
}

class AgentLLMAdapter extends LLMProvider {
  override readonly name: string;
  override readonly providerType: string;
  readonly #router: LLMRouter;
  readonly #primaryProvider: string;
  readonly #fallbackProvider: string | undefined;
  readonly #fallbackModel: string | undefined;

  constructor(router: LLMRouter, resolved: ResolvedLLMConfig) {
    super();
    this.name = `router:${resolved.provider}`;
    this.#router = router;
    this.#primaryProvider = resolved.provider;
    this.#fallbackProvider = resolved.fallbackProvider;
    this.#fallbackModel = resolved.fallbackModel;
    this.providerType = router.getProvider(resolved.provider)?.providerType ?? 'router';
  }

  /**
   * Reports the **primary** provider's capabilities.
   *
   * The agent loop builds one request, so it must plan against the provider it
   * will actually reach first; the router independently refuses to fall back to
   * a provider that cannot serve that request.
   */
  override capabilities(model?: string): ProviderCapabilities {
    return (
      this.#router.getProvider(this.#primaryProvider)?.capabilities(model) ?? textOnlyCapabilities()
    );
  }

  override async call(request: LLMRequest): Promise<LLMResponse> {
    return this.#router.call(
      request,
      this.#primaryProvider,
      this.#fallbackProvider,
      this.#fallbackModel,
    );
  }

  override async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }

  override async listModels(): Promise<string[]> {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP
// ─────────────────────────────────────────────────────────────────────────────

/** What a call to {@link Orchestrator.refreshMcpTools} changed for one server. */
export interface McpRefreshResult {
  /** Server whose catalogue was re-read. */
  server: string;
  /** Tools the server now exposes that were not registered before. */
  added: string[];
  /** Tools re-registered from the current catalogue (schema may have changed). */
  updated: string[];
  /** Tools removed because the server no longer exposes them. */
  removed: string[];
  /**
   * Tools left untouched because a `tools.definitions` entry claims the name.
   * An explicit declaration keeps winning over the server's catalogue.
   */
  skipped: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// OrchestratorOverrides
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-layer storage adapter overrides for {@link Orchestrator.fromConfig}.
 *
 * When an adapter is provided here it takes priority over both the
 * {@link StorageRegistry} and config-driven construction for that layer.
 */
export interface OrchestratorStorageOverrides {
  /** Override for Level-1 (session conversation history) storage. */
  sessionMemory?: StorageAdapter;
  /** Override for Level-2 (long-term facts) storage. */
  longTerm?: StorageAdapter;
  /** Override for session record storage ({@link SessionManager}). */
  sessions?: StorageAdapter;
  /** Override for token usage record storage ({@link TokenTracker}). */
  tokens?: StorageAdapter;
}

/**
 * Optional overrides passed to {@link Orchestrator.fromConfig} and
 * {@link Orchestrator.create} for programmatic injection of adapters
 * and full subsystem replacements.
 */
export interface OrchestratorOverrides {
  /**
   * Per-layer storage adapter overrides.
   * Takes priority over `storageRegistry` and config-driven creation.
   */
  storage?: OrchestratorStorageOverrides;
  /**
   * Registry of pre-built adapters keyed by backend name.
   * For any layer whose backend name is in the registry, the registered
   * adapter is used instead of creating one from config.
   */
  storageRegistry?: StorageRegistry;
  /**
   * Replace the entire memory manager instead of composing one from adapters.
   * When set, `storage.sessionMemory`, `storage.longTerm`, and the
   * memory-related config are ignored for manager construction.
   */
  memoryManager?: DefaultMemoryManager;
  /** Replace the session manager entirely. */
  sessionManager?: SessionManager;
  /** Replace the token tracker entirely. */
  tokenTracker?: TokenTracker;
  /**
   * Inject a pre-built audit store. Used to back the auto-created AuditLogger
   * when `audit.enabled` is `true`. Ignored if `auditLogger` is also provided.
   * The caller owns this adapter's lifecycle (it is not closed on shutdown).
   */
  auditStore?: AuditStoreAdapter;
  /**
   * Replace the entire audit logger. When set, `audit.store` / `auditStore` are
   * ignored for construction. Auto-capture is still started by the Orchestrator
   * (unless `audit.enabled` is `false`). The caller owns its store's lifecycle.
   */
  auditLogger?: AuditLogger;
  /**
   * Inject a custom SIEM forwarder. Takes priority over `audit.siem`. Used only
   * when the Orchestrator builds the AuditLogger (ignored if `auditLogger` is
   * provided). The forwarder is closed by `shutdown()` via `stopAutoCapture()`.
   */
  siemForwarder?: SIEMForwarder;
  /**
   * Pre-built MCP clients keyed by server name, merged with (and taking
   * priority over) anything declared in `mcp.servers`.
   *
   * This is the way to use a transport the config cannot express — the config
   * is deep-cloned and therefore has to stay serialisable, while a `custom`
   * transport carries a factory function.
   *
   * Bridging options (`namespace`, `tags`, `autoRegisterTools`, …) are still
   * read from the matching `mcp.servers` entry when one exists. Unlike audit
   * stores, injected clients **are** closed by `shutdown()`: they usually own a
   * child process, and leaking one is worse than a redundant close (which is a
   * no-op, since `McpClient.close()` is idempotent).
   */
  mcpClients?: Record<string, McpClient>;
  /**
   * Inject a custom technical-log sink (e.g. pino, winston, Loki). Takes
   * priority over `logging.adapter`. When set, the Orchestrator starts a
   * {@link LogCollector} regardless of the configured adapter.
   */
  logger?: LoggerAdapter;
  /**
   * Resolver for the credential references named by `connections`. Takes
   * priority over the `credentials` config section.
   *
   * This is how OAuth reaches the SDK: the built-in provider only reads static
   * values from config, while an injected one owns refresh, rotation and
   * encryption at rest — state the SDK deliberately does not take on. Because
   * `get()` receives the `ExecutionContext`, an implementation can return
   * per-user credentials, not just service ones.
   */
  credentialProvider?: CredentialProvider;
  /**
   * Connections the host opened itself, keyed by name. Merged with — and
   * taking priority over — the `connections` config section.
   *
   * Use this when the host already holds a pool against the same database:
   * one pool, one lifecycle. `shutdown()` closes only what the SDK opened, so
   * these stay the host's to close.
   */
  connections?: Record<string, InjectedConnection>;
  /**
   * Document stores for `doc.read` sources of kind `'store'`, keyed by name.
   *
   * The way to let an agent read documents that live in the application's own
   * store: the implementation applies the host's access control before handing
   * any bytes back, and receives the `ExecutionContext` in order to.
   */
  documentStores?: Record<string, DocumentStore>;
  /**
   * Transport used by `mail.send`. Required for that tool — the SDK ships no
   * built-in transport, since that would mean a new dependency and every host
   * that wants the tool already has a mailer.
   */
  mailTransport?: MailTransport;
  /**
   * Vector store for the RAG module. Takes precedence over
   * `rag.vectorStore`: use it to plug in your own {@link VectorStoreAdapter}
   * or a pre-configured instance. An injected store is never closed by
   * {@link Orchestrator.shutdown}.
   */
  vectorStore?: VectorStoreAdapter;
  /**
   * Extra LLM adapter factories keyed by provider `type`, merged on top of the
   * built-ins (`openai`, `openai-compatible`, `claude`, `ollama`). Use this to
   * support a new adapter type declaratively in `llm.providers`, or to override
   * how a built-in type is constructed. Pre-built provider instances can instead
   * be injected after construction via {@link Orchestrator.registerProvider}.
   */
  llmAdapters?: Record<string, LLMAdapterFactory>;
  /**
   * Base directory for resolving relative tool module paths declared in
   * `tools.definitions`. Defaults to the config file's directory when created
   * via {@link Orchestrator.create}; falls back to `process.cwd()` otherwise.
   */
  baseDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level entry point for the Agent Orchestration SDK.
 *
 * The Orchestrator assembles every internal component into a single, coherent
 * runtime and exposes two API tiers:
 *
 * ### High-level API (5 lines)
 * ```typescript
 * const orch = await Orchestrator.create('./agent349.config.json');
 * const response = await orch.chat(
 *   'agent-finance-01',
 *   'What is the balance of account 1001?',
 *   { tenantId: 'acme', userId: 'user-42', roles: ['finance_viewer'] },
 * );
 * console.log(response.content);
 * ```
 *
 * ### Low-level API
 * Access the underlying components via getters (`toolRegistry`, `skillRegistry`,
 * `sessions`, `events`, `tokens`) and register agents, tools, and skills
 * dynamically at runtime.
 *
 * ### LLM Providers
 * Providers are auto-created from the config when an API key is present.
 * Use {@link registerProvider} to inject additional providers (e.g. mock
 * providers in tests, or custom provider implementations).
 */
export class Orchestrator {
  readonly #config: SDKConfig;
  readonly #toolRegistry: ToolRegistry;
  readonly #skillRegistry: SkillRegistry;
  readonly #router: LLMRouter;
  readonly #memory: DefaultMemoryManager;
  readonly #sessions: SessionManager;
  readonly #bus: EventBus;
  readonly #tokens: TokenTracker;
  readonly #agents: Map<string, AgentConfig> = new Map();
  /** Adapters created by the factory — closed on {@link shutdown}. */
  readonly #ownedAdapters: StorageAdapter[] = [];
  /** Audit logger, present only when `audit.enabled` is `true`. */
  readonly #auditLogger: AuditLogger | undefined;
  /** Audit store created by the factory — closed on {@link shutdown}. */
  readonly #ownedAuditStore: AuditStoreAdapter | undefined;
  /** Technical-log collector, present only when a logger sink is active. */
  readonly #logCollector: LogCollector | undefined;
  /** MCP clients created from `mcp.servers` — closed on {@link shutdown}. */
  readonly #mcpClients: Map<string, McpClient> = new Map();
  /** Bridges per MCP server, retained so tools can be re-synced later. */
  readonly #mcpBridges: Map<string, McpToolBridge> = new Map();
  /**
   * Tool names this Orchestrator auto-registered per MCP server. A refresh only
   * removes entries it owns; anything else in the registry belongs to someone
   * else and is left alone.
   */
  readonly #mcpAutoRegistered: Map<string, Set<string>> = new Map();
  /** Lazily-built observability façade over the three planes. */
  #observability: Observability | undefined;
  #ragFacade: RAGFacade | undefined;
  /** Programmatically-registered reranker; takes precedence over `rag.reranker`. */
  #rerankerOverride: RerankerProvider | undefined;
  #approvalService: ApprovalService | undefined;
  #aclService: ACLService | undefined;
  #securityChain: SecurityMiddlewareChain | undefined;
  /** Credential resolver for integration tools. Set right after construction. */
  #credentialProvider: CredentialProvider | undefined;
  /** Host-opened connections injected via overrides; never closed by the SDK. */
  #injectedConnections: Record<string, InjectedConnection> | undefined;
  /** Lazily-built manager for the `connections` section — closed on {@link shutdown}. */
  #connectionManager: ConnectionManager | undefined;
  /** Document stores injected by the host, for `doc.read`. */
  #documentStores: Record<string, DocumentStore> | undefined;
  /** Mail transport injected by the host, for `mail.send`. */
  #mailTransport: MailTransport | undefined;
  /** Vector store injected by the host (`overrides.vectorStore`). */
  #injectedVectorStore: VectorStoreAdapter | undefined;
  /** Vector store built from `rag.vectorStore` — closed on {@link shutdown}. */
  #ownedVectorStore: VectorStoreAdapter | undefined;
  /** Memoised services handed to internal tool factories. */
  #toolServicesCache: InternalToolContext | undefined;
  /** Executor for host-initiated tool calls; built on first use. */
  #hostToolExecutor: ToolExecutor | undefined;

  private constructor(
    config: SDKConfig,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    router: LLMRouter,
    memory: DefaultMemoryManager,
    sessions: SessionManager,
    bus: EventBus,
    tokens: TokenTracker,
    ownedAdapters: StorageAdapter[],
    auditLogger: AuditLogger | undefined,
    ownedAuditStore: AuditStoreAdapter | undefined,
    logCollector: LogCollector | undefined,
  ) {
    this.#config = config;
    this.#toolRegistry = toolRegistry;
    this.#skillRegistry = skillRegistry;
    this.#router = router;
    this.#memory = memory;
    this.#sessions = sessions;
    this.#bus = bus;
    this.#tokens = tokens;
    this.#ownedAdapters = ownedAdapters;
    this.#auditLogger = auditLogger;
    this.#ownedAuditStore = ownedAuditStore;
    this.#logCollector = logCollector;
  }

  /**
   * Maps the declarative `audit` config section into the {@link AuditConfig}
   * shape consumed by {@link AuditLogger}. Regex-based `customPatterns` are not
   * representable in JSON and must be injected via the `auditLogger` override.
   */
  static #toAuditConfig(config: SDKConfig): AuditConfig {
    const a = config.audit;
    return {
      verbosity: a.verbosity,
      ...(a.verbosityOverrides !== undefined && { verbosityOverrides: a.verbosityOverrides }),
      buffer: { maxSize: a.buffer.maxSize, flushIntervalMs: a.buffer.flushIntervalMs },
      ...(a.retention?.default !== undefined && { retention: { default: a.retention.default } }),
      sensitiveData: {
        enabled: a.sensitiveData.enabled,
        ...(a.sensitiveData.globalRedactFields !== undefined && {
          globalRedactFields: a.sensitiveData.globalRedactFields,
        }),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factories
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates an `Orchestrator` from a JSON config file or an inline partial config.
   *
   * `${ENV_VAR}` placeholders are resolved from `process.env`. LLM providers are
   * automatically instantiated for any provider whose API key resolves to a
   * non-empty string. In both forms the result is merged with the SDK's built-in
   * defaults (see `ConfigLoader`), so omitted sections (e.g. `llm.circuitBreaker`)
   * fall back to sensible values.
   *
   * @param config    - Absolute or relative path to a JSON config file, or a
   *                    partial {@link SDKConfig} object to merge with defaults.
   * @param overrides - Optional programmatic overrides for storage adapters.
   * @throws {@link ConfigError} if a file path is missing/invalid JSON, or the
   *                             resolved config fails validation.
   */
  static async create(
    config: string | DeepPartial<SDKConfig>,
    overrides?: OrchestratorOverrides,
  ): Promise<Orchestrator> {
    const loader =
      typeof config === 'string' ? await ConfigLoader.load(config) : ConfigLoader.from(config);
    const baseDir = overrides?.baseDir ?? loader.sourceDir;
    return Orchestrator.fromConfig(loader.get(), {
      ...overrides,
      ...(baseDir !== undefined && { baseDir }),
    });
  }

  /**
   * Creates an `Orchestrator` from a fully-resolved {@link SDKConfig} object.
   *
   * ### Storage resolution order (per layer)
   * 1. `overrides.storage.<layer>` — direct adapter injection.
   * 2. `overrides.storageRegistry.get(backendName)` — registry lookup.
   * 3. `createStorageAdapter(config.storage.backends[backendName])` — built from config.
   *
   * Adapters created by step 3 are owned by the Orchestrator and closed on
   * {@link shutdown}. Injected adapters (steps 1–2) are the caller's responsibility.
   *
   * @param config    - The resolved SDK configuration.
   * @param overrides - Optional programmatic overrides for adapters and subsystems.
   */
  static async fromConfig(
    config: SDKConfig,
    overrides?: OrchestratorOverrides,
  ): Promise<Orchestrator> {
    const bus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const ownedAdapters: StorageAdapter[] = [];

    // ── LLM Router ──────────────────────────────────────────────────────────
    const router = new LLMRouter(new Map(), {
      failureThreshold: config.llm.circuitBreaker.failureThreshold,
      recoveryTimeMs: config.llm.circuitBreaker.recoveryTimeMs,
    });

    // Instantiate every named provider instance via the adapter registry.
    // Types are resolved explicitly or inferred for the historical keys; a
    // factory returning `undefined` (e.g. a cloud adapter without an API key)
    // is skipped, preserving the previous "register only when configured"
    // behaviour. Custom adapter types come from `overrides.llmAdapters`.
    const adapterRegistry = new LLMAdapterRegistry(overrides?.llmAdapters);
    for (const [name, entry] of Object.entries(config.llm.providers)) {
      const type = resolveLLMProviderType(name, entry);
      // Surface an ambiguous auth setup rather than resolving it silently.
      if (
        entry.apiKey !== undefined &&
        entry.apiKey !== '' &&
        entry.headers?.['Authorization'] !== undefined
      ) {
        bus.emit('llm.provider.auth_conflict', {
          provider: name,
          message: 'Both apiKey and a headers.Authorization are set; the header takes precedence.',
        });
      }
      const provider = adapterRegistry.create(type, name, entry);
      if (provider !== undefined) {
        router.registerProvider(provider);
      }
    }

    // ── Storage adapter resolution ───────────────────────────────────────────
    const resolve = async (
      backendName: string,
      layerOverride: StorageAdapter | undefined,
    ): Promise<StorageAdapter> => {
      if (layerOverride !== undefined) return layerOverride;
      const fromRegistry = overrides?.storageRegistry?.get(backendName);
      if (fromRegistry !== undefined) return fromRegistry;
      const adapter = await createStorageAdapter(config.storage.backends[backendName]!);
      ownedAdapters.push(adapter);
      return adapter;
    };

    // ── Memory ───────────────────────────────────────────────────────────────
    let memory: DefaultMemoryManager;
    if (overrides?.memoryManager !== undefined) {
      memory = overrides.memoryManager;
    } else {
      const [sessionMemoryAdapter, longTermAdapter] = await Promise.all([
        resolve(config.memory.session.backend, overrides?.storage?.sessionMemory),
        resolve(config.memory.longTerm.backend, overrides?.storage?.longTerm),
      ]);

      const strategy = new SlidingWindow({
        maxMessages: config.memory.session.maxMessagesBeforeCompress,
      });

      memory = new DefaultMemoryManager(sessionMemoryAdapter, longTermAdapter, strategy, {
        sessionTtlSeconds: config.memory.session.ttlSeconds,
        maxFactsPerUser: config.memory.longTerm.maxFactsPerUser,
        ...(config.memory.session.mediaPersistence !== undefined && {
          mediaPersistence: config.memory.session.mediaPersistence,
        }),
        // Surface omissions on the bus: a restored conversation that lost a
        // document must be traceable, never silent.
        onMediaOmitted: (sessionId, omitted): void => {
          bus.emit('memory.media.omitted', { sessionId, omitted });
        },
      });
    }

    // ── Session ──────────────────────────────────────────────────────────────
    let sessions: SessionManager;
    if (overrides?.sessionManager !== undefined) {
      sessions = overrides.sessionManager;
    } else {
      const sessionsAdapter = await resolve(config.session.backend, overrides?.storage?.sessions);
      sessions = new SessionManager(sessionsAdapter, bus);
    }

    // ── Token Tracker ────────────────────────────────────────────────────────
    let tokens: TokenTracker;
    if (overrides?.tokenTracker !== undefined) {
      tokens = overrides.tokenTracker;
    } else {
      const tokensAdapter = await resolve(config.tokens.backend, overrides?.storage?.tokens);
      tokens = new TokenTracker(
        tokensAdapter,
        config.tokens.limits,
        new PricingTable(config.tokens.pricing),
        config.tokens.limitMode,
      );
    }

    // ── Audit ──────────────────────────────────────────────────────────────────
    let auditLogger: AuditLogger | undefined;
    let ownedAuditStore: AuditStoreAdapter | undefined;
    if (config.audit.enabled) {
      if (overrides?.auditLogger !== undefined) {
        auditLogger = overrides.auditLogger;
      } else {
        // Injected stores (overrides.auditStore) are the caller's to close;
        // config-built stores are owned and closed on shutdown.
        let store: AuditStoreAdapter;
        if (overrides?.auditStore !== undefined) {
          store = overrides.auditStore;
        } else {
          store = await createAuditStore(config.audit.store);
          ownedAuditStore = store;
        }
        // Real-time SIEM forwarding: override wins; otherwise build from config
        // (`audit.siem.type: 'none'` → undefined). Closed via stopAutoCapture().
        const forwarder =
          overrides?.siemForwarder ??
          (config.audit.siem !== undefined ? createSIEMForwarder(config.audit.siem) : undefined);
        auditLogger = new AuditLogger(store, bus, Orchestrator.#toAuditConfig(config), forwarder);
      }
      auditLogger.startAutoCapture();
    }

    // ── Technical logging ────────────────────────────────────────────────────
    // Silent by default: a collector is started only when a sink is selected
    // (config `logging.adapter: 'console'`) or injected via `overrides.logger`.
    let logCollector: LogCollector | undefined;
    {
      const lg = config.logging;
      const logger: LoggerAdapter | undefined =
        overrides?.logger ??
        (lg.adapter === 'console'
          ? new ConsoleLoggerAdapter({ format: lg.format ?? 'json' })
          : undefined);
      if (logger !== undefined) {
        logCollector = new LogCollector(bus, logger, {
          level: lg.level,
          ...(lg.includeData !== undefined && { includeData: lg.includeData }),
          ...(lg.redactFields !== undefined && { redactFields: lg.redactFields }),
        });
        logCollector.start();
      }
    }

    const orch = new Orchestrator(
      config,
      toolRegistry,
      skillRegistry,
      router,
      memory,
      sessions,
      bus,
      tokens,
      ownedAdapters,
      auditLogger,
      ownedAuditStore,
      logCollector,
    );

    // Integration-tool wiring. Set before #loadDeclarative so a tool built from
    // the config can resolve its connection while it is being constructed.
    // An injected provider wins over the `credentials` config section.
    orch.#credentialProvider =
      overrides?.credentialProvider ?? new ConfigCredentialProvider(config.credentials ?? {});
    if (overrides?.connections !== undefined) {
      orch.#injectedConnections = overrides.connections;
    }
    if (overrides?.documentStores !== undefined) {
      orch.#documentStores = overrides.documentStores;
    }
    if (overrides?.mailTransport !== undefined) {
      orch.#mailTransport = overrides.mailTransport;
    }
    if (overrides?.vectorStore !== undefined) {
      orch.#injectedVectorStore = overrides.vectorStore;
    }

    // Load declaratively-configured tools, skills, and agents (if any).
    await orch.#loadDeclarative(overrides?.baseDir, overrides?.mcpClients);

    return orch;
  }

  /**
   * Instantiates and registers the tools, skills, and agents declared in the
   * config (`tools.definitions`, `skills`, `agents`). No-op when none are
   * declared, preserving the pure code-registration flow.
   *
   * @param baseDir    - Base directory for resolving relative tool module paths.
   * @param mcpClients - Pre-built MCP clients injected via overrides.
   */
  async #loadDeclarative(baseDir?: string, mcpClients?: Record<string, McpClient>): Promise<void> {
    const cfg = this.#config;
    const hasTools = (cfg.tools.definitions?.length ?? 0) > 0;
    const hasSkills = (cfg.skills?.length ?? 0) > 0;
    const hasAgents = (cfg.agents?.length ?? 0) > 0;
    const hasMcp =
      Object.keys(cfg.mcp?.servers ?? {}).length > 0 || Object.keys(mcpClients ?? {}).length > 0;
    if (!hasTools && !hasSkills && !hasAgents && !hasMcp) return;

    const resolver = new ModuleResolver({
      ...(cfg.appHome !== undefined && { appHome: cfg.appHome }),
      ...(baseDir !== undefined && { configDir: baseDir }),
      ...(cfg.tools.moduleRoots !== undefined && { moduleRoots: cfg.tools.moduleRoots }),
    });

    const internalToolContext = this.toolServices;

    const loadMode = cfg.tools.loadMode ?? 'strict';

    // MCP servers first: `kind: 'mcp'` tool definitions resolve against the
    // bridges produced here, and auto-registered tools must land in the
    // registry before an explicit definition can override them.
    const mcp = await loadMcpServers(cfg.mcp?.servers, {
      toolRegistry: this.#toolRegistry,
      loadMode,
      emit: (event, data) => this.#bus.emit(event, data),
      eventBus: this.#bus,
      ...(mcpClients !== undefined && { injectedClients: mcpClients }),
    });
    for (const [name, client] of mcp.clients) {
      this.#mcpClients.set(name, client);
    }
    for (const [name, bridge] of mcp.bridges) {
      this.#mcpBridges.set(name, bridge);
    }
    for (const [name, toolNames] of mcp.autoRegistered) {
      this.#mcpAutoRegistered.set(name, new Set(toolNames));
    }

    await loadDeclarativeConfig(
      {
        ...(cfg.tools.definitions !== undefined && { tools: cfg.tools.definitions }),
        ...(cfg.skills !== undefined && { skills: cfg.skills }),
      },
      {
        toolRegistry: this.#toolRegistry,
        skillRegistry: this.#skillRegistry,
        internalToolContext,
        resolver,
        mcpBridges: mcp.bridges,
        loadMode,
        emit: (event, data) => this.#bus.emit(event, data),
      },
    );

    for (const agent of cfg.agents ?? []) {
      this.registerAgent(agent);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // High-level API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a message to an agent and returns the response.
   *
   * If no `sessionId` is provided in `options`, a new session is created
   * automatically. Pass `options.sessionId` on subsequent calls to maintain
   * conversation continuity.
   *
   * @param agentId  - ID of the registered agent to invoke.
   * @param message  - The user's turn: plain text, or content blocks when it
   *                   carries images or documents (see `llm/content.ts`).
   * @param identity - Caller identity: tenant, user ID, and roles.
   * @param options  - Optional session, context, and event-listener overrides.
   *
   * @throws {@link ConfigError} if `agentId` is not registered.
   * @throws {@link ProviderError} if the LLM provider call fails.
   */
  async chat(
    agentId: string,
    message: MessageContent,
    identity: { tenantId: string; userId: string; roles: string[] },
    options?: ChatOptions,
  ): Promise<AgentResponse> {
    const { tenantId, userId, roles } = identity;

    // Resolve or create the session.
    let sessionId = options?.sessionId;
    if (!sessionId) {
      const session = await this.#sessions.create(tenantId, userId, agentId);
      sessionId = session.sessionId;
    }

    const context: ExecutionContext = {
      tenantId,
      userId,
      roles,
      sessionId,
      agentId,
      requestId: randomUUID(),
    };

    const runOptions: RunOptions = {
      ...(options?.externalContext !== undefined && {
        externalContext: options.externalContext,
      }),
      ...(options?.userContext !== undefined && {
        externalUserContext: options.userContext,
      }),
      ...(options?.onEvent !== undefined && { onEvent: options.onEvent }),
      ...(options?.stream !== undefined && { stream: options.stream }),
      ...(options?.signal !== undefined && { signal: options.signal }),
      ...(options?.responseFormat !== undefined && { responseFormat: options.responseFormat }),
      ...(options?.fileHandling !== undefined && { fileHandling: options.fileHandling }),
      ...(options?.providerOptions !== undefined && { providerOptions: options.providerOptions }),
    };

    return this.runAgent(agentId, message, context, runOptions);
  }

  /**
   * Executes a single governed LLM call outside the agent loop.
   *
   * Unlike calling `router.call()` directly — which bypasses ALL governance —
   * this method:
   * 1. Applies `tokens.limitMode` to daily/monthly tenant and user budgets.
   * 2. Emits `llm.call.start` / `llm.call.end` / `llm.call.error` and
   *    `tokens.recorded` on the EventBus, so the call is captured by the audit
   *    and logging planes with full tenant/user attribution.
   * 3. Records token usage (with cost estimation) in the {@link TokenTracker}.
   *
   * Streaming (`request.onToken`) and abort (`request.signal`) behave exactly
   * as with the underlying provider.
   *
   * @param request - The LLM request (`model` is required).
   * @param context - Execution context attributing the call to a tenant/user.
   * @param options - `provider` overrides `llm.defaultProvider`; `enforceLimits`
   *                  (default `true`) toggles the daily token-limit check.
   * @returns The provider's {@link LLMResponse}.
   *
   * @throws {@link ConfigError}    when no provider can be resolved.
   * @throws {@link TokenLimitError} when an enforced token budget would be exceeded.
   * @throws {@link ProviderError}  when the provider call fails.
   */
  async complete(
    request: LLMRequest,
    context: ExecutionContext,
    options?: { provider?: string; enforceLimits?: boolean },
  ): Promise<LLMResponse> {
    const provider =
      options?.provider ?? this.#config.llm.defaultProvider ?? this.#firstAvailableProvider();
    if (!provider) {
      throw new ConfigError(
        `No LLM provider configured. Set 'llm.defaultProvider' in the SDK config or pass 'options.provider'.`,
        'llm.defaultProvider',
      );
    }

    const emit = (type: string, data: Record<string, unknown>): void => {
      this.#bus.emit(type, {
        ...data,
        _context: {
          tenantId: context.tenantId,
          userId: context.userId,
          sessionId: context.sessionId,
          agentId: context.agentId,
          requestId: context.requestId,
        },
      });
    };

    if (options?.enforceLimits !== false) {
      const decision = await this.#tokens.checkLimits(
        context.tenantId,
        context.userId,
        estimateLLMRequestTokens(request),
      );
      if (decision.exceeded) {
        emit('tokens.limit.observed', {
          mode: decision.mode,
          estimatedTokens: decision.estimatedTokens,
          violation: decision.violation,
        });
      }
      if (!decision.allowed && decision.violation !== undefined) {
        throw new TokenLimitError(
          context.tenantId,
          decision.violation,
          decision.violation.scope === 'user' ? context.userId : undefined,
        );
      }
    }

    // Media descriptors only: counts, types and sizes, never the content.
    const media = ContentResolver.describe(
      request.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)),
    );
    emit('llm.call.start', {
      model: request.model,
      provider,
      reasoningEffort: request.reasoningEffort,
      ...(media.length > 0 && { media }),
    });

    let response: LLMResponse;
    try {
      response = await this.#router.call(request, provider);
    } catch (err) {
      emit('llm.call.error', {
        error: err instanceof Error ? err.message : String(err),
        provider,
      });
      throw err;
    }

    // Fill in the cost from the configured price list when the provider didn't
    // report one, so the caller and the stored records share a consistent cost.
    if (response.usage.cost === undefined) {
      response.usage.cost = this.#tokens.estimateCost(
        response.model,
        response.usage.inputTokens,
        response.usage.outputTokens,
      );
    }
    await this.#tokens.record(context, {
      ...response.usage,
      provider: response.provider,
      model: response.model,
    });

    emit('llm.call.end', {
      usage: response.usage,
      latencyMs: response.latencyMs,
      performance: response.performance,
      model: response.model,
      provider: response.provider,
      reasoningEffort: request.reasoningEffort,
    });
    if (this.#tokens.limitMode !== 'disabled') {
      emit('tokens.recorded', {
        tenantId: context.tenantId,
        userId: context.userId,
        tokens: response.usage.totalTokens,
      });
    }

    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Files and batch (optional provider capabilities)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns what a provider instance can do, optionally for one model.
   *
   * Use it to branch before building a request — to pick a provider that reads
   * PDFs, or to check that structured output can be combined with tools —
   * instead of discovering the limit as an error.
   *
   * @param providerName - Instance name, or the configured default provider.
   * @param model        - Model the capabilities are queried for.
   * @throws {@link ConfigError} when the provider is not registered.
   */
  capabilities(providerName?: string, model?: string): ProviderCapabilities {
    return this.#requireProvider(providerName).capabilities(model);
  }

  /**
   * Uploads a file to a provider's file store, under governance.
   *
   * Emits `llm.file.uploaded` (metadata only — never the content) so the upload
   * is visible to the logging and audit planes, and returns a reference usable
   * as a content source. References are provider-scoped and may expire.
   *
   * @param input        - File content plus its media type and optional name.
   * @param context      - Execution context attributing the upload to a tenant/user.
   * @param providerName - Instance name, or the configured default provider.
   * @throws {@link UnsupportedCapabilityError} when the provider has no file API.
   */
  async uploadFile(
    input: FileUploadInput,
    context: ExecutionContext,
    providerName?: string,
  ): Promise<ProviderFileRef> {
    const provider = this.#requireProvider(providerName);
    if (!supportsFiles(provider)) {
      throw new UnsupportedCapabilityError(provider.name, 'files', 'this provider has no file API');
    }

    const ref = await provider.uploadFile(input);
    this.#emitWithContext('llm.file.uploaded', context, {
      provider: ref.provider,
      providerType: ref.providerType,
      fileId: ref.fileId,
      mimeType: ref.mimeType,
      byteLength: ref.byteLength,
      expiresAt: ref.expiresAt,
    });
    return ref;
  }

  /**
   * Deletes a file from a provider's file store.
   *
   * @param fileId       - Reference id returned by {@link uploadFile}.
   * @param context      - Execution context attributing the deletion.
   * @param providerName - Instance name, or the configured default provider.
   */
  async deleteFile(
    fileId: string,
    context: ExecutionContext,
    providerName?: string,
  ): Promise<void> {
    const provider = this.#requireProvider(providerName);
    if (!supportsFiles(provider)) {
      throw new UnsupportedCapabilityError(provider.name, 'files', 'this provider has no file API');
    }
    await provider.deleteFile(fileId);
    this.#emitWithContext('llm.file.deleted', context, { provider: provider.name, fileId });
  }

  /**
   * Submits a set of requests for asynchronous batch processing.
   *
   * Batch is a **different lifecycle**, not a different request model: the unit
   * of work is the same {@link LLMRequest} a synchronous call uses, with the
   * same content, structured-output and provider-option abstractions. What
   * changes is that the answer arrives hours later, through
   * {@link streamBatchResults}, rather than from this call.
   *
   * Choosing batch over `complete()` is the application's decision: the SDK
   * never promotes a request to batch on its own, whatever the volume.
   *
   * The SDK starts no timers and does no background polling. Persist the
   * returned `jobId`; a restarted process can resume with nothing else.
   *
   * @param items        - Requests, each tagged with a stable `customId`.
   * @param context      - Execution context attributing the job to a tenant/user.
   * @param providerName - Instance name, or the configured default provider.
   * @param options      - Optional job name and default model.
   * @throws {@link UnsupportedCapabilityError} when the provider has no batch API.
   */
  async submitBatch(
    items: BatchRequestItem[],
    context: ExecutionContext,
    providerName?: string,
    options?: BatchSubmitOptions,
  ): Promise<BatchJob> {
    const provider = this.#requireBatchProvider(providerName);
    const job = await provider.submitBatch(items, options);

    this.#emitWithContext('llm.batch.submitted', context, {
      jobId: job.jobId,
      provider: job.provider,
      providerType: job.providerType,
      model: job.model,
      requests: items.length,
      executionMode: 'batch',
    });
    return job;
  }

  /**
   * Reads the current state of a batch job.
   *
   * Call it as often as the application sees fit: polling cadence belongs to
   * the caller, and the SDK holds no state between calls.
   *
   * @param jobId        - Identifier returned by {@link submitBatch}.
   * @param context      - Execution context attributing the query.
   * @param providerName - Instance name, or the configured default provider.
   */
  async getBatch(
    jobId: string,
    context: ExecutionContext,
    providerName?: string,
  ): Promise<BatchJob> {
    const provider = this.#requireBatchProvider(providerName);
    const job = await provider.getBatch(jobId);
    this.#emitWithContext('llm.batch.status', context, {
      jobId: job.jobId,
      provider: job.provider,
      status: job.status,
      counts: job.counts,
    });
    return job;
  }

  /**
   * Streams a finished job's results, recording usage as each one arrives.
   *
   * Iterating rather than returning an array keeps memory flat for jobs of tens
   * of thousands of documents. Token usage and cost cannot be known at submit
   * time, so they are recorded here, per item, in `batch` execution mode — the
   * provider's own batch rates apply, never an assumed discount.
   *
   * Items report success or failure individually: a job can end `completed`
   * with some documents failed, so only those need reprocessing.
   *
   * @param jobId        - Identifier returned by {@link submitBatch}.
   * @param context      - Execution context attributing the usage.
   * @param providerName - Instance name, or the configured default provider.
   */
  async *streamBatchResults(
    jobId: string,
    context: ExecutionContext,
    providerName?: string,
  ): AsyncIterable<BatchResultItem> {
    const provider = this.#requireBatchProvider(providerName);
    let succeeded = 0;
    let failed = 0;

    for await (const item of provider.streamBatchResults(jobId)) {
      if (item.response !== undefined) {
        succeeded++;
        const usage = item.response.usage;
        if (usage.cost === undefined) {
          usage.cost = this.#tokens.estimateCost(
            item.response.model,
            usage.inputTokens,
            usage.outputTokens,
          );
        }
        await this.#tokens.record(context, {
          ...usage,
          provider: item.response.provider,
          model: item.response.model,
        });
      } else {
        failed++;
      }
      yield item;
    }

    this.#emitWithContext('llm.batch.completed', context, {
      jobId,
      provider: provider.name,
      succeeded,
      failed,
      executionMode: 'batch',
    });
  }

  /**
   * Requests cancellation of a batch job that has not finished.
   *
   * @param jobId        - Identifier returned by {@link submitBatch}.
   * @param context      - Execution context attributing the cancellation.
   * @param providerName - Instance name, or the configured default provider.
   */
  async cancelBatch(
    jobId: string,
    context: ExecutionContext,
    providerName?: string,
  ): Promise<void> {
    const provider = this.#requireBatchProvider(providerName);
    await provider.cancelBatch(jobId);
    this.#emitWithContext('llm.batch.cancelled', context, { jobId, provider: provider.name });
  }

  /** Resolves a provider instance by name, or the configured default. */
  #requireProvider(providerName?: string): LLMProvider {
    const name = providerName ?? this.#config.llm.defaultProvider ?? this.#firstAvailableProvider();
    if (name === undefined) {
      throw new ConfigError(
        `No LLM provider configured. Set 'llm.defaultProvider' in the SDK config or ` +
          `pass a provider name.`,
        'llm.defaultProvider',
      );
    }
    const provider = this.#router.getProvider(name);
    if (provider === undefined) {
      throw new ConfigError(`Provider '${name}' is not registered`, 'llm.providers');
    }
    return provider;
  }

  /** Resolves a provider and asserts it supports batch processing. */
  #requireBatchProvider(providerName?: string): LLMProvider & BatchCapableProvider {
    const provider = this.#requireProvider(providerName);
    if (!supportsBatch(provider)) {
      throw new UnsupportedCapabilityError(
        provider.name,
        'batch',
        'this provider has no batch API',
      );
    }
    return provider;
  }

  /** Emits an event carrying the standard `_context` attribution block. */
  #emitWithContext(type: string, context: ExecutionContext, data: Record<string, unknown>): void {
    this.#bus.emit(type, {
      ...data,
      _context: {
        tenantId: context.tenantId,
        userId: context.userId,
        sessionId: context.sessionId,
        agentId: context.agentId,
        requestId: context.requestId,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Low-level API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Executes an agent loop with full control over the execution context and
   * run options. Useful when the caller manages sessions externally or needs
   * to inject specific context.
   *
   * @param agentId - ID of the registered agent to run.
   * @param message - The user's turn: plain text, or content blocks when it
   *                  carries images or documents (see `llm/content.ts`).
   * @param context - Full execution context (tenant, user, session, request ID).
   * @param options - Optional external context, user facts, and event listener.
   *
   * @throws {@link ConfigError} if `agentId` is not registered.
   */
  async runAgent(
    agentId: string,
    message: MessageContent,
    context: ExecutionContext,
    options?: RunOptions,
  ): Promise<AgentResponse> {
    const agent = this.#agents.get(agentId);
    if (agent === undefined) {
      throw new ConfigError(`Agent '${agentId}' is not registered`, 'agentId');
    }

    const resolvedLLM = this.#resolveLLMConfig(agent);
    const llmAdapter = new AgentLLMAdapter(this.#router, resolvedLLM);

    // Build a fully-resolved agent config so AgentLoop never needs to
    // handle optional fields or reach back into the SDK config.
    const resolvedAgent: AgentConfig = {
      ...agent,
      llmConfig: resolvedLLM,
      memoryStrategy: {
        type: agent.memoryStrategy?.type ?? this.#config.memory.session.strategy,
        maxMessages:
          agent.memoryStrategy?.maxMessages ??
          this.#config.memory.session.maxMessagesBeforeCompress,
        ...(agent.memoryStrategy?.summaryThreshold !== undefined && {
          summaryThreshold: agent.memoryStrategy.summaryThreshold,
        }),
      },
      maxLoopIterations: agent.maxLoopIterations ?? this.#config.agent.maxLoopIterations,
    };

    const planner =
      resolvedAgent.usePlanner === true
        ? new Planner(llmAdapter, resolvedLLM.model, resolvedLLM.temperature)
        : undefined;

    const loop = new AgentLoop(
      resolvedAgent,
      this.#toolRegistry,
      this.#skillRegistry,
      llmAdapter,
      this.#memory,
      this.#bus,
      this.#tokens,
      this.#securityChain,
      this.#aclService,
      this.#approvalService,
      planner,
    );

    return loop.run(message, context, options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolves the effective LLM configuration for an agent by merging the
   * agent's optional `llmConfig` over the SDK-level defaults.
   *
   * Resolution order for each field (first defined value wins):
   *
   * | Field         | 1st               | 2nd                            | 3rd                                        |
   * |---------------|-------------------|--------------------------------|--------------------------------------------|
   * | `provider`    | agent.llmConfig   | llm.defaultProvider            | first provider with a key in llm.providers |
   * | `model`       | agent.llmConfig   | llm.defaultModel               | llm.providers[provider].defaultModel       |
   * | `temperature` | agent.llmConfig   | agent.defaultTemperature       | —                                          |
   * | `maxTokens`   | agent.llmConfig   | agent.defaultMaxTokens         | —                                          |
   *
   * @throws {@link ConfigError} if no provider can be resolved.
   */
  #resolveLLMConfig(agent: AgentConfig): ResolvedLLMConfig {
    const llm = this.#config.llm;
    const agentDefaults = this.#config.agent;

    // ── Resolve provider ────────────────────────────────────────────────────
    const provider =
      agent.llmConfig?.provider ?? llm.defaultProvider ?? this.#firstAvailableProvider();

    if (!provider) {
      throw new ConfigError(
        `No LLM provider configured. Set 'llm.defaultProvider' in the SDK config or specify 'llmConfig.provider' on the agent.`,
        'llmConfig.provider',
      );
    }

    // ── Resolve model ───────────────────────────────────────────────────────
    // The instance's `defaultModel` is looked up by its configured name — no
    // per-type special-casing, so any adapter instance resolves uniformly.
    const providerDefaultModel = llm.providers[provider]?.defaultModel;

    const model =
      agent.llmConfig?.model ?? llm.defaultModel ?? providerDefaultModel ?? 'claude-opus-5';

    // ── Resolve temperature / maxTokens ─────────────────────────────────────
    const temperature = agent.llmConfig?.temperature ?? agentDefaults.defaultTemperature;
    const maxTokens = agent.llmConfig?.maxTokens ?? agentDefaults.defaultMaxTokens;

    // ── Resolve reasoning effort (per-instance default) ─────────────────────
    // Sent only when the resolved instance declares one; adapters/models that
    // don't support it recover via their parameter-relaxation mechanism.
    const reasoningEffort = llm.providers[provider]?.reasoningEffort;

    return {
      provider,
      model,
      temperature,
      maxTokens,
      ...(reasoningEffort !== undefined && { reasoningEffort }),
      ...(agent.llmConfig?.fallbackProvider !== undefined && {
        fallbackProvider: agent.llmConfig.fallbackProvider,
      }),
      ...(agent.llmConfig?.fallbackModel !== undefined && {
        fallbackModel: agent.llmConfig.fallbackModel,
      }),
    };
  }

  /**
   * Returns the name of the first provider in `SDKConfig.llm.providers`
   * that has a non-empty API key (or Ollama, which has no key requirement).
   */
  #firstAvailableProvider(): string | undefined {
    const providers = this.#config.llm.providers;
    // Preserve the historical priority (claude, then openai, then ollama) when
    // those instances exist, then fall back to the first configured instance
    // that is usable — a keyed cloud instance with an API key, or any endpoint
    // instance (openai-compatible / ollama, which needs no key).
    if (providers['claude']?.apiKey) return 'claude';
    if (providers['openai']?.apiKey) return 'openai';
    if (providers['ollama'] !== undefined) return 'ollama';
    for (const [name, entry] of Object.entries(providers)) {
      const type = resolveLLMProviderType(name, entry);
      const usable =
        type === 'openai-compatible' ||
        type === 'ollama' ||
        ((type === 'openai' || type === 'claude') &&
          entry.apiKey !== undefined &&
          entry.apiKey !== '');
      if (usable) return name;
    }
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers an agent configuration.
   *
   * If an agent with the same `id` already exists it is replaced.
   *
   * @param config - Agent configuration to register.
   */
  registerAgent(config: AgentConfig): void {
    this.#agents.set(config.id, config);
  }

  /**
   * Registers a tool in the tool registry.
   *
   * If a tool with the same `name` already exists it is replaced.
   *
   * @param tool - Tool to register.
   */
  registerTool(tool: Tool): void {
    this.#toolRegistry.register(tool);
  }

  /**
   * Registers a skill in the skill registry.
   *
   * If a skill with the same `name` already exists it is replaced.
   *
   * @param skill - Skill to register.
   */
  registerSkill(skill: Skill): void {
    this.#skillRegistry.register(skill);
  }

  /**
   * Declares a connection at runtime, or replaces one already declared.
   *
   * The `connections` config section covers data sources known when the
   * process starts. This covers the ones that are not: a source created by an
   * administrator while the system runs, one per tenant or per project.
   * Registering opens nothing — the connection still opens lazily on its first
   * real use — so this is safe to call on a request path.
   *
   * Replacing a name closes the resource the SDK had opened for it. Injected
   * connections belong to the host and are never touched.
   *
   * @param name   - Key the tools reference in their `connection` field.
   * @param config - The connection.
   * @throws {@link ConfigError} after {@link shutdown}.
   *
   * @example
   * ```typescript
   * await orch.registerConnection(`ds_${contentId}`, {
   *   type: 'sql', driver: 'postgres', host, database,
   *   credential: { ref: `ds:${contentId}` },
   *   readOnlyUser: true,
   *   relations: catalogue,
   * });
   * orch.registerTool(createSqlQueryTool({ name: 'ds.query', connection: `ds_${contentId}`,
   *                                        mode: 'freeform' }, orch.toolServices));
   * ```
   */
  async registerConnection(name: string, config: ConnectionConfig): Promise<void> {
    await this.connections.register(name, config);
  }

  /**
   * Removes a connection declared at runtime, closing it if the SDK opened it.
   *
   * @param name - Key used at registration.
   * @returns `true` if a declaration was removed, `false` if there was none.
   */
  async unregisterConnection(name: string): Promise<boolean> {
    return this.connections.unregister(name);
  }

  /**
   * Runs a registered tool directly, with no LLM in the loop.
   *
   * A host that already knows which tool to call and with what input has no
   * reason to pay for a model to decide it. Calling `tool.execute()` on the
   * object would work, but would skip everything the executor adds: AJV
   * validation of the input, the retry policy, the timeout, provenance
   * tracking, and the `tool.call.*` events the audit trail is built from.
   * Going through here means a host-initiated call is observed exactly like
   * one the agent made.
   *
   * @param name    - Registered tool name.
   * @param input   - Input, validated against the tool's `inputSchema`.
   * @param context - Execution context; `requestId` is what groups the call
   *                  with the rest of its turn for provenance.
   * @returns The tool result. Validation and execution failures come back as
   *          `success: false`, not as exceptions.
   * @throws {@link ToolNotFoundError} when no tool is registered under `name`.
   *
   * @example
   * ```typescript
   * const result = await orch.executeTool('ds.query',
   *   { sql: 'SELECT region, SUM(amount) FROM v_sales GROUP BY region' },
   *   context);
   * if (result.success) render(result.data.rows);
   * ```
   */
  async executeTool(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    if (this.#hostToolExecutor === undefined) {
      this.#hostToolExecutor = new ToolExecutor(this.#toolRegistry, this.#bus, {
        defaultTimeoutMs: this.#config.tools.defaultTimeoutMs,
        defaultRetryPolicy: {
          maxRetries: this.#config.tools.maxRetries,
          backoffMs: this.#config.tools.retryBackoffMs,
        },
        // One tracker for the Orchestrator, not one per call: provenance is
        // scoped by `requestId`, so several host-initiated calls in the same
        // turn correlate the way they should.
        untrustedTracker: new UntrustedTracker(this.#bus),
      });
    }
    return this.#hostToolExecutor.execute(name, input, context);
  }

  /**
   * Registers an LLM provider in the router.
   *
   * Useful for injecting custom providers (e.g. mock providers in tests or
   * provider implementations not auto-created from the config file).
   * If a provider with the same `name` is already registered it is replaced.
   *
   * @param provider - The LLM provider to register.
   */
  registerProvider(provider: LLMProvider): void {
    this.#router.registerProvider(provider);
  }

  /**
   * Registers the HITL approval service.
   *
   * When registered, the service is automatically wired into every `AgentLoop`
   * created by `runAgent()` / `chat()`. Tool calls that match a registered
   * trigger will suspend the run and create a `PendingAction`. Call
   * {@link approve} or {@link reject} to resolve them.
   *
   * @param service - The `ApprovalService` instance to use.
   */
  registerApprovalService(service: ApprovalService): void {
    this.#approvalService = service;
  }

  /**
   * Registers an ACL service. When registered, it is wired into every
   * `AgentLoop` created by `runAgent()` / `chat()` and the HITL resume path.
   * Tools that are not permitted by the ACL policy for the current execution
   * context will be filtered out before being offered to the LLM.
   *
   * @param service - The `ACLService` instance to use.
   */
  registerACLService(service: ACLService): void {
    this.#aclService = service;
  }

  /**
   * Registers a security middleware chain. When registered, it is wired into
   * every `AgentLoop` created by `runAgent()` / `chat()` and the HITL resume
   * path. The chain runs pre/post checks on agent start and each tool call.
   *
   * @param chain - The `SecurityMiddlewareChain` instance to use.
   */
  registerSecurityChain(chain: SecurityMiddlewareChain): void {
    this.#securityChain = chain;
  }

  /**
   * Phase 1 + Phase 2 of the two-phase HITL approve flow.
   *
   * ### Flow
   * 1. **Phase 1 — Tool execution** (via `ApprovalService.approve()`):
   *    Uses `store.claimForExecution()` as an atomic idempotency fence.
   *    Only the first concurrent caller proceeds; subsequent callers throw.
   *    On success, action status becomes `tool_completed` (checkpoint path)
   *    or `completed` (legacy path).
   * 2. **Phase 2 — AgentLoop resume** (checkpoint path only):
   *    Marks the action as `resuming`, injects the real tool result and
   *    `SKIPPED` placeholders for sibling calls, then runs a new `AgentLoop`
   *    with that context. The LLM continues naturally. On success the action
   *    becomes `completed`; on failure it becomes `resume_failed`, allowing
   *    retry via {@link retryResume} without re-executing the tool.
   *
   * @param actionId         - UUID of the `PendingAction` to approve.
   * @param approverIdentity - Tenant, user, and roles of the approver.
   * @param options          - Optional approval comment and modified tool input.
   * @returns The final `AgentResponse` from the resumed run, or a minimal
   *          response for legacy fire-and-approve actions.
   * @throws {@link ConfigError} if no `ApprovalService` is registered or the
   *         action is not found.
   * @throws `Error` if the action is already being processed (concurrent approve).
   */
  async approve(
    actionId: string,
    approverIdentity: { tenantId: string; userId: string; roles: string[] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { comment?: string; modifiedInput?: any },
  ): Promise<AgentResponse> {
    if (this.#approvalService === undefined) {
      throw new ConfigError(
        'No ApprovalService registered. Call registerApprovalService() first.',
        'approvalService',
      );
    }

    const action = await this.#approvalService.getById(actionId);
    if (action === null) {
      throw new ConfigError(`PendingAction not found: ${actionId}`, 'actionId');
    }

    const approverContext: ExecutionContext = {
      tenantId: approverIdentity.tenantId,
      userId: approverIdentity.userId,
      roles: approverIdentity.roles,
      sessionId: action.sessionId,
      agentId: action.agentId,
      requestId: randomUUID(),
    };

    // Phase 1 — execute the tool (atomic claim inside ApprovalService.approve).
    const resolution = await this.#approvalService.approve(actionId, approverContext, options);

    // Phase 2 — resume the agent loop (only when a checkpoint exists).
    if (
      action.savedContext.messagesSnapshot !== undefined &&
      action.savedContext.toolCallId !== undefined
    ) {
      return this.#resumeLoop(action, resolution.toolResult);
    }

    // Legacy fire-and-approve — no checkpoint, nothing to resume.
    return {
      content: formatApprovalMessage(
        resolution.toolResult?.success === true
          ? this.#approvalService.messages.approvedExecuted
          : this.#approvalService.messages.approvedFailed,
        { toolName: action.toolName },
      ),
      toolsUsed: [action.toolName],
      iterations: 1,
      hasPendingApprovals: false,
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, byIteration: [] },
      durationMs: 0,
    };
  }

  /**
   * Retries only Phase 2 (AgentLoop resume) for actions whose tool already
   * executed successfully but whose resume failed.
   *
   * **The tool is NOT re-executed.** This is safe to call multiple times until
   * the resume succeeds.
   *
   * Eligible statuses: `tool_completed`, `resume_failed`.
   *
   * When the approval service authorizes approvers (the default), the caller
   * must belong to the action's tenant: the resumed answer can contain data
   * from the tool result. Roles are not required, so operators can recover a
   * failed resume.
   *
   * @param actionId - UUID of the `PendingAction` to retry.
   * @param identity - Identity of the caller.
   * @throws {@link ConfigError} if no `ApprovalService` is registered, the
   *         action is not found, or its status is not retryable.
   * @throws {@link AccessDeniedError} if the caller belongs to another tenant.
   */
  async retryResume(
    actionId: string,
    identity: { tenantId: string; userId: string; roles: string[] },
  ): Promise<AgentResponse> {
    if (this.#approvalService === undefined) {
      throw new ConfigError(
        'No ApprovalService registered. Call registerApprovalService() first.',
        'approvalService',
      );
    }

    const action = await this.#approvalService.getById(actionId);
    if (action === null) {
      throw new ConfigError(`PendingAction not found: ${actionId}`, 'actionId');
    }

    if (this.#approvalService.authorizesApprovers && identity.tenantId !== action.tenantId) {
      this.#bus.emit('security.approval.denied', {
        actionId,
        toolName: action.toolName,
        decision: 'retry_resume',
        reason: 'caller belongs to a different tenant',
        _context: { tenantId: identity.tenantId, userId: identity.userId },
      });
      throw new AccessDeniedError('approval', actionId, identity.roles);
    }

    if (action.status !== 'tool_completed' && action.status !== 'resume_failed') {
      throw new ConfigError(
        `Action ${actionId} cannot be retried: status is '${action.status}'. ` +
          `Expected 'tool_completed' or 'resume_failed'.`,
        'actionId',
      );
    }

    if (
      action.savedContext.messagesSnapshot === undefined ||
      action.savedContext.toolCallId === undefined
    ) {
      throw new ConfigError(
        `Action ${actionId} has no resume checkpoint — cannot retry resume.`,
        'actionId',
      );
    }

    const toolResult = action.resolution?.toolResult;
    return this.#resumeLoop(action, toolResult);
  }

  /**
   * Phase 2 shared implementation: marks the action as `resuming`, builds the
   * resume message context, runs the `AgentLoop`, and marks `completed` or
   * `resume_failed`.
   *
   * The tool result must already be present in `action.resolution.toolResult`
   * (set by Phase 1) or passed directly (for the first resume attempt where
   * the resolution is returned inline).
   */
  async #resumeLoop(
    action: PendingAction,
    toolResult: ToolResult | undefined,
  ): Promise<AgentResponse> {
    await this.#approvalService!.markResuming(action.id);

    const resumeMessages = this.#buildResumeMessages(action, toolResult);

    const agent = this.#agents.get(action.agentId);
    if (agent === undefined) {
      const err = new ConfigError(`Agent '${action.agentId}' is not registered`, 'agentId');
      await this.#approvalService!.markResumeFailed(action.id, err);
      throw err;
    }

    const resolvedLLM = this.#resolveLLMConfig(agent);
    const llmAdapter = new AgentLLMAdapter(this.#router, resolvedLLM);
    const resolvedAgent: AgentConfig = {
      ...agent,
      llmConfig: resolvedLLM,
      memoryStrategy: {
        type: agent.memoryStrategy?.type ?? this.#config.memory.session.strategy,
        maxMessages:
          agent.memoryStrategy?.maxMessages ??
          this.#config.memory.session.maxMessagesBeforeCompress,
        ...(agent.memoryStrategy?.summaryThreshold !== undefined && {
          summaryThreshold: agent.memoryStrategy.summaryThreshold,
        }),
      },
      maxLoopIterations: agent.maxLoopIterations ?? this.#config.agent.maxLoopIterations,
    };

    const loop = new AgentLoop(
      resolvedAgent,
      this.#toolRegistry,
      this.#skillRegistry,
      llmAdapter,
      this.#memory,
      this.#bus,
      this.#tokens,
      this.#securityChain,
      this.#aclService,
      this.#approvalService,
      undefined, // No planner on resume — plan was already executed in the original run.
    );

    let resumeResponse: AgentResponse;
    try {
      resumeResponse = await loop.run('', action.savedContext.executionContext, {
        _resumeContext: resumeMessages,
      });
    } catch (err) {
      await this.#approvalService!.markResumeFailed(action.id, err);
      throw err;
    }

    await this.#approvalService!.markResumeCompleted(action.id);
    return resumeResponse;
  }

  /**
   * Builds the message array used to resume a suspended agent loop.
   *
   * Starts from the conversation snapshot, injects the real tool result for
   * the approved action, and adds SKIPPED placeholders for any sibling calls
   * so every call in the LLM assistant turn has a corresponding result.
   * SKIPPED is intentionally neutral — it does not instruct the LLM to
   * re-invoke the tool; the LLM reevaluates what to do based on the context.
   */
  #buildResumeMessages(action: PendingAction, toolResult: ToolResult | undefined): LLMMessage[] {
    const snapshot = action.savedContext.messagesSnapshot!;
    const toolCallId = action.savedContext.toolCallId!;
    const siblingCalls = action.savedContext.siblingCalls ?? [];

    const messages: LLMMessage[] = [...snapshot];

    messages.push({
      role: 'tool',
      toolCallId,
      name: action.toolName,
      content: JSON.stringify(toolResult?.data ?? { status: 'completed' }),
    });

    for (const sibling of siblingCalls) {
      messages.push({
        role: 'tool',
        toolCallId: sibling.id,
        name: sibling.toolName,
        content: JSON.stringify({
          status: 'SKIPPED',
          reason: (this.#approvalService?.messages ?? DEFAULT_APPROVAL_MESSAGES).skippedToolResult,
        }),
      });
    }

    return messages;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────────────────

  /** The global tool registry. Register or inspect tools at runtime. */
  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }

  /** The global skill registry. Register or inspect skills at runtime. */
  get skillRegistry(): SkillRegistry {
    return this.#skillRegistry;
  }

  /** The session manager. Create, inspect, and close user sessions. */
  get sessions(): SessionManager {
    return this.#sessions;
  }

  /**
   * The conversation memory manager. Load and persist per-session message
   * history directly — used by callers that orchestrate retrieval/synthesis
   * themselves (outside the agent loop) while preserving multi-turn context.
   */
  get memory(): DefaultMemoryManager {
    return this.#memory;
  }

  /** The event bus. Subscribe to agent lifecycle events. */
  get events(): EventBus {
    return this.#bus;
  }

  /** The token tracker. Query usage summaries and enforce limits. */
  get tokens(): TokenTracker {
    return this.#tokens;
  }

  /**
   * The audit logger, or `undefined` when `audit.enabled` is `false`.
   *
   * Use it to query records, build session timelines, compute stats, export,
   * and apply retention. Auto-capture is already running when present.
   */
  get audit(): AuditLogger | undefined {
    return this.#auditLogger;
  }

  /**
   * Unified façade over the three observability planes (events, audit, tokens).
   *
   * Provides cross-cutting reads such as
   * {@link Observability.getRequestReport}. Lazily built on first access.
   */
  get observability(): Observability {
    if (this.#observability === undefined) {
      this.#observability = new Observability({
        events: this.#bus,
        tokens: this.#tokens,
        ...(this.#auditLogger !== undefined && { audit: this.#auditLogger }),
      });
    }
    return this.#observability;
  }

  /**
   * Named connections declared in `connections`, plus any injected by the host.
   *
   * Built on first access and opened lazily thereafter: reading this property
   * contacts nothing. Use {@link ConnectionManager.registerDriver} to make a
   * database driver available before the first query runs.
   */
  get connections(): ConnectionManager {
    if (this.#connectionManager === undefined) {
      this.#connectionManager = new ConnectionManager({
        ...(this.#config.connections !== undefined && { connections: this.#config.connections }),
        credentials: this.#credentialProvider ?? new ConfigCredentialProvider(),
        ...(this.#injectedConnections !== undefined && { injected: this.#injectedConnections }),
        emit: (event, data): void => {
          this.#bus.emit(event, data);
        },
      });
    }
    return this.#connectionManager;
  }

  /**
   * Services the SDK hands to internal tool factories.
   *
   * Exposed so the programmatic form of a built-in tool is the *same* call the
   * declarative loader makes — one implementation, two entry points, no room
   * for them to drift.
   *
   * @example
   * ```typescript
   * orch.registerTool(createSqlQueryTool({ … }, orch.toolServices));
   * ```
   */
  get toolServices(): InternalToolContext {
    if (this.#toolServicesCache === undefined) {
      this.#toolServicesCache = {
        getRAGPipeline: (): RAGPipeline => this.rag.pipeline,
        ragRetrievalDefaults: this.#config.rag.retrieval,
        getConnection: (name): ConnectionHandle => this.connections.get(name),
        getCredential: (ref, context): Promise<Credential> => {
          const provider = this.#credentialProvider ?? new ConfigCredentialProvider();
          return provider.get(ref, context);
        },
        emit: (event, data): void => {
          this.#bus.emit(event, data);
        },
        ...(this.#documentStores !== undefined && { documentStores: this.#documentStores }),
        ...(this.#mailTransport !== undefined && { mailTransport: this.#mailTransport }),
      };
    }
    return this.#toolServicesCache;
  }

  /** The LLM router. Inspect circuit-breaker state or register providers. */
  get router(): LLMRouter {
    return this.#router;
  }

  /** A read-only snapshot of the resolved SDK configuration. */
  get config(): SDKConfig {
    return structuredClone(this.#config);
  }

  /**
   * Closes all storage adapters that were created by the Orchestrator's factory
   * (i.e. not injected via `overrides`).
   *
   * Call this when shutting down the process to release Redis connections,
   * MongoDB clients, and any other resources held by owned adapters.
   * Adapters injected programmatically are the caller's responsibility.
   *
   * `shutdown()` is idempotent — calling it more than once is safe.
   */
  async shutdown(): Promise<void> {
    // 0. Stop technical-log forwarding.
    this.#logCollector?.stop();
    // 1. Stop capturing new events and flush the audit write buffer.
    await this.#auditLogger?.stopAutoCapture();
    // 2. Close the owned audit store (e.g. the MongoClient). Injected stores
    //    (overrides.auditStore / overrides.auditLogger) are the caller's.
    await this.#ownedAuditStore?.close();
    // 3. Close storage adapters created by the factory (includes the token store).
    await Promise.all(this.#ownedAdapters.map((a) => a.close()));
    // 4. Disconnect MCP servers, reaping stdio child processes and HTTP
    //    sessions. `McpClient.close()` never throws, so one bad server cannot
    //    prevent the others from shutting down.
    await Promise.all([...this.#mcpClients.values()].map((c) => c.close()));
    // 5. Close integration-tool connections the SDK opened. Injected ones
    //    (overrides.connections) belong to the host and are left alone, the
    //    same rule applied to injected audit stores above.
    await this.#connectionManager?.close();
    // 6. Close the vector store built from config (e.g. a PostgreSQL pool).
    //    An injected store (overrides.vectorStore) belongs to the host.
    await this.#ownedVectorStore?.close();
  }

  /**
   * Returns the MCP client for a server declared in `mcp.servers`.
   *
   * Useful for inspecting a server's catalogue (`listTools()`) or calling a
   * tool directly, outside the agent loop. The Orchestrator owns the returned
   * client's lifecycle — do not close it yourself; use {@link shutdown}.
   *
   * @param name - Server name, as keyed in the `mcp.servers` config section.
   * @returns The client, or `undefined` if no such server was declared.
   */
  getMcpClient(name: string): McpClient | undefined {
    return this.#mcpClients.get(name);
  }

  /**
   * Names of every MCP server declared in the config, in declaration order.
   */
  listMcpServers(): string[] {
    return [...this.#mcpClients.keys()];
  }

  /**
   * Re-reads an MCP server's catalogue and re-syncs the `ToolRegistry`.
   *
   * Tools registered with `autoRegisterTools` are a **snapshot** taken at
   * startup. A server may gain, drop, or reshape tools while the process is
   * running, and MCP announces that with a `notifications/tools/list_changed`
   * message the SDK does not yet subscribe to. Until it does, this is the way
   * a long-running host picks up the change — call it on a timer, on an
   * operator action, or after redeploying the server.
   *
   * ### What it touches
   * Only servers whose tools were auto-registered, and within those, only the
   * names this Orchestrator registered itself. Tools claimed by a
   * `tools.definitions` entry are never overwritten or removed, so an explicit
   * declaration keeps winning over the server's own catalogue, exactly as it
   * does at startup.
   *
   * A server declared without `autoRegisterTools` has nothing to re-sync: its
   * tools are pinned by explicit definitions by construction.
   *
   * @param serverName - Server to refresh. Omit to refresh every
   *                     auto-registered server.
   * @returns What changed, per server.
   * @throws {@link ConfigError} if `serverName` is not a declared MCP server.
   */
  async refreshMcpTools(serverName?: string): Promise<McpRefreshResult[]> {
    if (serverName !== undefined && !this.#mcpClients.has(serverName)) {
      throw new ConfigError(
        `Unknown MCP server '${serverName}'. Declared servers: ` +
          `${this.listMcpServers().join(', ') || '(none)'}`,
        'mcp.servers',
      );
    }

    // Names spoken for by declarative config: off-limits to a refresh.
    const declared = new Set((this.#config.tools.definitions ?? []).map((def) => def.name));

    const targets =
      serverName !== undefined
        ? [serverName].filter((n) => this.#mcpAutoRegistered.has(n))
        : [...this.#mcpAutoRegistered.keys()];

    const results: McpRefreshResult[] = [];

    for (const name of targets) {
      const bridge = this.#mcpBridges.get(name);
      if (bridge === undefined) continue;

      const owned = this.#mcpAutoRegistered.get(name) ?? new Set<string>();
      const tools = await bridge.createTools();

      const incoming = new Set(tools.map((t) => t.name));
      const result: McpRefreshResult = {
        server: name,
        added: [],
        updated: [],
        removed: [],
        skipped: [],
      };

      // Drop tools the server no longer exposes.
      for (const toolName of owned) {
        if (!incoming.has(toolName) && !declared.has(toolName)) {
          this.#toolRegistry.unregister(toolName);
          result.removed.push(toolName);
        }
      }

      // Register the current catalogue, leaving declared names untouched.
      const nextOwned = new Set<string>();
      for (const tool of tools) {
        if (declared.has(tool.name)) {
          result.skipped.push(tool.name);
          continue;
        }
        (owned.has(tool.name) ? result.updated : result.added).push(tool.name);
        this.#toolRegistry.register(tool);
        nextOwned.add(tool.name);
      }

      this.#mcpAutoRegistered.set(name, nextOwned);
      this.#bus.emit('mcp.tools.refreshed', {
        server: name,
        added: result.added.length,
        updated: result.updated.length,
        removed: result.removed.length,
        skipped: result.skipped.length,
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Access the RAG subsystem: ingestion, collection management, and search.
   *
   * On first access, the facade is lazily initialised with an in-memory
   * vector store. Register embedding providers via `orch.rag.pipeline` or
   * by passing an `EmbeddingRouter` to the `IngestionPipeline` constructor.
   */
  get rag(): RAGFacade {
    if (!this.#ragFacade) {
      this.#ragFacade = this.#buildRAGFacade();
    }
    return this.#ragFacade;
  }

  /**
   * Registers an embedding provider in the RAG subsystem.
   *
   * @param provider - Embedding provider to register.
   */
  registerEmbeddingProvider(
    provider: import('../rag/embedding/EmbeddingProvider.js').EmbeddingProvider,
  ): void {
    // Ensure facade is initialised before registering
    void this.rag; // trigger lazy init
    this.#ragEmbeddingRouter?.registerProvider(provider);
  }

  /**
   * Registers a custom re-ranker for the RAG pipeline, taking precedence over
   * the `rag.reranker` configuration (last write wins). Pass `undefined` to
   * clear a previously-registered override.
   *
   * Works whether or not the RAG subsystem has been built yet: if it has, the
   * change applies to the live pipeline immediately; if not, the reranker is
   * remembered and used when the pipeline is first assembled.
   *
   * @param reranker - The re-ranker to use, or `undefined` to disable re-ranking.
   */
  registerReranker(reranker: RerankerProvider | undefined): void {
    this.#rerankerOverride = reranker;
    if (this.#ragFacade !== undefined) {
      this.#ragFacade.pipeline.setReranker(reranker);
    }
  }

  #ragEmbeddingRouter: EmbeddingRouter | undefined;

  #buildRAGFacade(): RAGFacade {
    const ragCfg = this.#config.rag;

    const vectorStore = this.#buildVectorStore(ragCfg);
    const embeddingRouter = this.#buildEmbeddingRouter(ragCfg.embedding);
    this.#ragEmbeddingRouter = embeddingRouter;
    // A programmatically-registered reranker takes precedence over config.
    const reranker = this.#rerankerOverride ?? this.#buildReranker(ragCfg.reranker);
    const queryRewriter = this.#buildQueryRewriter(ragCfg.queryRewriting);

    const ragPipeline = new RAGPipeline(
      embeddingRouter,
      vectorStore,
      reranker,
      this.#bus,
      this.#tokens,
      queryRewriter,
      ragCfg.retrieval.rerankPolicy,
    );

    const loaderRegistry = new DocumentLoaderRegistry();
    loaderRegistry.register(new PlainTextLoader());
    loaderRegistry.register(new MarkdownLoader());
    loaderRegistry.register(new HTMLLoader());
    loaderRegistry.register(new PDFLoader());
    loaderRegistry.register(new DOCXLoader());

    const ingestionPipeline = new IngestionPipeline(
      loaderRegistry,
      new RecursiveChunker(),
      embeddingRouter,
      vectorStore,
      this.#bus,
      this.#tokens,
      {
        defaultEmbeddingProvider: ragCfg.embedding.defaultProvider,
        defaultCollectionConfig: {
          embeddingProvider: ragCfg.embedding.defaultProvider,
          embeddingModel: `${ragCfg.embedding.defaultProvider}/${ragCfg.embedding.defaultModel}`,
          dimensions: ragCfg.embedding.defaultDimensions,
          distanceMetric: 'cosine',
        },
      },
    );

    const collectionManager = new CollectionManager(vectorStore);

    // Auto-register the rag.search tool with retrieval defaults from config,
    // unless one is already present (declared in config or registered in code).
    if (!this.#toolRegistry.has('rag.search')) {
      const ragTool = createRAGTool(ragPipeline, ['default'], ragCfg.retrieval);
      this.#toolRegistry.register(ragTool);
    }

    return new RAGFacade(ragPipeline, ingestionPipeline, collectionManager, {
      embeddingProvider: ragCfg.embedding.defaultProvider,
      embeddingModel: `${ragCfg.embedding.defaultProvider}/${ragCfg.embedding.defaultModel}`,
      dimensions: ragCfg.embedding.defaultDimensions,
    });
  }

  #buildVectorStore(ragCfg: SDKConfig['rag']): VectorStoreAdapter {
    if (this.#injectedVectorStore !== undefined) return this.#injectedVectorStore;
    const store = this.#createVectorStore(ragCfg.vectorStore);
    this.#ownedVectorStore = store;
    return store;
  }

  #createVectorStore(vs: SDKConfig['rag']['vectorStore']): VectorStoreAdapter {
    // `${ENV_VAR}` placeholders resolve to '' when unset: treat as absent.
    const secret = (value: string | undefined): string | undefined =>
      value !== undefined && value !== '' ? value : undefined;
    switch (vs.adapter) {
      case 'meilisearch': {
        const meili = vs.meilisearch!;
        return new MeilisearchAdapter({
          url: meili.url,
          ...(meili.apiKey !== undefined && meili.apiKey !== '' && { apiKey: meili.apiKey }),
          requestTimeout: meili.requestTimeout,
        });
      }
      case 'pgvector': {
        const { password, connectionString, ...rest } = vs.pgvector!;
        const pw = secret(password);
        const conn = secret(connectionString);
        return createVectorStoreAdapter({
          adapter: 'pgvector',
          config: {
            ...rest,
            ...(pw !== undefined && { password: pw }),
            ...(conn !== undefined && { connectionString: conn }),
          },
        });
      }
      case 'qdrant': {
        const { apiKey, ...rest } = vs.qdrant ?? {};
        const key = secret(apiKey);
        return createVectorStoreAdapter({
          adapter: 'qdrant',
          config: { ...rest, ...(key !== undefined && { apiKey: key }) },
        });
      }
      case 'pinecone': {
        const { apiKey, ...rest } = vs.pinecone!;
        const key = secret(apiKey);
        return createVectorStoreAdapter({
          adapter: 'pinecone',
          config: { ...rest, ...(key !== undefined && { apiKey: key }) },
        });
      }
      case 'weaviate': {
        const { apiKey, ...rest } = vs.weaviate ?? {};
        const key = secret(apiKey);
        return createVectorStoreAdapter({
          adapter: 'weaviate',
          config: { ...rest, ...(key !== undefined && { apiKey: key }) },
        });
      }
      case 'milvus': {
        const { token, ...rest } = vs.milvus ?? {};
        const tok = secret(token);
        return createVectorStoreAdapter({
          adapter: 'milvus',
          config: { ...rest, ...(tok !== undefined && { token: tok }) },
        });
      }
      case 'in-memory':
      default:
        return new InMemoryVectorStore();
    }
  }

  #buildEmbeddingRouter(embCfg: SDKConfig['rag']['embedding']): EmbeddingRouter {
    const router = new EmbeddingRouter();

    if (embCfg.providers.openai !== undefined && embCfg.providers.openai.apiKey !== '') {
      router.registerProvider(
        new OpenAIEmbeddingProvider({ apiKey: embCfg.providers.openai.apiKey }),
      );
    }
    if (embCfg.providers.cohere !== undefined && embCfg.providers.cohere.apiKey !== '') {
      router.registerProvider(
        new CohereEmbeddingProvider({ apiKey: embCfg.providers.cohere.apiKey }),
      );
    }
    if (embCfg.providers.ollama !== undefined && embCfg.providers.ollama.baseUrl !== '') {
      router.registerProvider(
        new OllamaEmbeddingProvider({
          baseURL: embCfg.providers.ollama.baseUrl,
          model: embCfg.defaultModel,
        }),
      );
    }

    return router;
  }

  #buildReranker(
    rerankerCfg: SDKConfig['rag']['reranker'] | undefined,
  ): RerankerProvider | undefined {
    if (rerankerCfg === undefined) return undefined;

    if (rerankerCfg.provider === 'cohere') {
      return new CohereReranker({
        apiKey: rerankerCfg.apiKey!,
        ...(rerankerCfg.model !== undefined && { model: rerankerCfg.model }),
      });
    }

    if (rerankerCfg.provider === 'llm') {
      const model = rerankerCfg.model ?? this.#config.llm.defaultModel ?? 'claude-haiku-4-5';
      const provider = rerankerCfg.llmProvider ?? this.#config.llm.defaultProvider ?? 'claude';
      return new LLMReranker({
        llmRouter: this.#router,
        provider,
        model,
        ...(rerankerCfg.batchSize !== undefined && { batchSize: rerankerCfg.batchSize }),
        ...(rerankerCfg.maxTokens !== undefined && { maxTokens: rerankerCfg.maxTokens }),
        ...(rerankerCfg.reasoningEffort !== undefined && {
          reasoningEffort: rerankerCfg.reasoningEffort,
        }),
        eventBus: this.#bus,
        // An unparseable response is a re-ranker failure like any other, so it
        // follows the same policy as a failed request.
        onParseFailure: this.#config.rag.retrieval.rerankPolicy === 'degrade' ? 'degrade' : 'throw',
      });
    }

    if (rerankerCfg.provider === 'tei') {
      return new TEIReranker({
        baseUrl: rerankerCfg.baseUrl!,
        ...(rerankerCfg.modelLabel !== undefined && { modelLabel: rerankerCfg.modelLabel }),
        ...(rerankerCfg.apiKey !== undefined && { apiKey: rerankerCfg.apiKey }),
        ...(rerankerCfg.headers !== undefined && { headers: rerankerCfg.headers }),
        ...(rerankerCfg.rawScores !== undefined && { rawScores: rerankerCfg.rawScores }),
        ...(rerankerCfg.timeoutMs !== undefined && { timeoutMs: rerankerCfg.timeoutMs }),
        ...(rerankerCfg.maxBatchSize !== undefined && { maxBatchSize: rerankerCfg.maxBatchSize }),
        ...(rerankerCfg.concurrency !== undefined && { concurrency: rerankerCfg.concurrency }),
        eventBus: this.#bus,
      });
    }

    return undefined;
  }

  #buildQueryRewriter(
    qrCfg: SDKConfig['rag']['queryRewriting'] | undefined,
  ): QueryRewriter | undefined {
    if (qrCfg === undefined || qrCfg.strategy === false) return undefined;

    const model = qrCfg.model ?? this.#config.llm.defaultModel ?? 'claude-haiku-4-5';
    const provider = qrCfg.llmProvider ?? this.#config.llm.defaultProvider ?? 'claude';

    if (qrCfg.strategy === 'contextual') {
      return new ContextualRewriter(this.#router, provider, model);
    }

    if (qrCfg.strategy === 'hyde') {
      return new HyDERewriter(this.#router, provider, model);
    }

    return undefined;
  }
}
