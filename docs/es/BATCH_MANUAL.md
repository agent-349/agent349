# Manual de Batch — Agent349

Procesamiento asíncrono masivo: miles o decenas de miles de peticiones enviadas
como un trabajo, con resultados que llegan horas después.

Para entradas multimodales y salidas estructuradas — que batch reutiliza tal
cual — ver `MULTIMODAL_MANUAL.md`.

---

## 1. Cuándo usar batch

Batch **no** es una llamada normal más rápida ni más barata para el mismo caso.
Es un ciclo de vida distinto:

| | Llamada normal | Batch |
|---|---|---|
| Respuesta | inmediata | horas (hasta 24 h) |
| Streaming | sí | no |
| Circuit breaker | sí | no aplica: un job no es una llamada |
| Memoria de sesión / agent loop | sí | no |
| Coste | tarifa síncrona | tarifa de batch del modelo |
| Unidad | una petición | N peticiones correlacionadas |

Las dos vías coexisten y **la elección es siempre de la aplicación**: Agent349
nunca promociona una petición a batch por volumen ni por ningún otro criterio.

- **Una factura, o unas pocas** → `complete()`: petición → respuesta, con el JSON
  estructurado en el acto.
- **Decenas de miles de documentos** → `submitBatch()` → `jobId` → polling →
  resultados.

Ambas comparten exactamente las mismas abstracciones: bloques de contenido,
modelo, prompt, `responseFormat`, `providerOptions` y la normalización de la
respuesta. Sólo cambia el lifecycle.

---

## 2. El ciclo completo

```typescript
import { documentFromPath, text } from 'agent349';

// 1. Enviar
const job = await orchestrator.submitBatch(
  facturas.map((f) => ({
    customId: f.id,                       // tu identificador, estable
    request: {
      model: 'gemini-3.8-flash',
      systemPrompt: 'Extraé los datos de la factura.',
      messages: [{ role: 'user', content: [text('Extraé los datos.'), documentFromPath(f.path)] }],
      responseFormat: { type: 'json_schema', schema: facturaSchema },
      fileHandling: 'upload',             // recomendado para lotes grandes
    },
  })),
  context,
  'gemini',
  { displayName: 'facturas-2026-03' },
);

await db.guardarJobId(job.jobId);         // persistí esto y nada más

// 2. Consultar, cuando y como quiera la aplicación
const estado = await orchestrator.getBatch(await db.leerJobId(), context);

// 3. Recoger, cuando esté completo
if (estado.status === 'completed') {
  for await (const item of orchestrator.streamBatchResults(estado.jobId, context)) {
    if (item.response) {
      await db.guardarExtraccion(item.customId, item.response.structured?.value);
    } else {
      await db.marcarParaReproceso(item.customId, item.error!.message);
    }
  }
}
```

---

## 3. Polling: la cadencia es tuya

**El SDK no crea timers, ni schedulers, ni hace polling automático.** Eso es
deliberado:

- la frecuencia adecuada depende del volumen y del SLA de tu aplicación;
- un timer dentro del SDK sobreviviría mal a un reinicio y competiría con el
  scheduler que tu aplicación ya tiene;
- la convención del proyecto prohíbe `setTimeout` suelto para scheduling.

La aplicación persiste el `jobId` y **con eso sólo** puede reiniciarse y seguir
consultando. No hace falta guardar nada más: la correlación viaja en los
resultados (§4).

No hay webhooks en esta versión. Varios proveedores los ofrecen, pero
requerirían que la aplicación expusiera una URL pública. Puede incorporarse más
adelante como capacidad adicional.

---

## 4. Correlación: `customId`

Cada petición lleva un `customId` que vuelve en su resultado.

Esto **no** es cosmético: ningún proveedor garantiza el orden de entrega, y
OpenAI lo dice explícitamente. Correlacionar por posición sería un error latente.

```typescript
for await (const item of orchestrator.streamBatchResults(jobId, context)) {
  const documento = await db.buscarPorId(item.customId);   // ← siempre por id
}
```

Restricciones prácticas: mantené el `customId` corto y alfanumérico (Anthropic
acepta `^[a-zA-Z0-9_-]{1,64}$`). El id de tu documento suele servir tal cual.

---

## 5. Resultados progresivos

`streamBatchResults()` devuelve un `AsyncIterable`, no un array:

```typescript
for await (const item of orchestrator.streamBatchResults(jobId, context)) { … }
```

Un lote de 50 000 documentos no cabe cómodamente en memoria. Cada provider lee
su formato de resultados de forma incremental (JSONL en streaming en Anthropic,
un fichero descargado y leído línea a línea en Gemini y OpenAI), de modo que el
consumo de memoria es plano sea cual sea el tamaño del trabajo.

### Éxito y error por ítem

Un job puede terminar `completed` con documentos fallidos dentro. Eso es normal
y esperado:

```typescript
interface BatchResultItem {
  customId: string;
  response?: LLMResponse;                       // éxito individual
  error?: { message: string; code?: string };   // error individual
}
```

Exactamente uno de los dos está presente. Así podés reprocesar **sólo** los
fallidos, sin repetir el lote entero.

---

## 6. Estados

`BatchJobStatus` normaliza los vocabularios de cada proveedor:

