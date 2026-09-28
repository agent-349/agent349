# Auditoría — Guía de Uso

> Registro funcional inmutable de Agent349: activación, consulta, estadísticas, MongoDB y privacidad

---

## 1. Introducción y conceptos

La auditoría de Agent349 captura **qué pasó, quién lo hizo y con qué resultado**, en registros inmutables (`AuditRecord`) aptos para compliance. Se alimenta del **EventBus**: cada evento relevante del sistema (loop del agente, llamadas a tools y LLM, decisiones de seguridad, aprobaciones HITL, etc.) se convierte automáticamente en un registro de auditoría y se persiste a través de un **store plugable**.

### 1.1 Los tres planos de observabilidad

Agent349 separa tres responsabilidades. **Este manual cubre sólo el plano de auditoría funcional.**

| Plano | Propósito | Consumidor | Mutabilidad | Persistencia |
|---|---|---|---|---|
| **Log técnico** | Debugging, observabilidad | Dev / SRE | Efímero | Opcional |
| **Auditoría funcional** | Compliance, "quién hizo qué" | Auditor / Seguridad | **Inmutable** | **Siempre** |
| **Métricas de consumo** | Billing, quotas | Finanzas / Admin | Agregable | Siempre |

Los tres se alimentan del **mismo EventBus**, pero con consumidores distintos. La auditoría usa el `EventCollector` → `AuditLogger` → `AuditStoreAdapter`.

### 1.2 Modelo de datos: `AuditRecord`

```typescript
interface AuditRecord {
  // Identificación
  id: string;                 // UUID del registro
  timestamp: Date;            // UTC

  // Correlación
  requestId: string;          // enlaza todos los registros de una llamada
  sessionId: string;
  tenantId: string;
  userId: string;
  agentId: string;

  // Acción
  category: AuditCategory;    // 'agent' | 'tool' | 'llm' | 'rag' | 'security' | ...
  action: string;             // 'call_end', 'access_denied', ...
  outcome: 'success' | 'failure' | 'blocked' | 'error';
  severity: 'info' | 'warning' | 'critical';

  // Cuerpo variable (según verbosity)
  detail?: { summary?; input?; output?; error?; messages?; fullResponse?; toolCallChain? };
  resource?: { type; id; name? };
  metrics?: { durationMs?; tokensInput?; tokensOutput?; estimatedCostUsd? };
  security?: { aclDecision?; fieldsMasked?; injectionDetected?; riskLevel? };

  _integrityHash?: string;    // SHA-256 de los campos inmutables (anti-tamper)
}
```

La correlación por `requestId` / `sessionId` permite reconstruir la traza completa de una conversación o de un único request.

---

## 2. Activación

La auditoría es **opt-in**: por defecto (`audit.enabled: false`) el Orchestrator no construye ningún logger ni captura nada — comportamiento idéntico al previo a la auditoría.

### 2.1 Por configuración JSON

`agent349.config.json`:

```jsonc
{
  "audit": {
    "enabled": true,
    "verbosity": "standard",
    "verbosityOverrides": { "security": "verbose", "memory": "minimal" },
    "buffer": { "maxSize": 100, "flushIntervalMs": 5000 },
    "retention": { "default": 90, "security": 365 },
    "sensitiveData": {
      "enabled": true,
      "globalRedactFields": ["password", "token", "apiKey", "secret", "ssn"]
    },
    "store": { "type": "memory" }
  }
}
```

```typescript
import { Orchestrator } from 'agent349';

const orch = await Orchestrator.create('./agent349.config.json');
// orch.audit ya está activo y capturando.
```

Los secretos (`uri`, etc.) se referencian con `${ENV_VAR}` y se resuelven en runtime. Nunca hardcodear secrets en el JSON.

### 2.2 Por objeto de configuración

Mismo esquema, sin archivo:

