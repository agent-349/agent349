# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/). In the `0.x`
series, incompatible behavior changes bump the minor version.

## [Unreleased]

## [0.4.0] - Unreleased

First public release under the name **Agent349**.

### Changed — BREAKING

- **Package renamed** from `agent-sdk` to `agent349`. Update imports
  (`from 'agent-sdk'` → `from 'agent349'`) and your dependency. The
  configuration file conventionally named `agent-sdk.config.json` is now
  `agent349.config.json` in the documentation. The loader accepts any path,
  so no file rename is required.
- **SIEM output identifies the vendor as `Agent349`.** CEF lines now start
  with `CEF:0|Agent349|AgentOrchestrator|…` and LEEF lines with
  `LEEF:2.0|Agent349|AgentOrchestrator|…` (previously `AgentGuard`). Update
  SIEM parsing rules that match on the vendor field.
- The MCP client identifies itself to servers as `agent349`.
- The SQL tools' row-limit wrapper uses the alias `agent349_q` (previously
  `agentsdk_q`).
- Gemini batch uploads and temporary directories use the `agent349-` prefix.
- **Approvers are authorized.** `ApprovalService.approve()` and `reject()` (and
  therefore `Orchestrator.approve()`) now require the approver to belong to the
  action's tenant and to hold one of its `approverRoles` (or be listed in
  `approverUsers`; `'*'` admits any role). Otherwise they throw
  `AccessDeniedError`, leave the action pending, and emit
  `security.approval.denied`, audited as `security/approval_denied`.
  `Orchestrator.retryResume()` requires the same tenant. Previously any caller
  holding an action ID could decide it. **Migration:** pass the approver's real
  roles, or set `authorizeApprovers: false` in `ApprovalConfig` if your
  application authorizes approvers itself.
- **Token quotas observe by default.** The default `tokens.limitMode` is now
  `observe` (usage recorded, over-quota calls reported through
  `tokens.limit.observed`) instead of `enforce`, so a new deployment is never
  blocked by sample limits it did not choose. **Migration:** set
  `"limitMode": "enforce"` explicitly, together with your own limits, to keep
  blocking.
- **Current default models.** The built-in provider instances now default to
  `claude-opus-5` (was the deprecated `claude-sonnet-4-20250514`),
  `gpt-6-sol` (was `gpt-4o`) and `gemini-3.8-flash` (was `gemini-flash-latest`,
  a moving alias that may point to experimental releases). The fallback model
  for the LLM reranker and query rewriting is `claude-haiku-4-5`.
  **Migration:** set `defaultModel` on each provider to keep a specific model.
- **Approval-flow texts are in English and configurable.** The reply returned
  for a suspended run, the notes the model sees for pending and skipped calls,
  the plan-approval reply and the legacy approve reply were hard-coded in
  Spanish. They now default to English (`DEFAULT_APPROVAL_MESSAGES`) and can be
  overridden, for example to localize them, with `ApprovalConfig.messages`.

### Added

- **Five vector store adapters**: `PgVectorAdapter` (PostgreSQL + pgvector,
  full-text keyword search), `QdrantAdapter` (BM25 sparse vectors with IDF),
  `WeaviateAdapter` (native BM25 and hybrid), `MilvusAdapter` (Milvus 2.5+
  native BM25 function) and `PineconeAdapter` (vector search only; one
  namespace per collection). Selected with `rag.vectorStore.adapter`
  (`pgvector`, `qdrant`, `weaviate`, `milvus`, `pinecone`) and configured in a
  section of the same name. Only pgvector needs a client package (`pg`); the
  others use the engines' REST APIs. All of them, Meilisearch and the
  in-memory store pass one shared contract suite, run against the real engines
  with `npm run test:vectorstores`.
- `OrchestratorOverrides.vectorStore` injects any `VectorStoreAdapter`,
  including your own. `VectorStoreAdapter.close()` (optional, no-op by default)
  lets adapters release connections; `Orchestrator.shutdown()` closes stores it
  built from configuration.
- `ApprovalConfig.authorizeApprovers`, `ApprovalConfig.messages`,
  `ApprovalService.messages`, `ApprovalService.authorizesApprovers`,
  `DEFAULT_APPROVAL_MESSAGES`, `formatApprovalMessage()` and the
  `ApprovalMessages` type.
- `MongoPendingActionStore` and `MongoPendingActionStoreConfig` are exported
  from the package root. Previously they were only reachable through an
  internal path, which the package `exports` map does not allow.
