# Manual Multimodal — Agent349

Entradas que no son texto (imágenes, PDF, documentos, audio, vídeo), archivos,
salidas estructuradas y capacidades específicas de cada proveedor.

Para el procesamiento asíncrono masivo, ver `BATCH_MANUAL.md`.

---

## 1. Introducción

Un mensaje ya no es forzosamente una cadena. Puede llevar **bloques de
contenido**: texto, una imagen, un PDF. El SDK traduce cada bloque al formato
nativo del proveedor y decide cómo viaja — inline, subido a su almacén de
archivos, o referenciado — sin que la aplicación tenga que saberlo.

```typescript
import { documentFromPath, text } from 'agent349';

const response = await orchestrator.chat(
  'extractor',
  [text('Extraé los datos de esta factura.'), documentFromPath('/tmp/factura.pdf')],
  { tenantId: 'acme', userId: 'u1', roles: ['finanzas'] },
  { responseFormat: { type: 'json_schema', schema: facturaSchema } },
);

console.log(response.structured?.value);
```

Dos principios gobiernan todo lo que sigue:

1. **Nada se descarta en silencio.** Si el modelo no acepta PDF, si el proveedor
   no descarga URLs, si no hay soporte nativo de JSON Schema — el SDK lanza
   `UnsupportedCapabilityError` con el motivo. Nunca recorta el prompt y sigue.
2. **La abstracción no es el mínimo común denominador.** Lo que converge entre
   proveedores está normalizado; lo que no, sigue siendo alcanzable (§7).

---

## 2. El modelo de contenido

`LLMMessage.content` es `string | ContentBlock[]`. `ContentBlock` es una unión
discriminada: cada variante declara exactamente los campos que necesita, de modo
que un bloque de texto con origen binario, o un documento sin origen, no se
pueden construir.

| Variante | Campos |
|---|---|
| `text` | `text` |
| `image` / `document` / `audio` / `video` | `source`, `options?` |
| `media_omitted` | `mediaType`, `mimeType`, `reason`, … (§6) |
| `tool_use` | `toolUseId`, `toolName`, `input` |
| `tool_result` | `toolUseId`, `content`, `isError?` |

No construyas bloques a mano: usá los helpers.

```typescript
import {
  text,
  imageFromPath, imageFromBytes, imageFromUrl,
  documentFromPath, documentFromBytes, documentFromUrl,
  fromProviderFile, fromBase64,
} from 'agent349';
```

### Orígenes de contenido

`ContentSource` tiene cinco variantes. Elegí la que ya tenés; el SDK se encarga
del resto.

| Origen | Cuándo | Nota |
|---|---|---|
| `path` | tenés un archivo en disco | el tipo MIME se infiere de la extensión |
| `bytes` | tenés un `Uint8Array`/`Buffer` en memoria | el tipo MIME es obligatorio |
| `url` | el contenido está publicado | **lo descarga el proveedor**, nunca el SDK (§4) |
| `providerFile` | ya lo subiste (§5) | la referencia es del proveedor y puede expirar |
| `base64` | ya te llegó codificado (un upload HTTP, una cola) | interoperabilidad, no la vía normal |

**Base64 no es el concepto central.** Es un detalle de transporte que algunos
proveedores necesitan y que el SDK aplica por su cuenta. La variante `base64`
existe sólo para no obligarte a decodificar contenido que ya recibiste así.

```typescript
// Todos estos producen un bloque equivalente:
documentFromPath('/tmp/factura.pdf');
documentFromBytes(buffer, 'application/pdf', undefined, 'factura.pdf');
documentFromUrl('https://ejemplo.com/factura.pdf');
fromProviderFile(ref);
```

---

## 3. Capacidades

Cada provider declara qué puede hacer. Consultalo antes de construir la petición
si tu aplicación elige proveedor dinámicamente:

```typescript
const caps = orchestrator.capabilities('gemini', 'gemini-3.8-flash');
if (!caps.input.document) { /* usar otro proveedor, o extraer texto primero */ }
```

