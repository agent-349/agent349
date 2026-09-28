# RAG Manual — Agent349

## 1. Introducción

RAG (Retrieval-Augmented Generation) permite que un agente responda preguntas usando conocimiento que no está en el modelo de lenguaje. El agente busca fragmentos relevantes en una base vectorial y los inyecta como contexto antes de llamar al LLM. El resultado es un sistema que puede responder sobre documentos corporativos, contratos, políticas y cualquier dato que el modelo base no conoce, sin necesidad de fine-tuning.

El SDK implementa RAG como un pipeline de cinco etapas (rewrite → embed → search → rerank → format) con soporte multi-colección, multi-tenant, búsqueda semántica/keyword/híbrida y control de acceso por rol integrado.

---

## 2. Visión general

El sistema RAG tiene dos operaciones independientes: **ingesta** y **retrieval**.

**Ingesta** (offline, antes de usar el agente):
```
documento → loader → chunker → embedder → vector store
```

**Retrieval** (online, en cada request del agente):
```
query → [rewrite] → embed → search → rerank → format → LLM context
```

Ambas operaciones usan el mismo modelo de embeddings. Si cambiás el modelo de embeddings, los vectores existentes en el store quedan inutilizables — hay que re-ingestar.

---

## 3. Flujo completo del sistema

### Diagrama ASCII

```
╔══════════════════════════════════════════════════════════════════╗
║  INGESTA (offline)                                               ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  documento ──► DocumentLoader ──► chunks ──► EmbeddingRouter     ║
║  (.pdf, .md,     (PlainText,      (cada    (OpenAI / Cohere /    ║
║   .html, .docx)   Markdown,        chunk)   Ollama)              ║
║                   HTML, PDF,          │                          ║
║                   DOCX)              ▼                           ║
║                               VectorDocument                     ║
║                               { content, embedding,             ║
║                                 metadata, tenantId }             ║
║                                        │                         ║
║                                        ▼                         ║
║                               VectorStoreAdapter.upsert()        ║
║                               (InMemory / Meilisearch / ...)     ║
╠══════════════════════════════════════════════════════════════════╣
║  RETRIEVAL (online, por request)                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  query string                                                    ║
║       │                                                          ║
║       ▼                                                          ║
║  QueryRewriter.rewrite() [opcional]                              ║
║  (ContextualRewriter / HyDERewriter)                             ║
║       │                                                          ║
║       ▼                                                          ║
║  EmbeddingRouter.embed(query, model)                             ║
║       │                                                          ║
║       ▼                                                          ║
║  VectorStoreAdapter.search()  ◄─── RAGFilter                    ║
║  (vector | keyword | hybrid)        { tenantId, accessRoles }    ║
║       │                                                          ║
║       ▼                                                          ║
║  Passage[] (raw, topK por colección)                             ║
║       │                                                          ║
║       ▼                                                          ║
║  RerankerProvider.rerank() [opcional]                            ║
║       │                                                          ║
║       ▼                                                          ║
║  Passage[] (reranked, finalTopK)                                 ║
║       │                                                          ║
║       ▼                                                          ║
║  RAGPipeline.formatForContext()                                  ║
║       │                                                          ║
║       ▼                                                          ║
║  string → inyectado en system prompt del LLM                     ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 4. Componentes del sistema

### RAGFacade

Punto de entrada público en el `Orchestrator`. Expone las operaciones más comunes sin necesidad de interactuar con los componentes internos.

```typescript
// Acceso desde el orquestador
orch.rag.ingest(source, collection, options)
orch.rag.ingestDirectory(path, collection, options)
orch.rag.search(query, context)
orch.rag.createCollection(name, config)
orch.rag.listCollections()
orch.rag.deleteCollection(name)
orch.rag.removeDocument(documentId, collection)

