# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/). In the `0.x`
series, incompatible behavior changes bump the minor version.

## [Unreleased]

## [0.6.0] - 2026-11-22

### Fixed

- **Re-ingesting a document with unchanged text left it with no chunks.**
  With the defaults (`deduplication` and `overwriteExisting` both on),
  `ingest()` skipped every chunk whose hash it had already seen for the
  document in this process, and then deleted all the document's previous
  chunks before upserting: the document stayed registered but disappeared
  from search. Deduplication now applies only when previous chunks are kept
  (`overwriteExisting: false`), as `reingest()` already did.
- **Meilisearch did not store `metadata.custom`.** Host fields and chunk
  structure written at ingestion were dropped on upsert (only `contentHash`
  was kept), so they never came back on search. The adapter now stores
  `custom` as JSON text, as the Weaviate and Pinecone adapters do, and
  `updateDocumentsMetadata` can patch it. Documents indexed before keep no
  `custom` until they are re-ingested.

### Security

- **SSRF: IPv6 literals carrying a private IPv4 address were treated as
  public.** `isPrivateAddress` matched the IPv4-mapped form only when written
  with dots, but `new URL()` normalises `[::ffff:169.254.169.254]` to
  `::ffff:a9fe:a9fe`, so `http://[::ffff:169.254.169.254]/` reached the cloud
  metadata endpoint and `http://[::ffff:127.0.0.1]/` loopback, with
  `blockPrivateAddresses` on. IPv6 addresses are now judged on their 16 bytes:
  IPv4-mapped and -compatible, 6to4 and NAT64 (`64:ff9b::/96`) addresses are
  judged as the IPv4 address they carry, Teredo (`2001::/32`) and site-local
  (`fec0::/10`) are refused, and malformed literals are refused.
- **Credentials are no longer forwarded on cross-origin redirects.** With
  `followRedirects`, every hop carried the original headers, so a redirect to
  another host (or to plain `http`) received the connection's `authorization`
  header or API key. A hop to another origin now drops `authorization`,
  `proxy-authorization`, `cookie` and the header of an `apiKey` credential
  (new `sensitiveHeaders` option of `guardedRequest`).
- **CEF/LEEF lines can no longer be forged through record values.** CEF header
  fields (the action) now escape `\` and `|`, extension values escape `=` and
  write CR/LF as `\r`/`\n` (the outcome is escaped too); LEEF replaces `|` in
  the header with `_` and tabs or line breaks in values with spaces. Before, a
  user id with a tab or an action with `|` or a newline could add fields or a
  whole forged record in the SIEM. The output matches the Java SDK.

- **The free-form SQL relation allowlist could be bypassed.** `guardFreeformSql`
  found relations with one regular expression (`FROM|JOIN <name>`), so these
  read a relation outside `allowedRelations` and passed: the second and later
  items of a comma join (`FROM products, salaries`), MySQL backtick and SQL
  Server bracket identifiers, `TABLE salaries`, `STRAIGHT_JOIN` and `APPLY`, and
  text that one engine reads as a string but another as code (MySQL `\'`
  escapes, PostgreSQL `E'…'` strings, MySQL `--x` and non-nested comments). The
  statement now runs through an engine-aware tokenizer (`sqlLexer.ts`): every
  check applies to the statement as PostgreSQL, MySQL (with and without
  `ANSI_QUOTES`), SQL Server and Oracle would tokenize it, and relations come
  from every FROM-list item, JOIN/STRAIGHT_JOIN/APPLY and TABLE at every nesting
  level. Writes were never affected (read-only transaction and forbidden
  keywords), and a database user limited to the exposed relations already
  bounded what could be read. `GuardResult.relations`, which hosts use for their
  own allowlists, now lists every relation.
- What cannot be checked with certainty is rejected with new controls:
  `unparseable` (a literal unterminated under every engine's rules, a table
  position holding something other than a name or a subquery, unbalanced
  parentheses) and `unsupported-syntax` (MySQL executable comments `/*! … */`,
  Oracle `q'…'` quoting).