```typescript
interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  input: { text: true; image: boolean; document: boolean; audio: boolean; video: boolean };
  sources: { url: boolean; providerFile: boolean };
  structuredOutput: 'none' | 'jsonMode' | 'jsonSchema';
  structuredOutputWithTools: boolean;
  files: boolean;
  batch: boolean;
}
```

### Matriz actual

| | Imagen | Documento | Audio/Vídeo | URL | Files | JSON Schema | Schema + tools | Batch |
|---|---|---|---|---|---|---|---|---|
| **Gemini** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Claude** | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenAI** | ✅ | ✅ | ❌ | imagen | ✅ | ✅ | ✅ | ✅ |
| **openai-compatible** | ✅ | ❌ | ❌ | imagen | ❌ | JSON mode | ✅ | ❌ |
| **Ollama** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

Notas:

- **OpenAI**: Chat Completions descarga URLs de imagen, no de documento. Un
  documento por URL lanza error indicando que lo pases como bytes o lo subas.
- **openai-compatible**: el SDK **no puede saber** qué implementa un servidor de
  terceros, así que parte de un mínimo conservador. Declaralo en la config:

  ```json
  {
    "llm": {
      "providers": {
        "vllm": {
          "type": "openai-compatible",
          "baseUrl": "https://vllm.interno/v1",
          "capabilities": { "structuredOutput": "jsonSchema", "input": { "document": true } }
        }
      }
    }
  }
  ```

  Declarar de más convierte un error claro del SDK en un error opaco del
  proveedor. Declará lo que tu endpoint realmente hace.

- **Ollama** declara `structuredOutputWithTools: false`: su comportamiento con
  ambas cosas a la vez depende del modelo y de la versión del servidor, y un
  desajuste silencioso sería peor que un error.

### El router respeta las capacidades

`LLMRouter` no deriva a un fallback incapaz de atender la petición. Si el
primario (con visión) falla y el fallback es sólo texto, se propaga el error del
primario en vez de una respuesta degradada sin la imagen. Para peticiones de
sólo texto no se consulta nada: el camino habitual no paga ningún coste extra.

---

## 4. URLs: el SDK nunca descarga

Una fuente `url` se pasa **tal cual** al proveedor, que la resuelve en su propia
infraestructura. Agent349 no hace peticiones HTTP salientes a destinos que
indica la aplicación: eso abriría SSRF, límites de tamaño, redirecciones y
timeouts en el proceso del SDK.

Si el proveedor no acepta URLs para esa modalidad, obtenés:

```
UnsupportedCapabilityError: Provider 'ollama' does not support 'sources.url':
this provider does not fetch URLs. Pass the content as bytes or a path, or
upload it first and reference the returned file. The SDK never downloads URLs
on your behalf.
```

---

## 5. Archivos

### Transporte: `fileHandling`

Quién decide si el contenido va inline o se sube es el SDK, guiado por una
política explícita por petición:

| Valor | Comportamiento |
|---|---|
| `'inline'` (default) | va con la petición. Predecible y sin efectos colaterales. Si excede el límite del proveedor → error explícito con el límite |
| `'upload'` | siempre sube por la Files API y referencia por id |
| `'auto'` | inline mientras entre; sube cuando no |

`'auto'` no es magia oculta: cada subida emite `llm.file.uploaded` y las
referencias creadas vuelven en `LLMResponse.uploadedFiles` (y en
`AgentResponse.uploadedFiles`) para que las reutilices o las borres.

```typescript
const response = await orchestrator.complete(
  {
    model: 'gemini-3.8-flash',
    systemPrompt: 'Extraé datos.',
    messages: [{ role: 'user', content: [documentFromPath('/tmp/grande.pdf')] }],
    fileHandling: 'auto',
  },
  context,
);

for (const ref of response.uploadedFiles ?? []) {
  await orchestrator.deleteFile(ref.fileId, context);
}
```

### Base64 no aparece salvo que el proveedor lo pida

El SDK materializa el contenido en **la forma que el proveedor realmente usa, y
sólo esa**. Un archivo que se sube por la Files API viaja como binario: nunca se
codifica en base64. Un contenido que ya te llegó codificado y que va inline se
pasa tal cual, sin decodificar. Ambas formas se calculan de manera perezosa y se
memoizan, así que subir un PDF de 50 MB no gasta ~67 MB de string para nada.