// Acceso a componentes internos cuando se necesita más control
orch.rag.pipeline   // RAGPipeline
orch.rag.ingestion  // IngestionPipeline
orch.rag.collections // CollectionManager
```

### RAGPipeline

Ejecuta el pipeline de retrieval. Recibe un `RAGQuery` y devuelve un `RAGResult` con los pasajes rankeados y métricas de latencia.

### IngestionPipeline

Orquesta la ingesta: carga el documento, lo divide en chunks, genera embeddings y los guarda en el vector store. Deduplica por content-hash — el mismo documento ingestado dos veces no genera vectores duplicados (a menos que cambies el contenido).

### EmbeddingRouter

Distribuye las llamadas de embedding al proveedor correcto. El pipeline lee el `embeddingProvider` de la metadata de la colección en el vector store (campo `CollectionInfo.embeddingProvider`), de modo que indexar y consultar usan siempre el mismo provider con el que se creó la colección. Solo si el store no puede reportarlo (p. ej. colección creada fuera del SDK) se usa el `defaultEmbeddingProvider`.

### VectorStoreAdapter

Abstracción sobre el backend de almacenamiento. Hoy existen dos implementaciones: `InMemoryVectorStore` y `MeilisearchAdapter`. Implementar un nuevo backend requiere extender `VectorStoreAdapter`.

### CollectionManager

Gestiona el registro de colecciones: creación, listado, eliminación y tracking de estadísticas de ingesta. Accesible via `orch.rag.collections`.

### DocumentLoaderRegistry

Registra y resuelve loaders de documentos por extensión de archivo o tipo MIME. Los loaders incluidos (`PlainTextLoader`, `MarkdownLoader`, `HTMLLoader`, `PDFLoader`, `DOCXLoader`) se registran automáticamente al construir el `Orchestrator`.

### QueryRewriter

Estrategia opcional que transforma la query antes del embedding para mejorar la calidad de retrieval. Dos implementaciones:

- **`ContextualRewriter`** — reformula la query usando el historial de conversación para resolver referencias implícitas ("¿Y el precio?" → "¿Cuál es el precio del Plan A?")
- **`HyDERewriter`** — genera un documento hipotético que responde la query y busca por similitud con ese documento

Se configura desde `SDKConfig.rag.queryRewriting`.

### RerankerProvider

Re-rankea los candidatos después de la búsqueda inicial para mejorar la precisión del top final. Tres implementaciones:

- **`LLMReranker`** — usa el LLM configurado para scoring (flexible, mayor costo y latencia; requiere un modelo capaz de emitir JSON confiablemente — ver más abajo el caso de modelos de razonamiento)
- **`CohereReranker`** — usa la API de Cohere Rerank (más preciso, menor latencia)
- **`TEIReranker`** — usa un cross-encoder servido por Text Embeddings Inference (sin llamada a LLM: inmune a fallas de parseo)

Se configura desde `SDKConfig.rag.reranker`. Campos de `LLMRerankerConfig` (provider `'llm'`):

| Campo | Default | Descripción |
|---|---|---|
| `batchSize` | `10` | Pasajes por llamada al LLM |
| `maxTokens` | calculado por batch | Override plano del presupuesto de tokens por llamada, sin importar el tamaño del batch |
| `reasoningEffort` | `'minimal'` | Hint de esfuerzo de razonamiento; solo lo interpreta `OpenAIProvider`, el resto de los adapters lo ignoran |
| `onParseFailure` | cableado desde `rag.retrieval.rerankPolicy` | `'throw'` o `'degrade'` ante una respuesta no parseable |

### RAGTool

Factory que crea un `Tool` estándar (`rag.search`) que el agente puede invocar durante el loop. Inyecta automáticamente `tenantId` y `accessRoles` del `ExecutionContext` — el LLM no puede sobreescribir esos filtros.

El `Orchestrator` auto-registra el tool `rag.search` con colecciones `['default']` y los defaults de retrieval del config al acceder a `orch.rag`. Para usar colecciones específicas, re-registrá el tool manualmente (reemplaza el anterior):

```typescript
import { createRAGTool } from 'agent349';

const ragTool = createRAGTool(orch.rag.pipeline, ['politicas', 'contratos'], {
  topK: 15,
  finalTopK: 5,
  searchMode: 'hybrid',
});
orch.registerTool(ragTool);
```

---

## 5. Configuración de modelos

### Modelo de embeddings

El modelo de embeddings se define **a nivel de colección**, al momento de crearla. Todos los documentos de esa colección comparten el mismo modelo.

```typescript
await orch.rag.createCollection('politicas', {
  embeddingProvider: 'openai',
  embeddingModel: 'openai/text-embedding-3-small',  // Formato: "provider/model"
  dimensions: 1536,
  distanceMetric: 'cosine',
});
```

Si no especificás la colección antes de ingestar, `IngestionPipeline` la crea automáticamente con los valores default de `RAGFacade` (provider: `openai`, model: `text-embedding-3-small`, dimensions: 1536).

**Proveedores disponibles:**

| Provider | Modelos | Dimensiones |
|---|---|---|
| `openai` | `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002` | 1536 / 3072 / 1536 |
| `cohere` | `embed-v4.0`, `embed-multilingual-v3.0` | 1024 |
| `ollama` | `nomic-embed-text`, `mxbai-embed-large` | 768 / 1024 |

El pipeline lee el modelo almacenado en la metadata de la colección. No hay que especificarlo en cada query — está en el store.

### Modelo generativo (LLM)

El LLM lo define el agente, no el RAG. El RAG prepara el contexto; el agente lo usa en su system prompt. La separación es intencional: el mismo pipeline RAG puede alimentar agentes con modelos distintos.

La configuración del LLM sigue la cadena de resolución del orquestador: `agent.llmConfig` → `llm.defaultProvider` → fallback al primer provider disponible.

### Dónde se registran los providers de embedding

Los providers de embedding se configuran en `SDKConfig.rag.embedding.providers`. El `Orchestrator` los registra automáticamente en el `EmbeddingRouter` al inicializar el subsistema RAG. Providers cuya API key resuelve a un string vacío se omiten silenciosamente.

Para registro manual (e.g. en tests o con providers custom):

```typescript
import {
  OpenAIEmbeddingProvider,
  CohereEmbeddingProvider,
  OllamaEmbeddingProvider,
} from 'agent349';

