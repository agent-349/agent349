# Memory Manual — Agent349

## Introducción

Los sistemas de IA sin memoria son sin estado: cada request es independiente y el agente no recuerda nada de interacciones anteriores. Esto limita severamente la utilidad en contextos corporativos donde el agente necesita mantener coherencia dentro de una conversación, recordar preferencias del usuario entre sesiones, y acceder a conocimiento institucional.

El SDK implementa tres niveles de memoria con propósitos, ciclos de vida y backends distintos. Cada nivel responde a una pregunta diferente:

| Nivel | Pregunta | Alcance |
|---|---|---|
| 1 — Sesión | ¿Qué se dijo en esta conversación? | Una sesión |
| 2 — Largo plazo | ¿Qué sé de este usuario? | Cross-sesión, por usuario |
| 3 — Semántica (RAG) | ¿Qué sabe la organización? | Global, por colección |

---

## Nivel 1 — Memoria de Sesión

**Clase:** `SessionMemory` / `DefaultMemoryManager`

### Propósito

Mantener el historial de la conversación activa. Es lo que permite que el agente recuerde lo que se dijo tres turnos atrás dentro de la misma sesión.

### Storage

`StorageAdapter` — configurable vía `storage.backends` en el config JSON.
Clave: `session:messages:{sessionId}`.
TTL configurable — cada `save()` resetea el contador.

```json
{
  "storage": {
    "backends": {
      "redis-session": {
        "type": "redis",
        "host": "${REDIS_HOST}",
        "port": 6379,
        "password": "${REDIS_PASSWORD}",
        "keyPrefix": "agent349:"
      }
    }
  },
  "memory": {
    "session": {
      "backend": "redis-session",
      "strategy": "sliding_window",
      "ttlSeconds": 3600,
      "maxMessagesBeforeCompress": 20
    }
  }
}
```

Para desarrollo local, usá `"type": "memory"` sin infraestructura:

```json
{
  "storage": { "backends": { "memory": { "type": "memory" } } },
  "memory": { "session": { "backend": "memory", "strategy": "sliding_window", "ttlSeconds": 3600, "maxMessagesBeforeCompress": 20 } }
}
```

### Ciclo de vida

1. El `AgentLoop` llama a `memory.load(sessionId)` antes de cada LLM call.
2. Después de recibir la respuesta, llama a `memory.save(sessionId, messages)`.
3. `save()` persiste y evalúa automáticamente si aplica compresión.
4. Al expirar el TTL, el storage elimina la entrada.

### Qué guardar

- Mensajes `user` / `assistant` del turno actual
- Resultados de tool calls incluidos en el hilo

### Qué NO guardar

- Preferencias permanentes del usuario → van al Nivel 2
- Documentos corporativos → van al Nivel 3
- Estado de procesos externos (e.g., ID de transacciones pendientes) → fuera del SDK

### Estrategias de compresión

**`sliding_window`** — descarta los mensajes más viejos, mantiene los N más recientes. Sin costo extra. Adecuado para la mayoría de casos.

**`incremental_summary`** — llama al LLM para resumir el contexto antiguo antes de descartarlo. Preserva más semántica, pero suma latencia y tokens.

```typescript
// Override por agente cuando necesita contexto largo
orch.registerAgent({
  id: 'legal-analyst',
  name: 'Analista Legal',
  systemPrompt: '...',
  skills: ['legal'],
  memoryStrategy: {
    type: 'incremental_summary',
    maxMessages: 50,
    summaryThreshold: 40,
  },
});
```

---

### Contenido multimodal en la sesión

Un PDF en base64 son megabytes por turno, contra el límite de 16 MB por
documento de MongoDB y el presupuesto de memoria de Redis — y se reenviaría en
cada iteración del bucle. Por eso **los binarios no se persisten por defecto**.

`memory.session.mediaPersistence`:

| Valor | Qué se guarda |
|---|---|
| `'omit'` (default) | el contenido inline se sustituye por un bloque `media_omitted` explícito; las referencias `providerFile` **sí** se guardan (son pequeñas y reutilizables) |
| `'full'` | todo verbatim. Sólo si tu store está dimensionado para eso |

No hay pérdida silenciosa: el marcador **queda en el historial**, el provider lo
traduce a una nota explícita para el modelo en el siguiente turno
(`[document 'factura.pdf' … is no longer available: …]`), y se emite
`memory.media.omitted` en el EventBus.

Una referencia de archivo **expirada** (Gemini borra a las 48 h) se degrada al
mismo marcador con `reason: 'expired'` en vez de guardarse para fallar de forma
confusa después.

Si necesitás que el modelo siga viendo el documento al retomar la conversación,
subilo con la Files API y pasá la referencia: es liviana, persistible y
reutilizable. Ver `docs/MULTIMODAL_MANUAL.md` §5 y §6.

La misma política se aplica al snapshot de HITL (`messagesSnapshot`).