- A CTE declared inside a subquery no longer exempts a same-named relation
  outside it; only the leading `WITH` clause does. Forbidden keywords are
  matched as bare words, so a quoted name (`"delete"`) or a qualified column
  (`t.delete`) is no longer rejected. `IS [NOT] DISTINCT FROM`, `EXTRACT(… FROM
…)`, `SUBSTRING(… FROM …)`, `TRIM(… FROM …)` and `FROM DUAL` are not taken
  as relations.
- **`guardPipeline` walks nested pipelines and every cross-collection stage.**
  It used to check only a top-level `$lookup`. It now also refuses, against
  the allowlist, `$graphLookup`, `$unionWith` (string or `{ coll, pipeline }`)
  and the sub-pipelines inside `$facet`, `$lookup.pipeline` and
  `$unionWith.pipeline` — each was a way to read a collection the query was
  never allowed to name. A `$lookup` whose `from` is `{ db, coll }` (another
  database) is refused even without an allowlist.
- **Server stages are refused** (`server-stage` control): `$currentOp`,
  `$listSessions`, `$listLocalSessions`, `$collStats`, `$indexStats`,
  `$planCacheStats`, `$listSearchIndexes`, `$listSampledQueries`,
  `$shardedDataDistribution`, `$querySettings`, `$changeStream`,
  `$changeStreamSplitLargeEvent`. They describe the deployment, not the
  exposed collections.

### Added

- **Cross-document references.** `rag.references` (`mode: 'off' | 'follow'`,
  `maxTargets`, `perTarget`): the passages that reach the context are
  scanned for references to other documents (`ReferenceExtractor`,
  normalised to keys like `annex:14` or `decree:120/2015`); the
  host resolves keys to documentIds (`RAGQuery.resolveReferences`,
  `createRAGTool(..., { references })`); each cited document is searched with
  the same question and query vector (security filters only) and what passes
  the re-ranker and `minScore` joins the result. `trace.references` lists the
  references followed and the cited documents missing from the collection;
  `metrics.referencesLatencyMs`; audited as `rag.references.end`.
  `ReferenceExtractor.identify(title)` gives a document's identity keys
  (`rag.legal.numberedTitles` adds the "30 - ANEXO - …" title heuristic, off
  by default). Without a host resolver, references resolve through the chunk tags
  written at ingestion (`ref:<key>`; `rag.references.tagDocuments`, default on
  when references or relations are on).

- **Relations between documents.** `RelationExtractor` finds what a document
  does to others from its operative wording — repeals (`derogates`, total or
  partial, with articles), amendments (`modifies`) and regulations
  (`regulates`) — as proposals marked
  `explicit` or `inferred`. `rag.relations` (`mode: 'off' | 'on'`,
  `maxSources`, `perSource`): when a document in the context is repealed,
  amended or regulated by another, that one is searched with the same question
  and joins the result if it passes the re-ranker and `minScore`. Relations
  come from the host (`RAGQuery.describeDocuments`, with `proposed` /
  `confirmed` status) or from `rel:<type>:<key>` tags written at ingestion.

- **Document validity, version and priority.** `rag.validity` (`mode`,
  `inactive: 'flag' | 'exclude'`, `priorityWeight`): expired documents and
  confirmed total repeals are flagged (or excluded, which never applies to
  proposed relations), `high`/`low` priority shifts the ranking before the
  final cut. From `RAGQuery.describeDocuments` (read at query time: editing it
  needs no re-indexing) or `metadata.custom.validFrom|validTo|version|priority`.
  Passages carry `notes` (`PassageNote`), `formatForContext` writes them as a
  `Status:` line (`includeNotes`, `noteText`, `notesLabel`), `trace.status`
  lists notes, exclusions and related documents searched;
  `metrics.statusLatencyMs`; audited as `rag.status.end`.