orch.registerEmbeddingProvider(new OpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY! }));
orch.registerEmbeddingProvider(new CohereEmbeddingProvider({ apiKey: process.env.COHERE_API_KEY! }));
orch.registerEmbeddingProvider(new OllamaEmbeddingProvider({ baseURL: process.env.OLLAMA_BASE_URL }));
```

Cada constructor recibe un objeto de configuración con opciones específicas del provider:

| Provider | Config requerida | Config opcional |
|---|---|---|
| `OpenAIEmbeddingProvider` | `apiKey` | `model`, `dimensions`, `baseURL`, `apiVersion`, `organization`, `maxRetries`, `timeoutMs` |
| `CohereEmbeddingProvider` | `apiKey` | `model`, `inputType`, `baseURL`, `timeoutMs` |
| `OllamaEmbeddingProvider` | — | `model`, `baseURL`, `timeoutMs` |

### Cambio de modelo — impacto en compatibilidad

**Los vectores son incompatibles entre modelos distintos.** Un vector de `text-embedding-3-small` (1536 dims) no es comparable con uno de `text-embedding-3-large` (3072 dims), aunque los documentos sean los mismos.

Regla: **si cambiás el modelo de embeddings de una colección, tenés que re-ingestar todos los documentos de esa colección.**

**Estrategia recomendada:**

1. Creá una nueva colección con el nuevo modelo: `politicas-v2`
2. Re-ingestá todos los documentos en la nueva colección
3. Actualizá el `RAGTool` para apuntar a `politicas-v2`
4. Una vez validado, eliminá `politicas-v1`

Nunca actualices el modelo de una colección existente in-place. Las dimensiones almacenadas y las dimensiones del nuevo modelo difieren → las búsquedas darán resultados incorrectos o errores.

---

## 6. Vector databases

### InMemoryVectorStore

Para desarrollo local y tests. Los datos se pierden al reiniciar el proceso.

- Búsqueda vectorial: cosine similarity
- Búsqueda keyword: token overlap fraction
- Búsqueda híbrida: RRF fusion con alpha weighting
- Filtros: `tenantId`, `language`, `tags`, `accessRoles`, `dateRange`, metadata custom

```typescript
import { InMemoryVectorStore } from 'agent349';

const store = new InMemoryVectorStore();
```

### MeilisearchAdapter

Para producción. Búsqueda híbrida nativa, persistencia, escalabilidad.

```typescript
import { MeilisearchAdapter } from 'agent349';

const store = new MeilisearchAdapter({
  url: process.env.MEILI_URL ?? 'http://localhost:7700',
  apiKey: process.env.MEILI_API_KEY,
  requestTimeout: 10_000,
});
```

Campos filtrables configurados por defecto en Meilisearch: `tenantId`, `accessRoles`, `tags`, `language`, `author`, `documentId`, `createdAt`, `updatedAt`, `contentHash`.

El parámetro `hybridAlpha` del `RAGQuery` mapea directamente al `semanticRatio` de Meilisearch (0 = full-text puro, 1 = vectorial puro).

### pgvector, Qdrant, Weaviate, Milvus y Pinecone

Desde 0.4 hay cinco adapters más. Todos cumplen el mismo contrato: filtros de
tenant y roles (incluidos documentos públicos y el rol `'*'`), tags, documento,
idioma y fecha, upserts idempotentes, actualización de metadata sin re-embeber
y borrados masivos. Se configuran en `rag.vectorStore`, con una sección con el
nombre del adapter:

| Adapter    | Keyword                        | Híbrida          | `filter.metadata` | Requiere          |
| ---------- | ------------------------------ | ---------------- | ----------------- | ----------------- |
| `pgvector` | Full-text de PostgreSQL        | RRF              | ✅                | `npm install pg`  |
| `qdrant`   | BM25 (sparse con IDF)          | RRF              | ✅                | —                 |
| `weaviate` | BM25 nativo                    | Nativa (`alpha`) | ❌                | —                 |
| `milvus`   | Función BM25 nativa (2.5+)     | RRF              | ✅                | —                 |
| `pinecone` | ❌                             | ❌               | ❌                | —                 |

```json
{
  "rag": {
    "vectorStore": {
      "adapter": "qdrant",
      "qdrant": { "url": "${QDRANT_URL}", "apiKey": "${QDRANT_API_KEY}" }
    }
  }
}
```

Pinecone usa un índice para todas las colecciones (un namespace por colección)
y sólo admite búsqueda vectorial: `rag.retrieval.searchMode` debe ser
`"vector"`. La guía en inglés ([`docs/guides/rag.md`](../guides/rag.md#choosing-a-vector-store))
detalla la configuración y los límites de cada motor.

Para usar un adapter propio sin configuración: `Orchestrator.create(config, { vectorStore: new MiStore() })`.

### Implementar un adapter custom

Extendé `VectorStoreAdapter` e implementá todos los métodos abstractos:

```typescript
import { VectorStoreAdapter } from 'agent349';

export class PgVectorAdapter extends VectorStoreAdapter {
  override readonly name = 'pgvector';

  // Query-Time API
  override async search(collection, vector, topK, filter?) { ... }
  override async keywordSearch(collection, query, topK, filter?) { ... }
  override async hybridSearch(collection, vector, query, topK, alpha, filter?) { ... }

  // Metadata API
  override async collectionExists(collection) { ... }
  override async collectionInfo(collection) { ... }
  override async healthCheck() { ... }