El tamaño (`byteLength`), que es lo que se compara contra el límite inline en
cada petición, se deriva aritméticamente y nunca fuerza una decodificación.

---

### Subida explícita

Para reutilizar un documento en varios turnos o varias peticiones, subilo una
vez:

```typescript
const ref = await orchestrator.uploadFile(
  { content: { kind: 'path', path: '/tmp/factura.pdf' }, fileName: 'factura.pdf' },
  context,
);

await orchestrator.chat('extractor', [text('¿Total?'), fromProviderFile(ref)], identity);
await orchestrator.chat('extractor', [text('¿Vencimiento?'), fromProviderFile(ref)], identity);

await orchestrator.deleteFile(ref.fileId, context);
```

### Lo que la abstracción NO hace

Las diferencias entre proveedores aquí son irreconciliables y forzar una
uniformidad sería mentir:

| | Expiración | Cuotas |
|---|---|---|
| **Gemini** | **48 h** | 20 GB/proyecto, 2 GB/archivo |
| **Claude** | hasta borrado | — |
| **OpenAI** | hasta borrado | — |

Por eso:

- **Las referencias no son portables.** Un `fileId` de Gemini usado con Claude
  lanza error explicando que las referencias son de cada proveedor.
- **No hay re-subida automática** ni recolección de expirados. Una referencia
  vencida lanza error antes de llegar al proveedor.
- **No hay almacén propio de Agent349.** El ciclo de vida del archivo es del
  proveedor; el SDK sólo lo expone de forma gobernada.

---

## 6. Persistencia de media en la sesión

Un PDF en base64 son megabytes por turno, contra el límite de 16 MB por
documento de MongoDB y el presupuesto de memoria de Redis. Por defecto **no se
persisten binarios**.

`memory.session.mediaPersistence`:

| Valor | Qué se guarda |
|---|---|
| `'omit'` (default) | el contenido inline se sustituye por un bloque `media_omitted` explícito; **las referencias `providerFile` sí se guardan** (son pequeñas y reutilizables) |
| `'full'` | todo verbatim. Sólo si tu store está dimensionado para eso |

**No hay pérdida silenciosa.** Bajo `'omit'`:

1. El bloque marcador **queda en el historial** y tu aplicación puede verlo.
2. Al reenviar la conversación, el provider lo traduce a una nota explícita para
   el modelo: `[document 'factura.pdf' (application/pdf) is no longer available:
   it was not persisted with the conversation]`.
3. Se emite `memory.media.omitted` en el EventBus.

Una referencia `providerFile` **expirada** se degrada al mismo marcador con
`reason: 'expired'`, en vez de guardarse para fallar de forma confusa en el
siguiente turno.

La misma política se aplica al snapshot de HITL (`messagesSnapshot`), que antes
podía descartarse entero por exceder `maxSnapshotBytes`.

Distinguí los tres conceptos:

- **contenido inline transitorio** — vive lo que dura la petición;
- **referencia persistible** — sobrevive a la sesión, pero puede expirar;
- **contenido omitido** — marcador explícito y trazable.

---

## 7. Capacidades específicas de proveedor

Tres niveles, deliberadamente visibles en los tipos.

### Nivel 1 — portable

Va en `LLMRequest` y funciona en todos los proveedores que lo declaren:
`responseFormat`, `reasoningEffort`, contenido multimodal, `fileHandling`,
`onToken`, `signal`.

### Nivel 2 — específico y tipado

`providerOptions`, indexado por **tipo de adapter** (no por nombre de
instancia), con autocompletado y verificación de TypeScript:

```typescript
await orchestrator.complete(
  {
    model: 'gemini-3.8-flash',
    systemPrompt: '…',
    messages,
    providerOptions: {
      gemini: { thinkingLevel: 'low', mediaResolution: 'high' },
      openai: { seed: 42, serviceTier: 'flex' },
      claude: { topK: 5, thinkingBudgetTokens: 4096 },
    },
  },
  context,
);
```