```typescript
import { Orchestrator, ConfigLoader } from 'agent349';

const config = ConfigLoader.from({
  audit: {
    enabled: true,
    verbosity: 'standard',
    store: { type: 'memory' },
  },
}).get();

const orch = await Orchestrator.fromConfig(config);
```

### 2.3 Por código (inyección de adaptadores)

Dos niveles de override, en orden de prioridad:

```typescript
import { Orchestrator, AuditLogger, InMemoryAuditStore } from 'agent349';

// (a) Inyectar sólo el store; el Orchestrator construye el AuditLogger.
const store = new InMemoryAuditStore();
const orch = await Orchestrator.fromConfig(config, { auditStore: store });

// (b) Inyectar el AuditLogger completo (p. ej. con customPatterns de regex).
const logger = new AuditLogger(store, orch.events, {
  verbosity: 'verbose',
  sensitiveData: {
    enabled: true,
    customPatterns: [{ name: 'iban', pattern: /[A-Z]{2}\d{2}[A-Z0-9]{10,30}/g, replacement: '[IBAN]' }],
  },
});
const orch2 = await Orchestrator.fromConfig(config, { auditLogger: logger });
```

> **Propiedad del ciclo de vida.** Los stores **creados desde config** son "owned" y se cierran en `orch.shutdown()`. Los stores/loggers **inyectados** (`auditStore` / `auditLogger`) son responsabilidad del caller: cerrarlos a mano.
>
> **`customPatterns` (regex)** no son representables en JSON; sólo se configuran por código vía `auditLogger`.

---

## 3. Stores

El Orchestrator depende sólo de la abstracción `AuditStoreAdapter`. El backend se elige con `audit.store.type`.

### 3.1 `memory` (dev / test)

```jsonc
{ "audit": { "store": { "type": "memory" } } }
```

`InMemoryAuditStore` — no persiste, se pierde al terminar el proceso. Ideal para tests offline. Soporta toda la API de query/aggregate/retention.

### 3.2 `mongo` (producción)

Requiere `npm install mongodb` (dependencia opcional).

```jsonc
{
  "audit": {
    "enabled": true,
    "store": {
      "type": "mongo",
      "uri": "${MONGO_URI}",
      "database": "agent349",
      "collection": "audit_records",
      "retentionDays": 365,
      "writeConcern": "majority"
    }
  }
}
```

| Campo | Default | Descripción |
|---|---|---|
| `uri` | — (requerido) | URI de conexión MongoDB |
| `database` | — (requerido) | Base de datos |
| `collection` | `audit_records` | Colección |
| `retentionDays` | (sin TTL) | Días tras los que MongoDB expira el documento automáticamente |
| `writeConcern` | `majority` | Durabilidad de los inserts (compliance-grade) |

#### Crear el store por código

```typescript
import { MongoAuditStore } from 'agent349';

const store = await MongoAuditStore.create({
  uri: process.env.MONGO_URI!,
  database: 'agent349',
  collection: 'audit_records',
  retentionDays: 365,
});
```

`create()` conecta, **crea todos los índices** y devuelve la instancia lista.

#### Índices creados automáticamente

| Índice | Propósito |
|---|---|
| `{ tenantId: 1, timestamp: -1 }` | Timeline del tenant por recencia (consulta principal) |
| `{ requestId: 1, timestamp: 1 }` | Traza completa de un request (`getByRequestId`) |
| `{ sessionId: 1, timestamp: 1 }` | Timeline de sesión (`getSessionTimeline`) |
| `{ tenantId: 1, category: 1, timestamp: -1 }` | Filtros por categoría |
| `{ tenantId: 1, severity: 1, timestamp: -1 }` | Filtros por severidad |
| `{ tenantId: 1, userId: 1, timestamp: -1 }` | Filtros por usuario |
| `{ timestamp: 1 }` TTL | Expiración automática (sólo si `retentionDays`) |

#### Diseño append-only