  // Ingestion API
  override async upsert(collection, documents) { ... }
  override async delete(collection, ids) { ... }
  override async createCollection(collection, config) { ... }
}
```

---

## 7. Proceso de ingestión

### Fuentes soportadas

| Tipo | Descripción |
|---|---|
| `file` | Ruta a un archivo local |
| `text` | String en memoria |
| `url` | URL HTTP (fetch + parse) |
| `buffer` | Contenido binario en un `Buffer` |

### Formatos soportados

`.txt`, `.md`, `.html`, `.htm`, `.pdf`, `.docx`

### Flujo interno

1. `DocumentLoaderRegistry` selecciona el loader por extensión de archivo o tipo MIME
2. El loader extrae el texto limpio
3. El chunker divide el texto en fragmentos (ver estrategias abajo)
4. Cada chunk se embebe vía `EmbeddingRouter`
5. Los `VectorDocument` resultantes se guardan en el store vía `upsert()`

### Estrategias de chunking

**`RecursiveChunker`** (default) — divide por párrafos, oraciones y palabras, respetando semántica. Preferido para la mayoría de casos.

**`FixedSizeChunker`** — divide por cantidad fija de tokens. Más predecible, menos semántico.

**`MarkdownChunker`** — divide por headers de Markdown (`#`, `##`, `###`). Ideal para documentación estructurada.

```typescript
await orch.rag.ingest(
  { type: 'file', path: './docs/policy.pdf' },
  'politicas',
  {
    metadata: {
      documentId: 'politica-vacaciones-v3',
      tenantId: 'acme',
      accessRoles: ['employee'],
      tags: ['rrhh', 'vacaciones'],
    },
    chunking: {
      strategy: 'recursive',   // 'recursive' | 'fixed_size' | 'markdown'
      chunkSize: 500,           // tokens por chunk (default: 512)
      chunkOverlap: 50,         // overlap entre chunks (default: 50)
    },
    overwriteExisting: true,    // elimina chunks anteriores del mismo documentId (default: true)
    deduplication: true,        // omite chunks con content-hash duplicado (default: true)
    embeddingBatchSize: 50,     // chunks por batch de embedding (default: 50)
    upsertBatchSize: 100,       // documentos por batch de upsert (default: 100)
  },
);
```

### Metadata de documentos

`DocumentMetadata` tiene campos de primer nivel con semántica definida (`documentId`, `tenantId`, `accessRoles`, `tags`, `language`, `author`, `title`, `source`, `mimeType`, `createdAt`, `updatedAt`) y un campo `custom` para datos arbitrarios de la aplicación:

```typescript
await orch.rag.ingest('./docs/contrato-123.pdf', 'contratos', {
  metadata: {
    documentId: 'contrato-123',
    tenantId: 'acme',
    accessRoles: ['legal', 'finance'],
    tags: ['contratos', 'vigente'],
    language: 'es',
    author: 'legal-team',
    custom: {
      customerId: 'cust-456',
      country: 'AR',
      department: 'legal',
      contractType: 'servicios',
      expiresAt: '2027-01-01',
    },
  },
});
```

Los campos `custom` se almacenan en el vector store junto con la metadata estándar y pueden usarse como filtros en las búsquedas (ver sección 8).

### Ingesta de directorios

```typescript
await orch.rag.ingestDirectory('./docs/politicas', 'politicas', {
  recursive: true,
  extensions: ['.pdf', '.md'],
  metadata: {
    tenantId: 'acme',
    accessRoles: ['employee'],
  },
});
```

### Deduplicación

`IngestionPipeline` calcula el content-hash (SHA-256) de cada chunk antes de procesar. Si un chunk con el mismo `documentId` y el mismo hash ya existe, se omite (controlado por `deduplication: true`, el default). Para forzar re-ingesta de un documento sin cambios de contenido, usá `deduplication: false` o `overwriteExisting: true` (que elimina los chunks anteriores del documento antes de insertar los nuevos).

---

## 8. Proceso de retrieval

### RAGQuery

```typescript
const result = await orch.rag.search(
  {
    query: '¿Cuántos días de vacaciones corresponden?',
    collections: ['politicas'],       // Una o más colecciones
    topK: 10,                         // Candidatos por colección antes del reranking
    finalTopK: 5,                     // Pasajes finales después del reranking
    searchMode: 'hybrid',             // 'vector' | 'keyword' | 'hybrid'
    hybridAlpha: 0.7,                 // 0 = full-text, 1 = vectorial (default: 0.7)
    rerank: true,                     // Aplicar reranker si está disponible (default: true)
    rerankPolicy: 'require',          // Qué hacer si el reranker falla (default: 'require')
    minScore: 0.3,                    // Descartar pasajes bajo este score
    rrfK: 60,                         // Constante RRF para InMemoryVectorStore (default: 60)
    filters: {
      tags: ['rrhh'],                 // Filtrar por metadata
    },
    conversationHistory: messages,    // Historial para QueryRewriter (opcional)
  },
  context,
);
```

### Fallas del reranker (`rerankPolicy`)

El reranker no es un refinamiento cosmético: es la **única etapa que produce
scores de relevancia absolutos**. Los scores de retrieval se normalizan min-max
por colección (ver "Búsqueda multi-colección"), de modo que el mejor candidato
siempre vale `1.0` — haya o no una coincidencia real. Sin reranker, `minScore`
deja de discriminar y el pipeline devuelve los vecinos más cercanos de
*cualquier* query como si fueran coincidencias confiables.

Por eso, cuando se pide `rerank: true` y el reranker configurado falla:

| Política | Comportamiento |
|---|---|
| `'require'` (default) | Lanza `RerankerError` (`code: 'RERANKER_UNAVAILABLE'`). La query no se responde. |
| `'degrade'` | Emite `rag.rerank.error` y cae al orden de retrieval. Opt-in explícito. |

Se configura globalmente en `rag.retrieval.rerankPolicy` y se puede sobrescribir
por query con `RAGQuery.rerankPolicy`.