---

## Nivel 2 — Memoria de Largo Plazo

**Clase:** `LongTermMemory` / `DefaultMemoryManager`

### Propósito

Almacenar hechos sobre un usuario que deben persistir entre sesiones. Permite personalización sin que el usuario repita información en cada conversación.

### Storage

`StorageAdapter` — configurable vía `storage.backends` en el config JSON.
Clave: `ltm:facts:{tenantId}:{userId}`.
Sin TTL — los hechos son permanentes hasta que se eliminan explícitamente.
Evicción FIFO cuando se alcanza `maxFactsPerUser`.

```json
{
  "storage": {
    "backends": {
      "mongo-ltm": {
        "type": "mongo",
        "uri": "${MONGO_URI}",
        "database": "agent349",
        "collection": "longterm_memory"
      }
    }
  },
  "memory": {
    "longTerm": { "backend": "mongo-ltm", "maxFactsPerUser": 50 }
  }
}
```

### Ciclo de vida

Los hechos no se capturan automáticamente. El desarrollador los escribe explícitamente a partir de la lógica de la aplicación o de un tool dedicado. Se inyectan en el system prompt en cada request via `UserContext.longTermFacts`.

```typescript
// Escribir un hecho
await memory.saveFact(tenantId, userId, 'Prefiere respuestas en formato tabla');
await memory.saveFact(tenantId, userId, 'Trabaja en el departamento de Finanzas');

// Leer hechos para pasarlos al agente
const facts = await memory.getFacts(tenantId, userId);

const response = await orch.chat(
  'assistant',
  '¿Cuál es el presupuesto del Q3?',
  { tenantId, userId, roles },
  {
    userContext: {
      userId,
      roles,
      tenantId,
      longTermFacts: facts,
    },
  },
);
```

El `AgentLoop` inyecta los hechos en el system prompt automáticamente:

```
Known facts about user:
- Prefiere respuestas en formato tabla
- Trabaja en el departamento de Finanzas
```

### Qué guardar

- Preferencias de formato o idioma
- Departamento, rol corporativo
- Contexto recurrente ("siempre consulta por la cuenta ACC-1001")
- Restricciones conocidas del usuario

### Qué NO guardar

- Contenido completo de conversaciones pasadas → es costoso y no es el propósito
- Documentos o políticas institucionales → van al Nivel 3
- Datos sensibles sin justificación (salarios, datos médicos) sin revisión de ACL

---

## Nivel 3 — Memoria Semántica (RAG)

**Clases:** `InMemoryVectorStore`, `MeilisearchAdapter`, `RAGPipeline`

### Propósito

Indexar y recuperar conocimiento institucional mediante búsqueda semántica. A diferencia de los niveles 1 y 2 que son conversacionales, este nivel es una base de conocimiento compartida y consultable.

### Storage

Vector store (default: `InMemoryVectorStore`; producción: Meilisearch u otro adaptador).
Los documentos se almacenan como vectores de embeddings + metadata.
Sin TTL — el ciclo de vida lo gestiona el desarrollador vía `IngestionPipeline` y `CollectionManager`.

### Ciclo de vida

1. **Ingesta:** documentos → chunks → embeddings → vector store.
2. **Query:** pregunta → embedding → búsqueda por similitud → pasajes rankeados.
3. **Uso:** los pasajes se inyectan en el context del LLM via el tool `rag.search`.

```typescript
// El agente accede al conocimiento via tool, no directamente
const ragTool = createRAGTool(ragPipeline, ['politicas-rrhh', 'contratos']);
orch.registerTool(ragTool);
orch.registerSkill({ name: 'knowledge', tools: [ragTool], ... });
```

### Control de acceso — dos capas

El Nivel 3 tiene permisos en dos capas distintas:

**Capa 1 — ACL de tool (Módulo 3)**

`rag.search` es un `Tool` como cualquier otro. Si configurás `ToolACLMiddleware`, el `AgentLoop` evalúa si el usuario tiene permiso para invocar el tool antes de ejecutarlo.

```typescript
acl.addPolicy({
  resourceType: 'tool',
  resourceId: 'rag.search',
  allowedRoles: ['employee', 'manager'],
});
```

**Capa 2 — Filtro por documento (RAGFilter)**

Esta es la capa crítica. `RAGTool.execute()` inyecta automáticamente el `ExecutionContext` del request como filtro de búsqueda:

```typescript
// RAGTool.ts — el LLM no puede sobreescribir estos valores
filters: {
  ...input.filters,
  tenantId: context.tenantId,    // ← del request, no del LLM
  accessRoles: context.roles,    // ← del request, no del LLM
}
```

El vector store traduce esto a un filtro de documento. Con `MeilisearchAdapter`:

```
tenantId = 'acme' AND (accessRoles IN ['employee', '*'] OR accessRoles IS EMPTY)
```