`MongoAuditStore` usa **únicamente** `insertMany` (con `{ ordered: false }`), `find`, agregación y `deleteMany` (retención). **Nunca** actualiza un registro → respeta la inmutabilidad. Para defensa en profundidad, desplegar con un usuario de MongoDB **sin privilegio `update`** sobre la colección.

### 3.3 Implementar un store propio

Extender `AuditStoreAdapter` (Postgres, Elasticsearch, etc.). No requiere tocar el core:

```typescript
import { AuditStoreAdapter } from 'agent349';

class PostgresAuditStore extends AuditStoreAdapter {
  readonly name = 'postgres-audit';
  async writeBatch(records) { /* ... */ }
  async query(q) { /* ... */ }
  async getById(id) { /* ... */ }
  async getByRequestId(requestId) { /* ... */ }
  async count(q) { /* ... */ }
  async aggregate(tenantId, range, groupBy) { /* ... */ }
  async deleteOlderThan(date, tenantId?) { /* ... */ }
  async healthCheck() { /* ... */ }
  override async close() { /* cerrar pool */ }
}

const orch = await Orchestrator.fromConfig(config, { auditStore: new PostgresAuditStore() });
```

---

## 4. Verbosity y categorías

### 4.1 Niveles de verbosity

Controla cuánto del bloque `detail` se persiste. Reduce volumen y exposición de datos.

| Nivel | Incluye |
|---|---|
| `minimal` | `summary` |
| `standard` (default) | `summary` + `input` + `output` + `error` (sanitizados) |
| `verbose` | todo lo anterior + `messages` (conversación LLM completa) + `fullResponse` + `toolCallChain` |

Overrides por categoría (`verbosityOverrides`) tienen prioridad sobre el nivel global:

```jsonc
{ "audit": { "verbosity": "standard", "verbosityOverrides": { "security": "verbose" } } }
```

### 4.2 Categorías y eventos

| Categoría | Acciones típicas | Evento de origen | Captura automática |
|---|---|---|---|
| `agent` | `loop_start`, `loop_end` | `agent.loop.*` | sí |
| `llm` | `call_start`, `call_end`, `call_error`, `fallback` | `llm.call.*`, `llm.fallback` | sí |
| `tool` | `call_start`, `call_end`, `call_error` | `tool.call.*` | sí |
| `skill` | `skill_activated` | `skill.activated` | sí (por run) |
| `rag` | `search_complete` | `rag.pipeline.complete` | sí |
| `security` | `access_denied`, `injection_detected`, `rate_limit_hit`, `field_masked` | `security.*` | sí, **si el chain tiene EventBus** (§4.3) |
| `session` | `session_created`, `session_closed` | `session.*` | sí (sesiones creadas por el SDK) |
| `memory` | `compression` | `memory.compress` | sí |
| `system` | `token_usage`, `config_changed` | `tokens.recorded`, manual | parcial |

La conversión evento → registro la hace el `EventCollector`. Los campos de correlación (`tenantId`, `userId`, etc.) se leen de `data._context`, que el SDK inyecta automáticamente en cada evento emitido durante un `run()`.

### 4.3 Capturar eventos de seguridad

Los middlewares de seguridad **describen** sus eventos (`security.acl.denied`, `security.injection.detected`, `security.ratelimit.hit`, `security.field.masked`) y el `SecurityMiddlewareChain` los **emite** — pero sólo si lo construiste con el EventBus. Para que la auditoría/logging los capture, pasá `orch.events` al crear el chain:

```typescript
import { SecurityMiddlewareChain, ToolACLMiddleware, FieldMaskMiddleware } from 'agent349';

const chain = new SecurityMiddlewareChain(orch.events); // ← EventBus
chain.use(new ToolACLMiddleware(aclService));
chain.use(new FieldMaskMiddleware(fieldMasker));
orch.registerSecurityChain(chain);
```