La política aplica sólo a un reranker **configurado que falla**. Si no hay
reranker configurado, el pipeline ordena por score sin lanzar: eso es una
decisión de diseño del deployment, no un incidente. Para detectar un reranker
mal configurado o inalcanzable, usá la verificación de arranque:

```typescript
const check = await orch.rag.validateReranker();
// { configured: true, provider: 'tei', available: false, error: 'ECONNREFUSED', latencyMs: 32 }

if (check.configured && !check.available) {
  logger.error(`Reranker '${check.provider}' inalcanzable: ${check.error}`);
}
```

Cuando el probe falla, `error` trae el motivo real (`ECONNREFUSED`, un 401, un
modelo inexistente). Todos los providers del SDK — reranker, LLM y embedding —
implementan `validate(): Promise<ProviderProbe>` devolviendo `{ ok, error? }`:
un chequeo de arranque que sólo puede decir "falló" no sirve para operar, porque
un host caído y una credencial vencida exigen respuestas distintas.

`validateReranker()` nunca lanza: reporta el resultado. Decidir si un reranker
caído debe impedir el arranque es responsabilidad de la aplicación host, no del
SDK — condicionar el boot a un servicio externo es un riesgo por derecho propio.
Emite `rag.reranker.available` / `rag.reranker.unavailable` en el EventBus.

Los rerankers basados en LLM tienen un segundo modo de falla: una respuesta que
no parsea como array de scores. `LLMReranker` la trata con la misma política
(`onParseFailure`, cableado desde `rag.retrieval.rerankPolicy`), porque inventar
scores produce un resultado indistinguible de un ranking real: plausiblemente
ordenado, por encima de cualquier `minScore` y reportado como `reranked: true`.

#### Causa frecuente del parse error: modelos de razonamiento

`LLMReranker` pide a cada batch un presupuesto de tokens acotado (`maxTokens`)
para que el modelo devuelva solo el array JSON de scores — no una respuesta
libre. En un modelo sin razonamiento (Ollama, GPT-4o clásico), ese presupuesto
alcanza sobrando porque todo se gasta en el texto visible.

En un modelo de razonamiento (familia GPT-5, o-series), `max_completion_tokens`
acota el total de tokens de la respuesta — **incluyendo los tokens de
razonamiento ocultos**, que se consumen antes de que el modelo empiece a
escribir el array visible. Con un presupuesto pensado solo para el JSON, el
razonamiento oculto puede agotarlo entero: la respuesta visible llega vacía o
truncada, y `#parseScores` no encuentra ningún array que parsear.

Dos parámetros de `LLMRerankerConfig` mitigan esto:

- **`maxTokens`** — override plano del presupuesto por batch. El default ya
  incluye margen para razonamiento (`batch.length * 8 + 256`, contra los
  `batch.length * 8 + 16` de versiones previas del SDK), pero un modelo que
  razona mucho puede necesitar más.
- **`reasoningEffort`** — el SDK ya aplica `'minimal'` por defecto en el
  reranker LLM (puntuar relevancia no necesita razonamiento profundo).
  Configurable, e inocuo donde no aplica: solo `OpenAIProvider` lo lee: Claude,
  Ollama y Gemini lo ignoran, y un endpoint OpenAI-compatible que lo rechace lo
  descarta solo vía el mecanismo de relajación de parámetros del provider.

`temperature: 0` (fijo en el reranker LLM) también puede ser rechazado por un
modelo de razonamiento — eso se recupera solo por el mismo mecanismo, a costa
de un round-trip extra, y no es la causa del parse error.

### Qué texto evalúa el reranker

El reranker puntúa **título + contenido** del pasaje, no el contenido a secas.

Un chunk llega al reranker despojado del documento al que pertenece, y un
cross-encoder juzga si *ese texto* responde la consulta. Cuando el tipo o el
asunto del documento viven en el nombre del archivo y no en el cuerpo — habitual
en documentos corporativos escaneados o exportados — el pasaje nunca dice qué
es, y una consulta que nombra al documento por su tipo puntúa casi cero.

Medido sobre un corpus real, `"¿tenemos circular de covid?"` contra circulares
cuyo cuerpo nunca usa la palabra "circular":

| Texto evaluado | Score | Pasajes sobre umbral 0.1 |
|---|---|---|
| Solo contenido | 0.019 | 0 de 5 |
| Título + contenido | 0.648 | 5 de 5 |

El título es toda la ganancia: agregar categoría o fecha de ingesta movió los
scores menos de 0.03 en cualquier dirección, y cada token extra compite con el
contenido real por la atención del modelo, así que el prefijo es deliberadamente
mínimo. La recuperación ya indexa el título y el prompt de síntesis ya lo
recibe; el reranker era la única etapa juzgando a ciegas.

Los pasajes **devueltos conservan su `content` original**: un contenido
reescrito se filtraría a los snippets de la UI y al contexto del LLM. Un
`RerankerProvider` propio obtiene el mismo comportamiento usando el helper
`scoringText(passage)` de la clase base.

### Búsqueda multi-colección

Cuando `collections` tiene más de una entrada, el pipeline busca en paralelo en todas. Los resultados se normalizan per-colección (min-max scoring) para que los scores sean comparables, se deduplicación por `documentId` (gana el score más alto), y luego se rerankean juntos.

