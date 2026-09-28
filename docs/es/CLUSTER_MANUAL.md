# Despliegue Multi-instancia / Clúster — Guía de Uso

> Cómo desplegar Agent349 en varias instancias (pods) sin perder estado ni contabilidad

---

## 1. Por qué importa

Agent349 mantiene **estado** en varias capas: historial de sesión, memoria de largo plazo, registros de sesión, consumo de tokens y auditoría. Si corrés más de una instancia de tu aplicación (réplicas/pods detrás de un balanceador), ese estado **debe vivir en un backend compartido**. Con el backend en memoria (el default), cada pod tiene su propia copia y el sistema se fragmenta.

**Regla de oro:** en clúster, ninguna capa con estado debe usar `type: "memory"`.

---

## 2. Qué pasa si NO compartís el backend

Con el default `memory`, cada pod guarda en su propia RAM. En un clúster:

| Capa | Síntoma con `memory` en clúster |
|---|---|
| **Tokens** | Cada pod cuenta solo su tráfico. `checkLimit()` evalúa la quota **por pod**: un tenant con N pods obtiene ~N× su límite. |
| **Sesión** | Un pod no ve las sesiones creadas por otro. Si el balanceador no tiene afinidad, la conversación se "pierde" entre requests. |
| **Memoria** | El historial y los facts de largo plazo quedan partidos por pod. |
| **Auditoría** | Con `audit.store: memory`, cada pod tiene un trail parcial; las consultas devuelven solo lo de un pod. |

No es una condición de carrera: es **fragmentación total**. Hay que resolverlo antes de escalar.

---

## 3. Configuración recomendada (Mongo compartido)

Definí un backend compartido en `storage.backends` y apuntá todas las capas con estado a él. Las claves están namespaceadas (`token:…`, `session:…`, etc.), así que un solo backend/colección sirve para todas las capas KV.

```jsonc
{
  "storage": {
    "backends": {
      "shared": {
        "type": "mongo",
        "uri": "${MONGO_URI}",
        "database": "agent349",
        "collection": "kv"        // requerido para backends mongo
      }
    }
  },
  "memory": {
    "session":  { "backend": "shared" },
    "longTerm": { "backend": "shared" }
  },
  "session": { "backend": "shared" },
  "tokens":  { "backend": "shared" },

  "audit": {
    "enabled": true,
    "store": {
      "type": "mongo",            // store de auditoría: config aparte (no usa storage.backends)
      "uri": "${MONGO_URI}",
      "database": "agent349",
      "collection": "audit_records",
      "retentionDays": 365,
      "writeConcern": "majority"
    }
  }
}
```

Con Redis es equivalente:

```jsonc
{ "storage": { "backends": { "shared": { "type": "redis", "url": "${REDIS_URL}" } } } }
```

> **`audit.store` es independiente** de `storage.backends`: es otra abstracción (`AuditStoreAdapter`). Configurá Mongo ahí también para que el trail sea global. Ver `AUDIT_MANUAL.md`.

Esto **no requiere código**, solo configuración. Resuelve la fragmentación (el problema grande del clúster).

---

## 4. Concurrencia: qué queda después de compartir el backend

Compartir el backend resuelve la fragmentación, pero "persistente" no significa "atómico". El `TokenTracker` registra consumo con un patrón **read-modify-write** en el cliente:

```
get(bucket) → [...existing, record] → set(bucket)
```

Esto deja **dos ventanas** distintas. Es clave no confundirlas:

### Ventana A — sobrescritura de registros (lost update)

Si dos pods escriben el **mismo bucket** (mismo tenant + mismo día) dentro del intervalo `get`→`set` (milisegundos), uno puede pisar al otro y perderse un registro → **subconteo** (nunca sobreconteo).

- La latencia del modelo **no** agranda esta ventana: la llamada al LLM ya terminó antes de `record()`.
- Efecto: error pequeño, siempre a la baja. Tolerable para billing/reportes.

### Ventana B — overshoot de quota (check-then-act)