Sin EventBus el chain sigue funcionando (bloquea/enmascara) pero no emite eventos, así que esas acciones no quedan auditadas automáticamente. Los eventos llevan el `_context` del request para correlación. Las sesiones creadas por el SDK y las skills activadas por el `AgentLoop` se emiten automáticamente, sin configuración extra.

---

## 5. Consultas

```typescript
const audit = orch.audit!; // undefined si audit.enabled = false
const range = { from: new Date('2026-01-01'), to: new Date('2026-02-01') };
```

### Query con filtros y paginación

```typescript
const result = await audit.query({
  tenantId: 'acme',
  category: ['tool', 'security'],   // string o array
  outcome: 'blocked',
  severity: ['warning', 'critical'],
  dateRange: range,                 // requerido
  searchText: 'transfer',           // busca en summary, error, action
  sortBy: 'timestamp',              // 'timestamp' | 'severity'
  sortOrder: 'desc',
  limit: 50,                        // máx 1000
  offset: 0,
});

console.log(result.total, result.hasMore);
for (const r of result.records) console.log(r.category, r.action, r.outcome);
```

### Lookups de correlación

```typescript
const record   = await audit.getById('uuid');
const trace    = await audit.getByRequestId('req-123');   // traza completa, cronológica
const timeline = await audit.getSessionTimeline('sess-1'); // toda la sesión
```

---

## 6. Estadísticas

```typescript
const stats = await audit.getStats('acme', range);
```

```typescript
interface AuditStats {
  totalRecords: number;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
  bySeverity: Record<string, number>;
  byUser: { userId: string; count: number; tokens: number }[];
  byAgent: { agentId: string; count: number; tokens: number }[];
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number;
  avgResponseTimeMs: number;   // promedio de duración de los loops del agente
  securityIncidents: number;   // registros de categoría 'security'
}
```

Las métricas de tokens y costo salen del bloque `metrics` de los registros `llm`. `avgResponseTimeMs` se calcula desde la duración de los registros `agent` (loop end).

---

## 7. Exportación

Para entregas de compliance o forwarding a SIEM:

```typescript
await audit.exportJSON({ tenantId: 'acme', dateRange: range }, './audit-acme.json');
await audit.exportCSV({ tenantId: 'acme', dateRange: range }, './audit-acme.csv');

// SIEM: 'cef' | 'leef' | 'json'
await audit.exportSIEM({ tenantId: 'acme', dateRange: range }, 'cef', './audit-acme.cef');
```

Cada export devuelve `ExportResult` con `recordsExported`, `filePath`, `fileSizeBytes`, `format`, `durationMs`. Exporta hasta 1000 registros por llamada; para volúmenes mayores, paginar por rango de fechas.

### 7.1 Forwarding a SIEM en vivo

A diferencia del export a archivo (puntual), el **forwarding** envía cada batch al SIEM a medida que ocurre. Se dispara después de que el batch se escribe de forma durable en el store; un fallo de envío **nunca** rompe ni bloquea la auditoría (se reintenta en el siguiente flush sólo si el store falla, no por el SIEM).

Activación por configuración:

```jsonc
{
  "audit": {
    "enabled": true,
    "siem": {
      "type": "webhook",            // 'none' (default) | 'webhook'
      "url": "${SIEM_URL}",
      "format": "cef",              // 'json' (default) | 'cef' | 'leef'
      "headers": { "authorization": "Bearer ${SIEM_TOKEN}" },
      "timeoutMs": 10000
    }
  }
}
```

`WebhookSIEMForwarder` hace `POST` con `application/json` (array) o `text/plain` (CEF/LEEF, una línea por registro). Una respuesta no-2xx o un error de red marca el batch como fallido en `ForwardResult` sin lanzar.

Forwarder propio (Splunk HEC, syslog, Kafka…): extender `SIEMForwarder` e inyectarlo:

```typescript
import { SIEMForwarder, type ForwardResult } from 'agent349';

class SplunkForwarder extends SIEMForwarder {
  readonly name = 'splunk';
  async forward(records): Promise<ForwardResult> { /* ... */ return { sent: records.length, failed: 0 }; }
  override async close() { /* cerrar conexiones */ }
}

const orch = await Orchestrator.fromConfig(config, { siemForwarder: new SplunkForwarder() });
```