- **Integration tools core**: named `connections` (`sql`, `mongo`, `http`,
  `mail`) opened lazily and closed on `shutdown()` only if the SDK opened them;
  `CredentialProvider` and a `credentials` section (static credentials via
  `${ENV_VAR}`; inject your own provider for OAuth, rotation or per-user
  credentials); value bindings (`literal` | `model` | `context`) so the model's
  input schema is generated only from model-owned parameters; cascading
  resource limits with the connection as ceiling and an explicit truncation
  envelope; content provenance (`ToolResult.untrusted`,
  `ToolDescriptor.sideEffects`, `security.untrusted.*` events).
- **SQL tools** `sql.query` (declared and free-form modes) and `sql.schema`,
  with drivers for PostgreSQL (`pg`), MySQL/MariaDB (`mysql2`), SQL Server
  (`mssql`) and Oracle (`oracledb`), all optional dependencies loaded on
  demand. Statements run in read-only transactions (on SQL Server, a
  transaction that is always rolled back) with a statement timeout. Free-form
  SQL is additionally checked by syntactic guards and a relation allowlist.
- **MongoDB tools** `mongo.query` and `mongo.schema`, rejecting server-side
  JavaScript (`$where`, `$function`, `$accumulator`), writes (`$out`,
  `$merge`) and `$lookup` outside the allowlist.
- **`http.request`**: one tool per declared operation. The model never chooses
  host, path or method. Path traversal and absolute URLs in parameters are
  rejected, redirects are off by default and re-validated when enabled.
  `blockPrivateAddresses` applies private-address checks to a connection.
- **`web.read`** with SSRF protection (scheme and domain allowlists, validation
  of every resolved IP, connection pinning against DNS rebinding, per-hop
  re-validation, streaming size cut-off), CSS `selector`, `format: "raw"`, and
  conditional requests (`ETag` / `Last-Modified`).
- **`feed.read`**: RSS 2.0, Atom 1.0 and RSS 1.0 (RDF) as normalized entries,
  with the same SSRF protection. Documents declaring entities are rejected.
- **`doc.read`** (PDF, Word, HTML, text) from a path-jailed directory or an
  injected `DocumentStore`, and **`file.read`** (stateless incremental reads of
  text files with rotation detection).
- **`mail.send`** with a mandatory recipient-domain allowlist, recipient cap,
  fixed sender and an injected `MailTransport`.
- Runtime connections: `Orchestrator.registerConnection()` /
  `unregisterConnection()`, idempotent for identical declarations.
- `Orchestrator.executeTool(name, input, context)` runs a registered tool
  through the `ToolExecutor` (validation, retries, timeout, provenance and
  audit events) without the model.
- New errors: `ConnectionError`, `CredentialError`, `QueryRejectedError`,
  `EgressDeniedError`, `ResourceLimitError`.
- English documentation (`docs/`) whose code samples are type-checked in CI
  (`npm run docs:check`), an offline runnable quickstart, and open-source
  project files (license, contributing guide, security policy, CI).

### Fixed

- **Built-in pricing covers current models.** Claude Fable 5.1, Opus 5,
  Sonnet 5 and Haiku 4.5, OpenAI GPT-6 Astra, Sol and Luna, and Gemini 3.8
  Flash are priced at their published September 2026 rates, so their calls no
  longer report a cost of `0`. Corrected Claude Haiku 4.5 ($1 / $5 per 1M
  tokens), Gemini 3.6 Flash and Gemini 3.5 Flash-Lite. Previous models keep
  their entries. Gemini 3.8 and 3.6 Flash rates double on 2027-01-01: override
  them through `pricing` from then on.
- `InMemoryVectorStore` now shows chunks carrying the wildcard role `'*'` to
  every role, as Meilisearch always did, so development and production stores
  scope results the same way.
- HTML extraction (`web.read`, `doc.read`) no longer glues adjacent block
  elements together (`<p>a</p><p>b</p>` → `ab`).
- A connection that fails to open now includes the underlying cause in its
  message, including which client package to install.

## [0.3.0]

### Added

- **Multimodal input.** Messages accept content blocks (images, documents/PDF,
  audio and video) as well as plain text. `chat()`, `runAgent()` and
  `AgentLoop.run()` take `string | ContentBlock[]`. Helpers: `text()`,
  `imageFromPath()`, `documentFromBytes()`, `documentFromUrl()`,
  `fromProviderFile()`, and more.
- **Gemini provider** (`type: 'gemini'`, `@google/genai`), using Interactions
  for regular calls, `generateContent` for batch and the Files API for files.
  `store: false` always: conversation memory and governance stay in the SDK.
- **Structured output** (`LLMRequest.responseFormat`) with each provider's
  native mechanism. `LLMResponse.structured` keeps three facts separate: what
  the provider enforced, whether the SDK could parse, and whether it validated.