```
checkLimit() → [ llamada al LLM, varios segundos ] → record(tokens)
```

Entre verificar la quota y registrar el consumo pasa **toda la llamada al modelo**. Como las llamadas LLM son lentas, muchos requests pasan el check antes de que ninguno haya registrado nada.

Ejemplo: 10 req/s con llamadas de 4 s → ~40 requests en vuelo a la vez. Si están cerca del tope, las 40 ya pasaron el check y todas suman consumo → te pasás por hasta ~40 llamadas. **Ningún contador atómico evita esto**, porque los tokens se conocen *después* de la respuesta.

---

## 5. Niveles de enforcement de quota

Elegí según cuán estricto necesites el tope:

| Nivel | Cómo | Garantía |
|---|---|---|
| **Blando** (default) | `checkLimit()` + backend compartido | Cortás apenas detectás exceso; tolerás overshoot de "llamadas en vuelo". Suficiente para la mayoría. |
| **Conteo exacto** | Contador atómico (`$inc` Mongo / `INCRBY` Redis) en vez de read-modify-write | Elimina la Ventana A (sin subconteo) y escala mejor en buckets calientes. **No** elimina la Ventana B. Requiere código (extender la abstracción de storage). |
| **Tope duro** | Reserva previa: estimás tokens, reservás atómico *antes* del LLM, reconciliás después | Acota el overshoot a la *estimación* en vuelo. Máxima complejidad; rara vez necesario. |

> El **corte perfecto es intrínsecamente inalcanzable** con métricas post-hoc: los tokens de salida solo se saben al terminar la llamada. Apuntá al nivel que tu negocio realmente exija.

---

## 6. Notas por componente

- **Tokens / Sesión / Memoria** → backend compartido (§3). Imprescindible.
- **Auditoría** → `audit.store: mongo` para trail global; el `SIEMForwarder` corre por pod y eso está bien (cada pod reenvía sus batches).
- **Logging técnico** → es *stateless*; el adapter `console` por pod es correcto. Para una vista unificada, mandá a un sink central (Loki, etc.) vía un `LoggerAdapter` propio (ver `LOGGING_MANUAL.md`).
- **EventBus** → es **in-process**: no se propaga entre pods. Las suscripciones (`orch.events.on`) ven solo los eventos de su propia instancia. Para fan-out entre instancias, reenviá a un bus externo desde un adapter.

---

## 7. Apagado ordenado (crítico en clúster)

Los pods se reinician y escalan constantemente. La auditoría usa un **buffer en memoria**: un `kill -9` pierde lo no flusheado. Manejá las señales de terminación y llamá a `shutdown()` (hace flush final de auditoría, cierra el forwarder y los adaptadores):

```typescript
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void orch.shutdown().finally(() => process.exit(0));
  });
}
```

Configurá el `terminationGracePeriodSeconds` (Kubernetes) con margen suficiente para que el flush complete. Reforzá la durabilidad con `audit.store.writeConcern: "majority"` y un `buffer.flushIntervalMs` razonable.

---

## 8. Checklist de despliegue

- [ ] `tokens.backend`, `session.backend`, `memory.session.backend`, `memory.longTerm.backend` → backend **compartido** (no `memory`).
- [ ] `audit.store` → `mongo` (no `memory`) si querés trail global.
- [ ] Secrets (`uri`/`url`) por `${ENV_VAR}`, nunca hardcodeados.
- [ ] Manejo de `SIGTERM`/`SIGINT` con `orch.shutdown()` y grace period adecuado.
- [ ] Definir el nivel de enforcement de quota (blando / conteo exacto / tope duro) según el requisito real.
- [ ] (Opcional) Logging técnico a un sink central si necesitás vista unificada.

---

Manuales relacionados: `TOKENS_MANUAL.md` (consumo y quotas), `AUDIT_MANUAL.md` (store Mongo y SIEM), `LOGGING_MANUAL.md`, `MEMORY_MANUAL.md`.