El forwarder se cierra automáticamente en `orch.shutdown()` (vía `stopAutoCapture`), tras el flush final.

---

## 8. Retención

```typescript
const result = await audit.applyRetention();
// { recordsDeleted, recordsArchived, spaceFreedMb, duration }
```

Borra registros más viejos que `retention.default` (días). Complementa el **TTL index** de MongoDB:

- **TTL index** (`retentionDays`): limpieza pasiva, la hace MongoDB.
- **`applyRetention()`**: barrido explícito por política, invocado por la app (p. ej. en un cron).

Usar ambos según la política de la organización. La retención por severidad/categoría más larga (p. ej. `security: 365`) es declarable en config y prevista para crecer.

---

## 9. Seguridad y privacidad

### 9.1 Redacción de datos sensibles

`SensitiveDataGuard` se aplica **antes** de que cualquier registro llegue al store. Dos estrategias combinadas:

1. **Por nombre de campo** (`globalRedactFields`): cualquier clave que coincida se reemplaza por `[REDACTED]`.
2. **Por patrón** (built-in + `customPatterns`): email, tarjeta, SSN, teléfono, API keys, JWT, IP. `customPatterns` (regex) sólo por código.

```jsonc
{ "audit": { "sensitiveData": {
  "enabled": true,
  "globalRedactFields": ["password", "token", "apiKey", "secret", "ssn"]
}}}
```

Sólo se sanitizan los campos mutables (`detail`, `metrics`). Los campos de identidad/correlación quedan intactos para que el hash de integridad siga siendo válido.

### 9.2 Integridad (anti-tamper)

Cada registro lleva `_integrityHash` (SHA-256 sobre los campos inmutables: `id`, `timestamp`, `requestId`, `tenantId`, `userId`, `category`, `action`, `outcome`). Se calcula **antes** de la redacción (cubre identidad, no el detalle redactado). Verificación:

```typescript
import { IntegrityHash } from 'agent349';
const ok = new IntegrityHash().verify(record);
```

### 9.3 Recomendaciones de despliegue

- **MongoDB:** usuario sin privilegio `update` sobre la colección (refuerza inmutabilidad). `writeConcern: 'majority'`. Cifrado en reposo a nivel de motor/volumen.
- **Verbosity en prod:** evitar `verbose` salvo en categorías concretas (persiste conversaciones LLM completas). Mantener redacción siempre activa.
- **Separación de planos:** los logs técnicos pueden contener PII en dev; el store de auditoría **nunca** debe recibir datos sin redactar.

---

## 9.bis. Contenido multimodal, archivos y batch

**Ningún binario entra al audit store.** Los bloques media se reducen a sus
metadatos (modalidad, tipo MIME, tamaño, nombre) antes de llegar al plano de
auditoría, así que `SensitiveDataGuard` nunca tiene que recorrer megabytes de
base64 y el store nunca guarda un documento.

Eventos nuevos capturados en la categoría `llm`:

| Evento | Detalle |
|---|---|
| `llm.file.uploaded` | `{ provider, providerType, fileId, mimeType, byteLength, expiresAt }` |
| `llm.file.deleted` | `{ provider, fileId }` |
| `llm.batch.submitted` | `{ jobId, provider, model, requests, executionMode: 'batch' }` |
| `llm.batch.status` | `{ jobId, status, counts }` |
| `llm.batch.completed` | `{ jobId, succeeded, failed }` |
| `llm.batch.cancelled` | `{ jobId, provider }` |

`llm.call.start` incorpora `media[]` con esos mismos metadatos derivados, y
`llm.call.end` puede traer el desglose de tokens por modalidad cuando el
proveedor lo reporta.