Cada provider lee sólo su entrada; las demás se ignoran.

### Nivel 3 — escape hatch

Para lo que el SDK todavía no modela. `raw` se mezcla sin validar sobre el
cuerpo nativo:

```typescript
providerOptions: { gemini: { raw: { alguna_opcion_nueva: true } } }
```

Así, una capacidad que Google, Anthropic u OpenAI publiquen mañana es alcanzable
sin esperar una versión del SDK y **sin saltarse Agent349** (con su
gobernanza, auditoría y métricas). Para adaptadores de terceros:
`providerOptions.custom['mi-adapter']`.

Y para leer campos que el SDK no normaliza:

```typescript
const response = await provider.call({ ...request, includeRaw: true });
response.providerRaw; // respuesta cruda; nunca se persiste ni se audita por defecto
```

---

## 8. Structured output

```typescript
interface ResponseFormat {
  type: 'json_schema' | 'json_object';
  name?: string;      // requerido por OpenAI, ignorado por el resto
  schema?: JSONSchema;
  strict?: boolean;   // sólo donde el proveedor lo distingue (OpenAI)
  validate?: boolean; // validación adicional con AJV. Default: false
}
```

Mapeo nativo por proveedor:

| Provider | Mecanismo |
|---|---|
| Gemini | `response_format` con `mime_type: 'application/json'` + `schema` |
| Claude | `output_config.format` |
| OpenAI | `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }` |
| Ollama | `format` (el schema, o `'json'`) |

### Tres hechos, tres campos

El resultado **nunca** confunde qué hizo el proveedor, qué pudo parsear el SDK y
qué llegó a validarse:

```typescript
interface StructuredOutput {
  mode: 'native_schema' | 'native_json' | 'none';  // qué impuso el PROVEEDOR
  parsed: boolean;                                  // ¿el SDK pudo PARSEAR?
  value?: unknown;                                  // sólo si parsed === true
  validation: 'skipped' | 'valid' | 'invalid';      // ¿el SDK VALIDÓ?
  validationErrors?: string[];
  rawText?: string;                                 // cuando parsed === false
}
```

Un JSON bien formado que viola el esquema **no** se reporta como válido: si no
pediste `validate: true`, `validation` es `'skipped'`, no `'valid'`.

```typescript
const response = await orchestrator.complete({ /* … */
  responseFormat: { type: 'json_schema', schema, validate: true },
}, context);

if (response.structured?.validation === 'valid') {
  procesar(response.structured.value);
} else {
  registrar(response.structured?.validationErrors ?? response.structured?.rawText);
}
```

### Con tool calling

Gemini, Claude y OpenAI combinan structured output con tools. Ollama no lo
declara. Si tu provider no lo soporta y pedís ambos, el error dice qué hacer:

```
UnsupportedCapabilityError: … this provider cannot combine structured output
with tool calling in one request. Issue the tool-calling turns first, then
request the structured answer in a separate call without tools.
```

En el bucle de agente, `responseFormat` se aplica en **todas** las iteraciones y
el resultado final llega en `AgentResponse.structured`. Para extracción pura
(un documento → un JSON) suele ser mejor `complete()`: no necesita agente,
skills ni tools.

### Subconjuntos de JSON Schema

Cada proveedor soporta un subconjunto distinto y ninguno acepta esquemas muy
grandes o muy anidados. El SDK **no traduce esquemas** entre dialectos: pasa el
tuyo tal cual. Mantenete en lo común (`type`, `properties`, `required`, `enum`,
`items`, `description`) y probá el esquema contra cada proveedor que vayas a
usar. `validate: true` te protege del resto.

---

## 9. Observabilidad

Ni binarios, ni base64, ni documentos entran en logs ni en auditoría. Lo que sí
obtenés:

| Evento | Datos |
|---|---|
| `llm.call.start` | `media: [{ kind, mimeType, byteLength, source, fileName }]` — conteo, tipo y tamaño, jamás el contenido |
| `llm.call.end` | `usage` (con `inputByModality` / `outputByModality` cuando el proveedor los reporta) |
| `llm.file.uploaded` | `{ provider, fileId, mimeType, byteLength, expiresAt }` |
| `llm.file.deleted` | `{ provider, fileId }` |
| `memory.media.omitted` | `{ sessionId, omitted: [{ mediaType, mimeType, byteLength, reason }] }` |