```typescript
await orch.rag.search(
  {
    query: '¿Qué dice el contrato sobre confidencialidad?',
    collections: ['contratos', 'politicas', 'legales'],
    topK: 5,
    finalTopK: 3,
    searchMode: 'hybrid',
  },
  context,
);
```

### Filtros de búsqueda

`RAGFilter` soporta filtros de primer nivel con semántica definida y un campo `metadata` para filtrar por campos custom:

```typescript
await orch.rag.search(
  {
    query: 'cláusulas de confidencialidad',
    collections: ['contratos'],
    filters: {
      // Filtros de primer nivel
      tenantId: 'acme',
      tags: ['vigente'],                        // OR: al menos uno de estos tags
      language: 'es',
      accessRoles: ['legal'],                   // Documentos accesibles para este rol
      dateRange: { from: new Date('2025-01-01') },

      // Filtros custom — matchean contra DocumentMetadata.custom
      metadata: {
        customerId: 'cust-456',
        country: 'AR',
        contractType: 'servicios',
      },
    },
  },
  context,
);
```

Los filtros de primer nivel (`tenantId`, `tags`, `language`, `accessRoles`, `dateRange`) se aplican directamente sobre los campos estándar de `DocumentMetadata`. El campo `metadata` matchea contra los datos almacenados en `DocumentMetadata.custom` al momento de la ingesta.

### Filtros de seguridad — automáticos

El `RAGTool` (el tool que usan los agentes) inyecta automáticamente `tenantId` y `accessRoles` del `ExecutionContext` en cada query. El LLM no puede sobreescribir estos valores:

```typescript
// RAGTool.ts — este código corre siempre, independiente del input del LLM
filters: {
  ...input.filters,
  tenantId: context.tenantId,    // Del request, no del LLM
  accessRoles: context.roles,    // Del request, no del LLM
}
```

### Resultado

```typescript
const { passages, metrics } = result;

// Pasajes rankeados
passages.forEach((p) => {
  console.log(p.content);        // Texto del fragmento
  console.log(p.score);          // Score de relevancia [0-1]
  console.log(p.metadata);       // documentId, tenantId, tags, etc.
  console.log(p.collection);     // Colección de origen
});

// Métricas de latencia
console.log(metrics.embeddingLatencyMs);  // Tiempo de embedding del query
console.log(metrics.searchLatencyMs);     // Tiempo de búsqueda en el store
console.log(metrics.rerankLatencyMs);     // Tiempo de reranking (undefined si no se usó)
console.log(metrics.totalLatencyMs);      // Total pipeline
console.log(metrics.tokensUsed);          // Tokens consumidos si el reranker es LLM-based
```

---

## 9. Generación de respuesta

El RAG prepara el contexto; el LLM lo usa. La integración ocurre via `rag.search` como tool del agente.

### Flujo en el AgentLoop

1. El usuario hace una pregunta al agente
2. El LLM decide invocar `rag.search` con los parámetros relevantes
3. `RAGTool.execute()` corre el pipeline y formatea los pasajes
4. El resultado se agrega al hilo de conversación
5. El LLM genera la respuesta final usando los pasajes como contexto

El formato de los pasajes que recibe el LLM:

```
[Source 1 — collection: politicas, score: 0.92]
Los empleados tienen derecho a 15 días hábiles de vacaciones al año...

[Source 2 — collection: politicas, score: 0.87]
Las vacaciones deben solicitarse con al menos 15 días de anticipación...
```

### Uso del contexto RAG sin el AgentLoop

Para queries directas sin pasar por el loop del agente:

```typescript
const result = await orch.rag.search({ query, collections: ['politicas'] }, context);
const contextText = orch.rag.pipeline.formatForContext(result.passages);

const response = await llmProvider.complete({
  systemPrompt: `Respondé usando únicamente la siguiente información:\n\n${contextText}`,
  messages: [{ role: 'user', content: query }],
  model: 'claude-opus-5',
  temperature: 0.1,
  maxTokens: 2048,
});
```

---

## 10. Integración con el Orchestrator

El `Orchestrator` construye y expone el sistema RAG como `orch.rag` (un `RAGFacade`). La inicialización es lazy: los componentes internos se instancian al primer acceso a `orch.rag`, leyendo la sección `rag` de `SDKConfig`.

El Orchestrator auto-registra el tool `rag.search` con colecciones `['default']` y los defaults de retrieval del config. Para usar colecciones específicas, re-registrá el tool (ver sección 4).

### Setup básico

```typescript
import { Orchestrator } from 'agent349';

const orch = await Orchestrator.create('./agent349.config.json');

// La colección se crea la primera vez (o al startup si querés controlar la config)
await orch.rag.createCollection('politicas', {
  embeddingProvider: 'openai',
  embeddingModel: 'openai/text-embedding-3-small',
  dimensions: 1536,
  distanceMetric: 'cosine',
});

// Ingesta inicial
await orch.rag.ingestDirectory('./docs', 'politicas', {
  extensions: ['.pdf', '.md'],
  metadata: { tenantId: 'acme', accessRoles: [] },  // [] = público dentro del tenant
});

// Re-registrar el tool con las colecciones específicas
import { createRAGTool } from 'agent349';

const ragTool = createRAGTool(orch.rag.pipeline, ['politicas']);
orch.registerTool(ragTool);
orch.registerSkill({
  name: 'knowledge',
  description: 'Buscar en la base de conocimiento corporativa',
  tools: [ragTool],
});

// El agente usa el skill
orch.registerAgent({
  id: 'hr-bot',
  name: 'Asistente de RRHH',
  systemPrompt: '...',
  skills: ['knowledge', 'general'],
});
```