Para trazar un documento concreto, auditá **tu** identificador: el `customId` de
un batch, o el `fileId` de una referencia. El contenido queda en tu sistema, no
en el audit trail.

---

## 10. Apagado correcto

Los registros se escriben en batches a través de un **buffer asíncrono** (`AuditWriteBuffer`) para no bloquear el loop del agente. Un crash puede perder lo no flusheado.

```typescript
// En SIGTERM / SIGINT de la aplicación:
await orch.shutdown();
```

`orch.shutdown()` ejecuta, en orden:

1. `stopAutoCapture()` — corta la captura y hace **flush final** del buffer.
2. Cierra el **store de auditoría owned** (p. ej. el `MongoClient`).
3. Cierra los demás storage adapters.

Es idempotente. Si se inyectó el store/logger, cerrarlo a mano además del shutdown. Para forzar persistencia en cualquier momento: `await orch.audit!.flush()`.

---

## 11. Recetas completas

### 11.1 Dev — memoria, consulta de traza

Ver `examples/audit-basic.ts`.

### 11.2 Producción — MongoDB + export

Ver `examples/audit-mongo.ts` (activación por JSON, por objeto y por inyección).

### 11.3 Dashboard de consumo por tenant

```typescript
const stats = await orch.audit!.getStats(tenantId, { from, to });
return {
  requests: stats.byCategory['agent'] ?? 0,
  costUsd: stats.totalCostUsd,
  tokens: stats.totalTokensInput + stats.totalTokensOutput,
  topAgents: stats.byAgent.slice(0, 5),
  incidents: stats.securityIncidents,
};
```

---

## 12. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `orch.audit` es `undefined` | `audit.enabled` no es `true` | Activarlo en config |
| `MongoAuditStore requires mongodb` | Falta el paquete opcional | `npm install mongodb` |
| Consultas vacías tras emitir eventos | Registros aún en el buffer | `await orch.audit!.flush()` |
| `ConfigError: audit.store.uri is required` | Store mongo sin `uri`/`database` | Completar la config del store |
| Registros perdidos tras un kill -9 | Buffer no flusheado | Reducir `flushIntervalMs`, manejar SIGTERM con `shutdown()`, `writeConcern: 'majority'` |
| PII visible en registros | Redacción desactivada o campo no listado | `sensitiveData.enabled: true` + agregar a `globalRedactFields` |
| Crecimiento descontrolado en Mongo | Sin retención | Configurar `retentionDays` (TTL) y/o cron con `applyRetention()` |
| Performance de consulta degradada | Falta de índice para el filtro | Los índices cubren los patrones soportados; evitar `searchText` sobre rangos enormes |

---

## 13. Referencia rápida de API

```typescript
// Acceso
orch.audit: AuditLogger | undefined

// Escritura (normalmente automática)
audit.log(partial): Promise<string>
audit.logSecurity(action, context, detail?): Promise<string>
audit.flush(): Promise<number>

// Lectura
audit.query(query): Promise<AuditQueryResult>
audit.getById(id): Promise<AuditRecord | null>
audit.getByRequestId(requestId): Promise<AuditRecord[]>
audit.getSessionTimeline(sessionId): Promise<AuditRecord[]>
audit.getStats(tenantId, dateRange): Promise<AuditStats>

// Export / retención
audit.exportJSON(query, path) / exportCSV / exportSIEM(query, format, path)
audit.applyRetention(): Promise<RetentionResult>

// Ciclo de vida (gestionado por el Orchestrator)
audit.startAutoCapture() / stopAutoCapture()

// Stores
new InMemoryAuditStore()
MongoAuditStore.create(config): Promise<MongoAuditStore>
createAuditStore(config): Promise<AuditStoreAdapter>

// SIEM forwarding
new WebhookSIEMForwarder({ url, format?, headers?, timeoutMs? })
class MyForwarder extends SIEMForwarder { forward(records) {} }
createSIEMForwarder(config): SIEMForwarder | undefined
```