Un usuario con rol `employee` nunca recibe documentos marcados para `it_admin` o `finance_admin`, aunque haga exactamente la misma query. El aislamiento opera a nivel de resultado, no solo de acceso al tool.

Para que esto funcione, los documentos deben ingestarse con la metadata correcta:

```typescript
await orch.rag.ingest({
  source: { type: 'text', content: politicaFinanzas },
  collection: 'politicas',
  metadata: {
    documentId: 'politica-gastos-v2',
    tenantId: 'acme',
    accessRoles: ['finance_viewer', 'finance_admin'],  // quiénes pueden verlo
    tags: ['finanzas', 'gastos'],
  },
});
```

Documentos sin `accessRoles` (array vacío) son públicos dentro del tenant.

### Qué guardar

- Políticas corporativas, reglamentos
- Contratos, documentación técnica
- FAQs, manuales de producto
- Cualquier documento que el agente deba consultar pero no memorizar

### Qué NO guardar

- Conversaciones de usuarios → Nivel 1
- Preferencias personales → Nivel 2
- Datos transaccionales en tiempo real → esos van en sistemas externos (ERP, CRM)

---

## Cómo interactúan los tres niveles

```
Request del usuario
       │
       ▼
  AgentLoop.run()
       │
       ├─► Nivel 1: load(sessionId) → historial de esta conversación
       │
       ├─► Nivel 2: longTermFacts inyectados en system prompt (vía UserContext)
       │
       └─► Nivel 3: rag.search (tool call) → recupera conocimiento institucional
                              └─► resultado incluido en el hilo → Nivel 1
```

Los tres niveles son complementarios, no redundantes. El Nivel 3 responde preguntas. El Nivel 2 personaliza respuestas. El Nivel 1 mantiene coherencia en el diálogo.

---

## Buenas prácticas

**1. Elegir el nivel correcto desde el diseño.**
Antes de guardar algo, preguntá: ¿este dato vive en una sesión, en un usuario, o en la organización? La respuesta determina el nivel.

**2. No usar Nivel 1 para persistir conocimiento.**
El historial de conversación expira. Si el agente necesita recordar algo indefinidamente, es Nivel 2 o 3.

**3. El Nivel 2 requiere lógica de negocio explícita.**
Los hechos de largo plazo no se capturan solos. Definí cuándo y qué guardar. No guardes todo — la evicción FIFO descarta los más viejos cuando se llena.

**4. Usar `IncrementalSummary` con criterio.**
Suma tokens y latencia en cada compresión. Usala solo para agentes con conversaciones muy largas donde la coherencia histórica es crítica (e.g., agentes de soporte técnico, análisis de contratos).

**5. El Nivel 3 necesita ingesta previa.**
El vector store no se auto-popula. Si el agente hace `rag.search` sobre una colección vacía, no va a encontrar nada y puede alucinar. Verificá que la ingesta esté completa antes de activar el agente.

---

## Anti-patrones

**❌ Guardar todo en Nivel 1 esperando que persista.**
El historial expira. Un reinicio del proceso con `type: "memory"` pierde todo. Para producción, configurar un backend Redis (`type: "redis"`) en `storage.backends`.

**❌ Cargar todos los hechos de largo plazo en el system prompt.**
Si un usuario tiene 50 hechos y los inyectás todos, el prompt crece significativamente. Filtrá los relevantes según el contexto del request.

**❌ Usar el Nivel 3 para datos transaccionales en tiempo real.**
Los vectores representan conocimiento estático o semi-estático. Para saldos de cuentas o stock en tiempo real, usá tools que consulten APIs o bases de datos directamente.

**❌ Ignorar `summaryThreshold` en `IncrementalSummary`.**
Si no configurás correctamente el umbral de compresión, el agente puede hacer un LLM call extra en cada turno de una conversación larga.

**❌ No gestionar el ciclo de vida del Nivel 3.**
Documentos desactualizados en el vector store producen respuestas incorrectas. Implementá re-ingesta periódica para documentos que cambian.

---

## Trade-offs de performance

| Operación | Latencia | Costo tokens | Persistencia |
|---|---|---|---|
| `memory.load()` | < 1ms (in-memory) | 0 | Sesión / TTL |
| `memory.save()` | < 1ms (in-memory) | 0 | Sesión / TTL |
| Compresión `sliding_window` | < 1ms | 0 | — |
| Compresión `incremental_summary` | 500–2000ms | ~500–1500 | — |
| `memory.getFacts()` | < 1ms (in-memory) | 0 | Indefinido |
| `rag.search()` | 10–500ms | ~50–200 (embedding) | Indefinido |

En producción, configurar Redis (`type: "redis"`) para el Nivel 1 y MongoDB (`type: "mongo"`) para el Nivel 2 en `storage.backends` agrega ~5–20ms de latencia de red pero habilita persistencia real y escalabilidad horizontal. `Orchestrator.shutdown()` cierra automáticamente todas las conexiones.