- **Document structure.** `rag.structure.mode` (`'off'` default, `'label'`,
  `'split'`; `IngestOptions.structure` overrides it): `StructureParser` finds
  articles ("Artículo 12.2", "Art. 8°", "57 bis"), numbered sections ("3.4.6",
  "IV.3.4") and chapters, skipping tables of contents and citations; each
  chunk records the units it covers in `metadata.custom.section` and tags
  `art:<id>` / `sec:<id>`, with the articles the document marks as repealed
  ("Artículo 70 (DEROGADO)") and the text that gave an article its wording
  ("(Redacción dada por …)", or a closing "Circular 1234 de 15/03/2021" line).
  `'split'` cuts chunks at headings so that no chunk spans two units (a unit
  too small to stand alone joins the next). Relations that name articles
  apply only to the passages of those articles (`passageInactiveReason`,
  `notesFor(…, section)`); an article repealed in the text gets an
  `article_derogated` note and, with `inactive: 'exclude'`, leaves the
  context when the passage holds nothing else. Internal references ("ver
  punto 4.2", "según el artículo 8") are followed within the document
  (`rag.references.internal`, default on; `trace.references.internal`).
  `formatForContext` adds the unit to the source line (`includeSection`,
  `sectionText`).

- **Legal language profile (`rag.legal`, `LegalProfile`).** References,
  relations and structure read the text through built-in language packs —
  `es` (Spain, Latin America), `pt` (Brazil, Portugal), `en` (US, UK, EU),
  `fr`, `it`, `de`; all active by default, restricted with `packs` — plus the
  installation's own words for kinds of norms, operative verbs, headings,
  repeal and wording markers and internal references. Identifiers keep the
  full year (`yearPivot` for two-digit years) and read number/year or
  year/number by context, shape or pack (EU "2016/679", France "78-17");
  series letters, bis/ter, codified citations ("12 U.S.C. 248", "Pub. L.
  111-203", "S.I. 2017/692"), Brazilian paragraphs ("§ 1º", "Parágrafo
  único"), "Article premier", "Art. 2-bis", German "§ 5" and relative
  references ("el artículo anterior") are supported. `LegalProfile.normaliseKey`
  migrates keys stored with two-digit years.

- **Answer verification (`rag.verification`, `AnswerVerifier`).** A second,
  cheaper model call checks a generated answer against the passages it was
  based on: each claim (supported / partial / unsupported / contradicted,
  with the passages that support it), whether the passages apply to the case
  asked, and the figures of the answer that no passage contains (a hint to
  the verifier). `RAGPipeline.verifyAnswer(input, context)` records the
  tokens (`rag.verify`) and emits `rag.verification.end`; it never throws.
  `decideVerification(result, policy)` turns the outcome into deliver /
  repair / annotate / abstain (`onUnsupported`, `onNotApplicable`,
  `onUncertain`, `onError`, `afterRepair`); `buildRepairInstruction` and
  `verificationNotice` give the text for a second synthesis and for the
  user. `mode` (`off` / `after` / `blocking`) tells the host whether to check
  before or after delivering. `validateModels()` reports the `verifier` role.

- **`buildContextGuidance(result, texts?)`.** Instructions for the synthesis:
  the cited documents missing from the collection and how to treat status
  notes (repealed, amended, unconfirmed, discrepancies between versions).
  `createRAGTool` appends it to its context (`guidance`, default on) and takes
  `status` (`describeDocuments`, per-search modes) and `format` (options of
  `formatForContext`, e.g. `noteText` in the host's language).

- **OCR of scanned documents.** `OcrService` extracts the text of PDFs and
  images off the host's event loop: a worker thread reads the text layer of
  each page, renders the pages with fewer than `minChars` characters and
  recognises them with Tesseract (`tesseract.js`, new optional dependency).
  Workers are created on demand, process one page at a time, are terminated
  after `idleTimeoutMs` idle and when a page exceeds `pageTimeoutMs`;
  `concurrency` files at once. Language data is read from `langPath` and never
  downloaded unless `allowDownload`. Optional escalation of low-confidence
  pages to a vision model (`createVisionRecognizer`, any provider of the
  router, tokens recorded). Wired as `rag.ocr`: `PDFLoader` OCRs scanned pages
  and a new `ImageLoader` handles PNG/JPEG/TIFF/BMP/WebP; `orch.ocr` exposes
  the service. The worker ships as `dist/ocrWorker.js`.

- **Lexicon: stop words and glossary, the same on every vector store.** New
  `rag.lexicon` section.
  - `stopWords: 'auto'` removes built-in, curated stop words (es, en, pt, fr,
    it, de; function words only) from the text sent to the keyword component
    of the search — never from the documents, so nothing is re-indexed and it
    works on all seven adapters. The vector component keeps the full
    question. Negations and exclusions ("no", "sin", "not", "only", "não"…)
    are never removed. `languages` (or `RAGQuery.languages`) picks the lists;
    `extraStopWords` and `keepWords` tune them. Off by default.
  - Glossary: `glossaryFile` (installation, text format read by
    `parseGlossary`: `term = meaning` or `term, equivalent, …`) and
    `RAGQuery.glossary` (per collection, merged over it). Entries whose terms
    occur in the question or the last user turn reach the query rewriter and
    the query expander, which add the meaning or equivalents to the search.
    The contextual rewriter now also runs without history when glossary terms are present (one model call on those questions); `glossaryRewrite: false` turns that off.
  - Native stop words: `stopWordsMode` (`'auto'` default, `'native'`,
    `'query'`). Adapters declare `nativeStopWords` and implement
    `applyStopWords`: Meilisearch (index setting), Weaviate (class schema),
    pgvector (text-search configuration of the language, with PostgreSQL's
    dictionary and stemmer), Milvus (BM25 analyzer, at creation only).
    `orch.rag.createCollection(name, { languages })` creates collections with
    them; `orch.rag.configureCollection(name, { languages })` applies or clears
    them (audited as `rag.collection.stop_words`). Qdrant, Pinecone and the
    in-memory store apply them from the query.
  - `createRAGTool(..., { lexicon })` gives the agentic tool the collection's
    languages and glossary.
  - Trace: `trace.lexicon` (keyword text, stop words removed, glossary terms).
    Unreadable glossary lines are skipped, audited
    (`rag.glossary.invalid_lines`) and exposed as `rag.pipeline.glossaryErrors`;
    a missing file is a `ConfigError`.

- **Query expansion (multi-query retrieval).** New `rag.queryExpansion`
  section: a small model (`QueryExpander`) rewrites the question into 1–5
  alternative formulations (formal terminology, corrected spelling, keywords),
  each one is searched and the result lists are fused by reciprocal rank
  (`fuseRankedLists`, capped by `maxCandidates`, default 40) before re-ranking.
  The re-ranker and the answer still use the original question. `mode`:
  `'off'` (default), `'fallback'` (expand and re-rank again only when no
  candidate reaches `fallbackBelow`, default `minScore`, or there are none) or
  `'always'`; `RAGQuery.expansion` overrides it per search. The trace reports
  `expansion` (mode, triggered, reason, variants, candidate counts, error) and
  each candidate's `foundBy`; `metrics.expansionLatencyMs`; the expansion
  tokens are recorded; a failed expansion never fails the search
  (`rag.query_expansion.end` event, audited with counts only).
  `validateModels()` probes the expander (role `queryExpander`). Internally,
  `RAGPipeline.search()` is split into retrieve and rank stages.

- **Pricing catalog.** Cost estimates come from data instead of per-provider
  tables in code: `dist/pricing-catalog.json` (USD per 1M tokens, with cached
  and batch rates and announced retirements), regenerated from LiteLLM's
  community price list by `npm run pricing:update` before each release, plus
  curated corrections in `src/tokens/pricing-overrides.json` that a
  regeneration cannot undo. Override per installation with the new
  `llm.pricing` (keys `provider/model`, an instance name, or a bare model).
  New `PricingCatalog`, `CostEstimator` and `orch.pricing`.
- **Unpriced usage is visible.** A model without a known price is recorded
  with cost 0 and `unpriced: true`, counted in
  `TokenUsageSummary.unpricedTokens`, and reported once via
  `pricing.unknown_model`, instead of silently costing 0.
- **Retirement warnings.** `validateModels()` adds `deprecation` to models
  with an announced shutdown and emits `model.deprecated` (audited).
- **RAG usage is priced.** The query embedding is now recorded, ingestion
  embeddings carry the real model (they were recorded as `embedding` at cost
  0), and LLM re-ranker tokens are billed to the re-ranker's LLM provider
  (`RerankerProvider.billingProvider`).

- **`orch.validateModels()`: probe every configured model at startup.** Sends
  each role the request it really sends — the default LLM, the RAG embedding
  model, the re-ranker and the query rewriter — and reports
  `{ ok, models: [{ role, configured, provider, model, available, error }] }`.
  A reachability check (listing models) cannot see a model the credentials have
  no access to, or a reasoning model that spends its budget before answering.
  Failures go to the audit log (`model.unavailable`,
  `rag.reranker.unavailable`, `rag.query_rewriter.unavailable`). New
  `orch.rag.validateQueryRewriter()`, `orch.rag.validateEmbedding()` and
  `QueryRewriter.validate()`.
- **RAG search trace.** `RAGResult.trace` reports the query actually searched,
  the rewrite outcome (applied, or why it fell back), and every candidate with
  its retrieval and re-rank scores and where it ended up (`final`,
  `below_min_score`, `beyond_final_top_k`). It carries identifiers and scores,
  never passage text. A host can now tell "no candidates" from "candidates cut
  by `minScore`". The audit record of `search_complete` includes the post-cut
  passage count, `droppedByMinScore` and the candidates; the query text stays
  out of the audit log.
- **`QueryRewriter.rewriteWithOutcome()`** returns `{ query, applied,
fallbackReason?, error? }`. The pipeline uses it; custom rewriters inherit a
  default built on `rewrite()`.
- **`createRAGTool({ scopeFilters })`**: filters the host enforces for the
  calling context (e.g. the category the user selected), applied over the
  model's input and below the security filters. In agentic retrieval the model
  could otherwise drop or widen the user's scope. A resolver failure fails the
  search instead of running it unscoped.
- **`FormatOptions.sourceLabel`** (`'title'` | `'source'`).
- **`RerankerProvider.model`** and **`QueryRewriter.provider` / `.model`**
  (informational getters).

- **Extended JSON in Mongo queries.** `MongoDriver` converts single-key
  `{ $date }`, `{ $oid }`, `{ $numberDecimal }` and `{ $numberLong }` wrappers
  into BSON values before running a filter, pipeline or projection. A model
  writes JSON, which has no dates and no ObjectIds: without this, a free-form
  filter on a date compared a Date field with a string and silently matched
  nothing. An unusable wrapper is refused (`extended-json` control).
  `reviveExtendedJson` is exported for hosts that build queries themselves.

### Fixed

- **OpenAI: gpt-6.1, gpt-6.2 and gpt-5.6 models are priced.** They were
  missing from the built-in table and no entry is a prefix of them
  (`gpt-6-sol` does not match `gpt-6.1-sol`), so calls reported no cost.
  These are the replacements OpenAI names for gpt-5, gpt-5-mini and gpt-5-nano
  (retired on 2026-12-11).

- **OpenAI: a rejected `reasoningEffort` value is substituted, not dropped.**
  Model generations disagree on the scale (gpt-5 accepts `minimal` but not
  `none`; later families the reverse). The provider used to retry without the
  parameter, handing control to the model default (usually `medium`), and a
  caller that budgeted for minimal reasoning — the LLM re-ranker, the query
  rewriters — got an empty, truncated answer (`gpt-6-luna` failed every
  re-ranking parse). It now tries the closest values first (`minimal` → `none`
  → `low`, `none` → `minimal` → `low`, `xhigh` → `high`), remembers the
  accepted one per model, and omits the parameter only when none is accepted.

- **A failing query rewriter was recorded as a success.** A rewriter never
  fails the search — on error it keeps the original query — and the audit
  record of `query_rewrite` said `success` either way. A deployment whose
  rewriter pointed at a model its API key could not use searched every
  follow-up question literally for two months, with a clean audit log. The
  fallback is now recorded as `outcome: 'failure'`, `severity: 'warning'`, with
  the reason and the provider error.
- **The re-rank audit count was read as the final count.** `rag.rerank.end`
  reports passages before `minScore`, so a search that returned nothing showed
  `finalCount: 5`. The count after the cut is now on `rag.pipeline.complete`
  (`passageCount`, `droppedByMinScore`), and `rag.rerank.end` adds
  `candidateCount`. `rag.rerank.error` is now audited.

- **`sql.query` no longer shifts date-time values that have no time zone.** A
  `TIMESTAMP` (PostgreSQL, Oracle), `DATETIME` (MySQL) or Oracle `DATE`
  storing 03:04 reached the model as `…T06:04:05.000Z` from a process in UTC-3,
  and a `DATE` as a shifted instant. Zoneless columns are now returned as
  stored (`2026-01-02T03:04:05`, `2026-01-02`), for SDK-opened and injected
  pools alike; SQL Server `DATETIME2`/`DATE` lose their misleading `Z`. Zoned
  types are unchanged (UTC instants).
- **PostgreSQL connections declared with `url` and a `basic` credential
  connect.** `pg` lays the fields parsed from `connectionString` over the
  explicit options, so a URL without a password erased the credential's
  (`client password must be a string`); the credential now goes into the URL
  when it has none.
- **`LLMReranker.validate()` now proves the model can score.** The probe sent
  16 tokens and no reasoning effort; a reasoning model (gpt-5, gpt-5-mini,
  gpt-5-nano) spent them on hidden reasoning, returned an empty reply, and the
  probe still reported `ok: true` because it only checked that the call did not
  throw. It now runs one real scoring call — same prompt, `reasoningEffort` and
  token budget as `rerank()` — and fails unless the reply parses as a score
  (with a hint when the reply hit the token limit). Actual re-ranking was not
  affected: it already sent `reasoningEffort: 'minimal'`.
- **Query rewriters work with reasoning models.** `ContextualRewriter` (150
  tokens) and `HyDERewriter` (200) sent no reasoning effort, so a model that
  reasons by default returned nothing and the search silently used the original
  query. Both now send `reasoningEffort: 'minimal'` by default, configurable
  with `rag.queryRewriting.reasoningEffort` or the new `QueryRewriterOptions`
  constructor argument (`null` omits it). Models that do not reason by default
  (e.g. gpt-5.4-mini) behaved correctly before and are unaffected.
- **Rewriting fallbacks are observable.** When a rewriter keeps the original
  query (call error, empty, too long, or a too-short HyDE passage) it emits
  `rag.query_rewrite.fallback` with `strategy`, `provider`, `model`, `reason`
  and, when known, `stopReason`/`error`.
- **`rag.search` gives the query rewriter the conversation.** `createRAGTool`
  accepts a fourth `options` argument with `conversationHistory(context)`; the
  tool the Orchestrator auto-registers and the declarative `ref: 'rag.search'`
  use the session history. Before, a contextual rewriter was a no-op whenever
  retrieval happened through the tool (agentic mode). History is only loaded
  when a rewriter is configured; a loading failure is ignored.
- New `RAGPipeline.queryRewriter` getter.

### Dependencies

- **Security alerts resolved.** `proxy-addr` 2.0.8 (critical, runtime: reached
  through `@modelcontextprotocol/sdk` → `express`; the SDK uses the MCP client,
  not its server). Development only: `vitest` 4.1.11, `vite` 8.3.2 and
  `source-map-js` 1.2.2 close the Vitest UI, Vite, esbuild dev-server and
  source-map-js advisories. `mammoth` 1.13.0. Two advisories remain with
  no usable fix: `sprintf-js` (no patched release; reached through `mammoth`'s
  CLI parser and `tedious`, never with a model-controlled format string) and
  `esbuild` 0.27 through `tsup` (low, Windows dev server, which `tsup` does not
  run).
- The optional drivers accept their new major versions: `mongodb`
  `^6.21.0 || ^7.7.0` and `oracledb` `^6.9.0 || ^7.0.1`. A host that already
  depends on version 6 keeps it; a fresh install gets version 7. `mongodb` 7
  requires Node.js 20.19 or later.
- Development tooling: `@typescript-eslint` 8.71, `eslint-config-prettier` 10,
  `prettier` 3.9. Redundant type assertions the new lint rules report were
  removed (no behaviour change); TypeScript stays on 5.x (7.0 does not build
  the project yet).

### Documentation

- `TOOLS_MANUAL`: an Oracle function with `PRAGMA AUTONOMOUS_TRANSACTION` writes
  despite the read-only transaction (only grants stop it), date-time handling,
  and the redirect and IPv6 rules.

### Changed — BREAKING

- **Providers no longer price calls.** The built-in pricing tables of the
  OpenAI, Claude and Gemini adapters are gone, with `OpenAIModelPricing`,
  `ClaudeModelPricing`, `GeminiModelPricing`, `DEFAULT_GEMINI_PRICING` and the
  adapters' `pricing` / `disableDefaultPricing` options. The Orchestrator
  prices every call from the catalog (`llm.providers.<name>.pricing` still
  works: it becomes an override for that instance). The tables matched by
  prefix, so `gpt-5.4-mini` was billed as `gpt-5`, new families such as
  `gpt-6.1-*` reported no cost, and cached input was billed at the full rate.
  Anthropic cache reads, reported apart from `input_tokens`, are now priced at
  the cached rate. `TokenTracker` takes any `CostEstimator` (default: the
  shipped catalog) and `estimateCost()` accepts a `CostQuery`.
- **`tokens.pricing` defaults to empty**; its two sample entries overrode the
  catalog.

- **`tokens.limitMode` governs quotas only; recording is `tokens.tracking`.**
  `limitMode: 'disabled'` used to skip recording as well, so a deployment that
  turned quotas off also lost every usage and cost report (its usage
  dashboard showed zero after hundreds of calls). Usage is now recorded
  whatever the quota policy; set the new `tokens.tracking: false` to stop
  storing usage records. `TokenTracker` takes it as a fifth constructor
  argument (`{ tracking }`).

- **`formatForContext()` labels passages with the document title by default**
  (falling back to `source`, then `documentId`); it used `source` first. The
  source is often an internal path or URL, and the synthesis model copied it
  into answers ("Source: /srv/file/…"). Pass `sourceLabel: 'source'` for the
  previous label. `createRAGTool` follows the new default.
- **`LLMReranker` scores against an anchored rubric, in one call.** The prompt
  defines levels (1.0 answers the query, 0.7 contains most of the answer, 0.4
  same subject without the answer, 0.1 tangential, 0.0 unrelated) and tells
  the model to judge meaning rather than wording, keeping the rules against
  coincidental matches. The former "strict" prompt scored a colloquial query
  ("fake dollars") at 0.0 against the passage that answered it in formal
  terms. Other changes:
  - `batchSize` defaults to 50, so a normal search is scored in a single call
    (scores from separate calls are not comparable); larger sets run their
    batches in parallel instead of one after another.
  - JSON-Schema output (`{ scores: [{ id, score }] }`) when the provider
    supports it natively; a plain JSON array otherwise
    (`structuredOutput: 'off'` forces it). Scores are clamped to [0, 1].
  - The completion budget adds a reasoning allowance that grows with
    `reasoningEffort` (256 tokens at `minimal`, 2048 at `low`, …); a fixed
    256-token headroom made `gpt-5-nano` at `low` fail every parse.
  - New `samples` option averages independent scoring passes.

  Scores shift upwards: recalibrate `minScore` after upgrading.

- **The re-ranker scores every retrieval candidate**, not just `finalTopK`, so
  the trace can report the scores of the passages below the cut. LLM and
  cross-encoder re-rankers already read every candidate; the Cohere re-ranker
  now asks for all of them (`top_n`).

## [0.5.0] - 2026-09-28

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

[Unreleased]: https://github.com/agent-349/agent349/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/agent-349/agent349/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/agent-349/agent349/releases/tag/v0.5.0
