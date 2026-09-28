# Logging Técnico — Guía de Uso

> Observabilidad técnica de Agent349: el plano efímero para desarrollo y SRE

---

## 1. Qué es (y qué no es)

El logging técnico es uno de los **tres planos de observabilidad** de Agent349, alimentados todos por el EventBus:

| Plano | Propósito | Persistencia | Manual |
|---|---|---|---|
| **Log técnico** | Debugging, observabilidad | Efímero | **este** |
| Auditoría funcional | Compliance, "quién hizo qué" | Inmutable | `AUDIT_MANUAL.md` |
| Métricas de consumo | Billing, quotas | Agregable | (TokenTracker) |

El logging **no** reemplaza a la auditoría: es para diagnóstico en vivo, no para el registro legal de acciones.

**El SDK es silencioso por defecto.** No imprime nada a stdout salvo que actives un adapter explícitamente.

---

## 2. Arquitectura

```
EventBus  ──('*')──►  LogCollector  ──►  LoggerAdapter
                       (clasifica          ├─ NoopLoggerAdapter  (default, silencioso)
                        nivel + filtra)    ├─ ConsoleLoggerAdapter
                                           └─ <tu adapter>  (pino, winston, Loki…)
```

El `LogCollector` se suscribe a todos los eventos, los clasifica a un nivel (`debug`/`info`/`warn`/`error`), descarta los que estén por debajo del mínimo configurado, extrae el `_context` de correlación y reenvía un `LogEntry` estructurado al adapter.

---

## 3. Activación

### 3.1 Consola desde JSON

```jsonc
{
  "logging": {
    "adapter": "console",     // 'noop' (default) | 'console'
    "level": "info",          // 'debug' | 'info' | 'warn' | 'error'
    "format": "json",         // 'json' (default) | 'pretty'
    "includeData": true,      // incluir el payload del evento en entry.data
    "redactFields": ["password", "token", "apiKey"]
  }
}
```

```typescript
const orch = await Orchestrator.create('./agent349.config.json');
```

### 3.2 Inyección de un sink propio

Tiene prioridad sobre `logging.adapter`. Útil para pino, winston, Loki, OpenTelemetry, etc.

```typescript
import { Orchestrator, LoggerAdapter, type LogEntry } from 'agent349';

class PinoLogger extends LoggerAdapter {
  readonly name = 'pino';
  constructor(private readonly pino: import('pino').Logger) { super(); }
  log(entry: LogEntry): void {
    this.pino[entry.level]({ event: entry.event, ...entry.context, ...entry.data }, entry.message);
  }
}

const orch = await Orchestrator.fromConfig(config, { logger: new PinoLogger(pino()) });
```

> El método `log()` es **síncrono y no debe lanzar**: corre en el hot path del EventBus. Para backends remotos, bufferear internamente y flushear async. El `LogCollector` igualmente protege el dispatch ante un logger que falle.

---

## 4. `LogEntry`

```typescript
interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;        // por defecto, el nombre del evento
  timestamp: Date;
  event?: string;         // evento del EventBus de origen
  context?: { tenantId?; userId?; agentId?; sessionId?; requestId? };
  data?: Record<string, unknown>;  // payload (sin _context), opcionalmente redactado
}
```

---

## 5. Clasificación de niveles (default)

| Patrón de evento | Nivel |
|---|---|
| `*.error`, `*fail*` | `error` |
| `security.*` | `warn` |
| `*.start`, `*.end`, `*progress*`, `*chunk*` | `debug` |
| resto | `info` |

Override con la función `classify` al construir un `LogCollector` propio:

```typescript
import { LogCollector } from 'agent349';
new LogCollector(orch.events, logger, {
  level: 'debug',
  classify: (event) => (event.startsWith('approval.') ? 'warn' : 'info'),
}).start();
```

---

## 6. Privacidad

- `redactFields` reemplaza por `[REDACTED]` cualquier campo con ese nombre, en profundidad, antes de loguear.
- Los logs técnicos pueden contener PII en desarrollo; **no** los uses como rastro de auditoría persistente — para eso está el plano de auditoría con su `SensitiveDataGuard`.
- `includeData: false` excluye por completo el payload del evento si sólo te interesan nombre + contexto.

---

## 6.bis. Contenido multimodal

Ni binarios, ni base64, ni documentos, ni imágenes llegan nunca al plano de
logging. De los adjuntos sólo se emiten **metadatos derivados**:

```jsonc
// llm.call.start
{ "iteration": 1, "model": "gemini-3.8-flash",
  "media": [{ "kind": "document", "source": "path",
              "mimeType": "application/pdf", "fileName": "factura.pdf" }] }
```

Eventos relacionados: `llm.file.uploaded` / `llm.file.deleted`
(`{ provider, fileId, mimeType, byteLength, expiresAt }`),
`memory.media.omitted` (`{ sessionId, omitted[] }`) y la familia
`llm.batch.*` (`{ jobId, status, counts }`). Ninguno transporta contenido.

---

## 7. Apagado

`orch.shutdown()` detiene el `LogCollector` (quita la suscripción del EventBus) como primer paso, antes de cerrar auditoría y adapters. Idempotente.

---

## 8. Referencia rápida

```typescript
// Adapters
new NoopLoggerAdapter()                              // default, silencioso
new ConsoleLoggerAdapter({ format: 'json'|'pretty' })
class MyAdapter extends LoggerAdapter { log(entry) {} }

// Colector (uso avanzado / manual)
new LogCollector(bus, logger, { level, includeData?, redactFields?, classify? })
  .start() / .stop() / .active

// Inyección
Orchestrator.fromConfig(config, { logger: myAdapter })
```

Ejemplo completo: `examples/logging-console.ts`.