### Setup con Meilisearch (producción)

El vector store se selecciona desde el archivo de configuración JSON. No es necesario instanciar `MeilisearchAdapter` manualmente:

```json
{
  "rag": {
    "vectorStore": {
      "adapter": "meilisearch",
      "meilisearch": {
        "url": "${MEILI_URL}",
        "apiKey": "${MEILI_API_KEY}",
        "requestTimeout": 15000
      }
    }
  }
}
```

```typescript
// El Orchestrator crea MeilisearchAdapter automáticamente
const orch = await Orchestrator.create('./agent349.config.json');
```

Para instanciación manual directa (e.g. tests de integración o configuraciones avanzadas):

```typescript
import { MeilisearchAdapter } from 'agent349';

const store = new MeilisearchAdapter({
  url: process.env.MEILI_URL!,
  apiKey: process.env.MEILI_API_KEY,
  requestTimeout: 10_000,
});
```

---

## 11. Estrategias de diseño

### Cuándo usar `vector` vs `keyword` vs `hybrid`

| Modo | Cuándo usarlo |
|---|---|
| `vector` | Preguntas conceptuales, paráfrasis, similitud semántica |
| `keyword` | Búsqueda de términos exactos: nombres propios, códigos, IDs |
| `hybrid` | La mayoría de casos en producción. `alpha: 0.7` es un buen punto de partida |

### Sizing de chunks

- Chunks muy pequeños (< 100 tokens): alta precisión semántica, poco contexto por pasaje → el LLM no tiene suficiente texto
- Chunks muy grandes (> 1000 tokens): más contexto, menor precisión semántica → el vector no captura bien el tema principal
- **Recomendación:** 400–600 tokens con 50–100 de overlap para documentos corporativos en prosa

### topK vs finalTopK

`topK` es la cantidad de candidatos por colección antes del reranking. `finalTopK` es la cantidad final que llega al LLM. Relación típica: `topK = 3 × finalTopK`.

- `topK: 15, finalTopK: 5` → el reranker elige los mejores 5 de 15 candidatos
- Si no usás reranker, `topK` y `finalTopK` deberían ser iguales

### Diseño de colecciones

Una colección = un espacio semántico coherente + un modelo de embedding consistente.

✓ Una colección por dominio: `politicas-rrhh`, `contratos`, `soporte-tecnico`

✗ Una colección para todo: los scores no son comparables entre dominios muy distintos, y el control de acceso por colección es más granular

### Multi-tenant

El `tenantId` viaja en la metadata de cada chunk y en el `ExecutionContext` de cada request. Los filtros de tenant se aplican en el vector store — no en el código del agente. Diseñá todos los ingestos con `tenantId` explícito desde el primer día.

---

## 12. Buenas prácticas

**1. Crear colecciones explícitamente al startup.**
La creación automática usa defaults que pueden no ser los correctos para tu caso. Siempre creá las colecciones con la config que corresponde antes de ingestar.

**2. Versionar colecciones al cambiar de modelo.**
`politicas-v1` (ada-002) → `politicas-v2` (text-embedding-3-small). Nunca actualices el modelo de una colección en producción sin re-ingestar.

**3. Siempre especificar `tenantId` al ingestar.**
Incluso en sistemas single-tenant. Migrarlo después es costoso — requiere re-indexar todo.

**4. Usar `overwriteExisting: true` para documentos que se actualizan.**
Con `overwriteExisting: true` (el default), los chunks anteriores del mismo `documentId` se eliminan antes de insertar los nuevos. Si lo desactivás, documentos actualizados generan chunks duplicados.

**5. Monitorear `metrics.embedLatencyMs`.**
Las llamadas de embedding a APIs externas (OpenAI, Cohere) tienen latencia variable (20–200ms). Si embedás en ingesta y en query, el costo se acumula. Medir antes de estimar tiempos de respuesta.

**6. `minScore` > 0 sólo tiene sentido con reranker.**
El filtro `minScore` se aplica al score final de los pasajes. Con reranker, ese
score es el del cross-encoder: absoluto y calibrado, así que el umbral discrimina
de verdad. **Sin reranker, el score viene normalizado min-max por colección**: el
mejor candidato siempre vale `1.0` y el peor `0.0`, tenga o no relevancia real,
así que ningún valor de `minScore` puede distinguir una query con respuesta de
una sin respuesta — y nunca puede devolver cero pasajes. Si necesitás que "sin
resultados relevantes" sea un estado alcanzable, activá el reranker.

**7. El reranker mejora calidad a costo de latencia.**
El `RerankerProvider` hace un LLM call extra por cada set de candidatos. Usalo cuando la precisión es crítica y podés tolerar +200–500ms extra. En cross-encoders locales (TEI) el costo es por token: la latencia crece de forma lineal con `topK` y con el tamaño de chunk, y sin GPU puede pasar de un segundo por candidato. Dimensioná el deploy antes de subir `topK`.

**8. Verificá el reranker al arrancar.**
Con `rerankPolicy: 'require'`, un reranker inalcanzable hace fallar la primera query del primer usuario. `orch.rag.validateReranker()` convierte ese incidente en una línea de log al boot.

---