| Normalizado | Gemini | OpenAI | Claude |
|---|---|---|---|
| `queued` | `JOB_STATE_PENDING` | `validating` | `in_progress` (sin resultados) |
| `running` | `JOB_STATE_RUNNING` | `in_progress`, `finalizing` | `in_progress` |
| `completed` | `JOB_STATE_SUCCEEDED` | `completed` | `ended` |
| `failed` | `JOB_STATE_FAILED` | `failed` | — (el error es por ítem) |
| `cancelled` | `JOB_STATE_CANCELLED` | `cancelling`, `cancelled` | `canceling` |
| `expired` | `JOB_STATE_EXPIRED` | `expired` | `ended` + ítem `expired` |

`BatchJob.counts` trae el desglose (`total`, `succeeded`, `failed`, `cancelled`,
`expired`) cuando el proveedor lo reporta.

```typescript
await orchestrator.cancelBatch(jobId, context);   // donde el proveedor lo permita
```

---

## 7. Costo

**No existe un `batchDiscount` universal.** Que hoy tres proveedores facturen el
batch al 50 % es un hecho de sus listas de precios, no una propiedad de la
abstracción. El precio depende de proveedor, modelo y modo de ejecución:

```json
{
  "llm": {
    "providers": {
      "gemini": {
        "type": "gemini",
        "apiKey": "${GEMINI_API_KEY}",
        "pricing": {
          "gemini-3.8-flash": {
            "input": 0.00075,
            "output": 0.00375,
            "batchInput": 0.000375,
            "batchOutput": 0.001875
          }
        }
      }
    }
  }
}
```

Un modelo sin tarifas de batch declaradas factura a las síncronas: el SDK nunca
aplica un descuento que nadie declaró.

El consumo se registra en el `TokenTracker` **al recoger cada resultado**, no al
enviar: en el envío todavía no se conocen los tokens. Los registros llevan
`executionMode: 'batch'` para poder segmentarlos.

---

## 8. Contenido y archivos en lotes grandes

Para lotes voluminosos, `fileHandling: 'upload'` (o `'auto'`) es lo recomendado:
el documento viaja una vez al almacén del proveedor y el lote sólo lleva
referencias. Con `'inline'`, cada documento se codifica dentro del propio lote y
se choca antes con los límites de tamaño del trabajo.

Recordá que las referencias expiran (48 h en Gemini): para un job que puede
tardar 24 h, verificá el margen o subí los archivos justo antes de enviar.

---

## 9. Observabilidad

| Evento | Cuándo |
|---|---|
| `llm.batch.submitted` | `{ jobId, provider, providerType, model, requests, executionMode }` |
| `llm.batch.status` | en cada `getBatch()`: `{ jobId, status, counts }` |
| `llm.batch.completed` | al terminar de recorrer los resultados: `{ jobId, succeeded, failed }` |
| `llm.batch.cancelled` | `{ jobId, provider }` |

Como en el resto del SDK, **nunca** se registran binarios ni contenido de
documentos: sólo identificadores, conteos y metadatos.

El circuit breaker **no** interviene: protege llamadas síncronas y no tiene
semántica sobre un trabajo que dura horas. Un fallo al enviar es un
`ProviderError` normal.

---

## 10. Soporte por proveedor

| Provider | Batch | Transporte | Notas |
|---|---|---|---|
| **Gemini** | ✅ | fichero JSONL (Files API) | El SDK usa el formato de fichero — y no el envío inline — porque lleva un `key` por línea: eso es lo que hace que el `customId` sobreviva a un reinicio |
| **Claude** | ✅ | inline (`requests[]`) | Resultados en JSONL por streaming. Máx. 100 000 peticiones / 256 MB |
| **OpenAI** | ✅ | fichero JSONL (`purpose: 'batch'`) | Ventana de 24 h; salida y errores en ficheros separados, ambos leídos por línea |
| **openai-compatible** | ❌ | — | Declarable por config si tu endpoint lo implementa |
| **Ollama** | ❌ | — | — |

Gemini ejecuta el batch sobre `generateContent` (su Batch API no admite la
Interactions API). El provider lo maneja internamente; el detalle sólo asoma en
un punto: una opción específica de Interactions (`serviceTier`, `labels`) usada
en un batch produce un error explícito en vez de desaparecer.

---

## 11. Errores

| Situación | Resultado |
|---|---|
| Provider sin batch | `UnsupportedCapabilityError` con `capability: 'batch'` |
| Lote vacío | `UnsupportedCapabilityError` |
| Petición sin modelo y sin default | `UnsupportedCapabilityError` |
| Opción no admitida por la superficie de batch | `UnsupportedCapabilityError` nombrando la opción |
| Fallo de la API al enviar o consultar | `ProviderError` con `statusCode` |
| Documento individual fallido | **no** es una excepción: llega como `item.error` |

---

## 12. Limitaciones conocidas

- Sin webhooks: sólo polling (§3).
- El SDK no persiste jobs; el `jobId` es de la aplicación.
- Sin reintento automático de ítems fallidos: la aplicación decide qué
  reprocesar, que es justamente para lo que sirve el `customId`.
- Sin batch en `openai-compatible` ni Ollama.
- Los resultados caducan según cada proveedor (6 semanas en Gemini, 29 días en
  Anthropic): descargalos antes.