- **Files API**: `Orchestrator.uploadFile()` / `deleteFile()`, `providerFile`
  content sources, and `fileHandling: 'inline' | 'upload' | 'auto'`.
- **Batch processing**: `submitBatch()`, `getBatch()`, `streamBatchResults()`
  and `cancelBatch()` on Gemini, Claude and OpenAI, with progressive results,
  stable `customId` correlation, and per-item success or error. Polling only:
  the SDK creates no timers.
- **Declared capabilities** per provider (`capabilities()`), available through
  `Orchestrator.capabilities()`. The router never falls back to a provider that
  cannot serve the request.
- **Provider-specific options** at three levels: portable fields on
  `LLMRequest`, typed `providerOptions` per adapter, and a `raw` escape hatch.
- Configuration: `llm.providers.<n>.type: 'gemini'`,
  `llm.providers.<n>.capabilities` for `openai-compatible` endpoints,
  per-model batch pricing (`pricing.<model>.batchInput` / `batchOutput`), and
  `memory.session.mediaPersistence: 'omit' | 'full'`.

### Changed — BREAKING

See [docs/es/MIGRATION_0.3.md](docs/es/MIGRATION_0.3.md) for the migration
guide (Spanish).

- **`ContentBlock` is a discriminated union.** Each variant declares exactly
  the fields it needs. `ToolResultBlock` keeps its payload in `content`, not
  `input`.
- **`LLMProvider.capabilities()` and `providerType` are abstract.** Add both to
  custom providers. `textOnlyCapabilities()` is the conservative baseline.
- **Non-text content is no longer silently dropped.** Providers used to send an
  empty message for block content. They now translate it or throw
  `UnsupportedCapabilityError`.
- **Token preflight no longer measures attachments by their base64 size.** It
  estimates by modality. Review quotas calibrated with the old behavior.
- **Binary content is no longer persisted in sessions by default**
  (`mediaPersistence: 'omit'`). It is replaced by an explicit `media_omitted`
  block and a `memory.media.omitted` event. Provider file references are kept.

### Fixed

- `ClaudeProvider` preserves unknown response blocks as opaque provider data
  instead of turning them into empty text.
- Thinking tokens are counted as output (as providers bill them) and reported
  in `performance.reasoningTokens`.

## [0.2.0]

### Changed — BREAKING

- **The reranker no longer degrades silently.** When `rerank: true` is
  requested and the configured reranker fails, `RAGPipeline.search()` throws
  `RerankerError` (`code: 'RERANKER_UNAVAILABLE'`) instead of returning results
  ordered by retrieval score. Retrieval scores are min-max normalized per
  collection, so without the reranker `minScore` cannot discriminate and any
  query returns confident-looking neighbors. **Migration:** set
  `rag.retrieval.rerankPolicy: 'degrade'` (or per query) to keep the old
  behavior.
- **`LLMReranker` no longer invents scores for unparseable responses.** It
  throws `RerankerError` with `stage: 'parse'`. **Migration:**
  `onParseFailure: 'degrade'` or `rerankPolicy: 'degrade'`.
- **`validate()` returns `ProviderProbe` (`{ ok, error? }`) instead of
  `boolean`** on `RerankerProvider`, `LLMProvider` and `EmbeddingProvider`, so a
  failed probe says why. Implementations still never throw. **Migration:**
  `if (await p.validate())` → `if ((await p.validate()).ok)`.

### Changed

- **Rerankers score the passage title together with its content.** A query that
  names a document by its type now matches when the type lives in the file name
  rather than the body. Returned passages keep their original `content`. Custom
  rerankers get the same behavior through the `scoringText()` helper.

### Added

- `rag.retrieval.rerankPolicy` (`'require'` | `'degrade'`, default `'require'`)
  with per-query override `RAGQuery.rerankPolicy`.
- `RerankerError` and `RerankerFailureStage` (`'request'` | `'parse'`).
- `orch.rag.validateReranker()`: startup check that reports whether a reranker
  is configured and reachable, without throwing. Emits
  `rag.reranker.available` / `rag.reranker.unavailable`.
- `RerankerValidation` and `ProviderProbe` types.
- `rag.rerank.error` includes the applied `policy`; `rag.rerank.parse_error`
  includes `onParseFailure`.

### Operational notes

- `minScore` only discriminates when a reranker is active.
- With local cross-encoders (TEI), latency grows linearly with `topK` and chunk
  size. Without a GPU it can exceed one second per candidate.

[Unreleased]: https://github.com/agent-349/agent349/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/agent-349/agent349/releases/tag/v0.4.0