## 13. Anti-patrones

**❌ Asumir que RAG funciona sin ingesta previa.**
El vector store vacío devuelve 0 resultados. El agente puede alucinar porque no tiene contexto. Verificá que la ingesta completó antes de activar el agente.

**❌ Ingestar sin `documentId` explícito.**
Sin `documentId`, la deduplicación no funciona. Cada ingesta del mismo archivo genera chunks nuevos. Siempre especificá un identificador estable (ruta relativa, ID del documento fuente).

**❌ Mezclar dominios radicalmente distintos en una colección.**
Contratos legales y logs de soporte técnico en la misma colección producen scores inconsistentes. Separar por dominio mejora tanto la precisión semántica como el control de acceso.

**❌ Usar `searchMode: 'vector'` para queries con nombres propios o IDs.**
El modelo de embeddings puede no capturar bien `"Contrato ACC-2024-0087"`. Para búsquedas de términos exactos, usá `keyword` o `hybrid` con `alpha < 0.5`.

**❌ Confiar en `topK: 3` para multi-colección sin reranker.**
Con 3 colecciones y `topK: 3`, obtenés hasta 9 candidatos. Sin reranker, los scores de colecciones distintas no son comparables directamente. Subí `topK` o activá reranker en multi-colección.

**❌ Ignorar el ciclo de vida de documentos.**
Documentos desactualizados en el vector store producen respuestas incorrectas. Implementá re-ingesta periódica para documentos que cambian (políticas, contratos, precios).

**❌ No filtrar por `accessRoles` en sistemas multi-rol.**
Sin `accessRoles` en la metadata de los documentos, todos los usuarios del tenant ven todos los documentos. El filtro ACL requiere que los datos tengan la metadata correcta desde la ingesta.

---

## 14. Ejemplos reales

### Agente de RRHH con acceso a políticas

```typescript
// 1. Ingesta de políticas
await orch.rag.createCollection('politicas-rrhh', {
  embeddingProvider: 'openai',
  embeddingModel: 'openai/text-embedding-3-small',
  dimensions: 1536,
  distanceMetric: 'cosine',
});

await orch.rag.ingestDirectory('./docs/rrhh', 'politicas-rrhh', {
  extensions: ['.pdf', '.md'],
  metadata: {
    tenantId: 'acme',
    accessRoles: ['employee'],   // Todos los empleados pueden verlo
    tags: ['rrhh', 'politicas'],
  },
});

// Documentos confidenciales con acceso restringido
await orch.rag.ingest('./docs/escala-salarial.pdf', 'politicas-rrhh', {
  metadata: {
    documentId: 'escala-salarial-2024',
    tenantId: 'acme',
    accessRoles: ['hr_admin', 'finance_admin'],  // Solo roles privilegiados
    tags: ['rrhh', 'salarios'],
  },
  overwriteExisting: true,
});

// 2. Tool y skill
const ragTool = createRAGTool(orch.rag.pipeline, ['politicas-rrhh']);
orch.registerTool(ragTool);
orch.registerSkill({
  name: 'hr-knowledge',
  description: 'Consultar políticas de RRHH',
  tools: [ragTool],
});

// 3. Agente
orch.registerAgent({
  id: 'hr-bot',
  name: 'Asistente de RRHH',
  systemPrompt:
    'Sos el asistente de RRHH de ACME. Respondé preguntas sobre políticas usando ' +
    'la base de conocimiento. Si no encontrás información relevante, indicalo.',
  skills: ['hr-knowledge'],
});

// 4. Request — un employee ve políticas pero NO la escala salarial
const response = await orch.chat(
  'hr-bot',
  '¿Cuántos días de vacaciones tengo?',
  { tenantId: 'acme', userId: 'u-456', roles: ['employee'] },
  { sessionId: 'sess-789' },  // sessionId va en options (cuarto argumento)
);
```

### Query directa con búsqueda híbrida

```typescript
// Búsqueda directa (sin pasar por agente)
const result = await orch.rag.search(
  {
    query: 'política de trabajo remoto',
    collections: ['politicas-rrhh', 'contratos'],
    topK: 10,
    finalTopK: 4,
    searchMode: 'hybrid',
    hybridAlpha: 0.6,       // Más peso al full-text por términos específicos
    rerank: true,
    minScore: 0.35,
  },
  {
    tenantId: 'acme',
    userId: 'u-456',
    roles: ['employee'],
    agentId: 'direct',
    sessionId: 'direct',
    requestId: 'req-002',
  },
);

console.log(`Encontrados: ${result.passages.length} pasajes`);
console.log(`Latencia total: ${result.metrics.totalLatencyMs}ms`);

for (const p of result.passages) {
  console.log(`[${p.collection}] Score: ${p.score.toFixed(3)}`);
  console.log(p.content.slice(0, 200));
}
```

### Re-ingesta al actualizar un documento

```typescript
// La política se actualizó — reemplazar todos sus chunks
await orch.rag.ingest(
  { type: 'file', path: './docs/rrhh/vacaciones-v4.pdf' },
  'politicas-rrhh',
  {
    metadata: {
      documentId: 'politica-vacaciones',   // Mismo ID que la versión anterior
      tenantId: 'acme',
      accessRoles: ['employee'],
      tags: ['rrhh', 'vacaciones'],
    },
    overwriteExisting: true,   // Elimina chunks del documentId anterior antes de ingestar
  },
);
```