### Tokens y costo

- **Preflight de cuota**: los bloques media se estiman por modalidad, no por la
  longitud de su base64 (§`TOKENS_MANUAL.md`). Un PDF de 32 KB dejaría de
  estimarse en ~11 000 tokens para estimarse en unos cientos, que es lo que
  realmente factura el proveedor.
- **Tokens de *thinking***: se cuentan como output (misma convención que OpenAI
  con sus tokens de razonamiento) y quedan visibles en
  `performance.reasoningTokens`.
- **Por modalidad**: `usage.inputByModality` cuando el proveedor lo entrega
  (Gemini lo hace).

---

## 10. Gemini

### Configuración

```json
{
  "llm": {
    "defaultProvider": "gemini",
    "providers": {
      "gemini": {
        "type": "gemini",
        "apiKey": "${GEMINI_API_KEY}",
        "defaultModel": "gemini-3.8-flash",
        "timeoutMs": 60000
      }
    }
  }
}
```

Ningún modelo concreto está cableado en el SDK: elegí un modelo estable actual
(p. ej. `gemini-3.8-flash`) en `defaultModel`. Los alias móviles como
`gemini-flash-latest` pueden apuntar a versiones preview o experimentales, que
Google desaconseja en producción. Si una petición no trae
`model` y la instancia no tiene `defaultModel`, el error lo dice.

Programáticamente:

```typescript
import { GeminiProvider } from 'agent349';

orchestrator.registerProvider(
  new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY!, defaultModel: 'gemini-3.8-flash' }),
);
```

### Dos superficies, una abstracción

El provider habla **dos APIs de Google**, elegidas por capacidad, y lo oculta
por completo:

| Capacidad | Superficie | Motivo |
|---|---|---|
| Llamadas normales (texto, media, tools, structured output, streaming) | **Interactions API** | Es la superficie GA y recomendada por Google: bloques tipados por modalidad, `response_format` combinable con tools, y desglose de tokens por modalidad |
| Archivos | **Files API** | Común a ambas |
| Batch | **`generateContent`** | Es la única que soporta el Batch API |

`store` está fijado a `false` en toda interacción: la memoria conversacional, la
gobernanza y la auditoría siguen siendo de Agent349, no se delegan a Google.

Una opción que sólo entiende una de las dos superficies (`serviceTier`,
`labels`) se acepta en llamadas normales y **se rechaza con error explícito** al
enviarla en un batch, en vez de desaparecer sin aviso.

### Límites

- PDF: 50 MB / 1000 páginas (~258 tokens por página).
- Files API: 2 GB por archivo, 20 GB por proyecto, **expiración a las 48 h**.
- Contenido inline: el SDK usa un tope conservador y sugiere `fileHandling` al
  superarlo.

---

## 11. Errores

| Error | Cuándo |
|---|---|
| `UnsupportedCapabilityError` | modalidad no soportada; URL no descargable por el proveedor; referencia de otro proveedor o expirada; structured output sin soporte nativo; combinación schema + tools imposible; carga inline por encima del límite; batch o files en un provider que no los tiene |
| `ProviderError` | fallo de la API (auth, cuota, 5xx). Lleva `provider`, `model` y `statusCode` |

`UnsupportedCapabilityError` expone `provider`, `capability` y `model` para
ramificar en código sin parsear mensajes.

---

## 12. Limitaciones conocidas

- Audio y vídeo se transportan y se declaran, pero sólo Gemini los acepta hoy.
- Las referencias de archivo no son portables entre proveedores, por diseño.
- No hay recolección automática de archivos expirados: es de la aplicación.
- El SDK no traduce esquemas JSON entre dialectos de proveedor.
- La extracción de documentos por OCR previo (Mistral OCR y equivalentes) no
  está integrada: hoy el documento va al modelo multimodal directamente.
- `openai-compatible` parte de capacidades conservadoras; declaralas en config.
