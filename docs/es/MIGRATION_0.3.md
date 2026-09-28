# Migración a 0.3 — multimodalidad, archivos, structured output y batch

Esta versión introduce entradas no textuales, salidas estructuradas, API de
archivos y procesamiento batch. La mayor parte es aditiva, pero hay **cambios
incompatibles deliberados**: se eligió una API más limpia y mejor tipada antes
que preservar formas que ya se habían quedado cortas.

Nada de la configuración existente (`agent349.config.json`) necesita cambios.

Resumen de qué te afecta:

| Si tu código… | Leé |
|---|---|
| implementa un `LLMProvider` propio | §1, §2 |
| construye `ContentBlock` a mano | §3 |
| sólo usa `chat()`, `runAgent()`, `complete()` con texto | nada; sigue igual |
| depende de que el contenido no textual se ignorara | §5 |
| depende de valores exactos del preflight de tokens | §6 |

---

## 1. `LLMProvider.capabilities()` es obligatorio

**Antes**

```typescript
class MyProvider extends LLMProvider {
  readonly name = 'mine';
  async call(request: LLMRequest): Promise<LLMResponse> { … }
  async validate(): Promise<ProviderProbe> { … }
  async listModels(): Promise<string[]> { … }
}
```

**Ahora**

```typescript
import { LLMProvider, textOnlyCapabilities } from 'agent349';

class MyProvider extends LLMProvider {
  readonly name = 'mine';
  readonly providerType = 'mine';                    // ← §2
  async call(request: LLMRequest): Promise<LLMResponse> { … }
  async validate(): Promise<ProviderProbe> { … }
  async listModels(): Promise<string[]> { … }

  capabilities(): ProviderCapabilities {             // ← nuevo, abstracto
    return textOnlyCapabilities();
  }
}
```

**Por qué.** El SDK necesita saber qué puede hacer un proveedor *antes* de
traducir la petición, para fallar con un error claro en lugar de mandar un
prompt recortado, y para no derivar a un fallback incapaz de atenderla. Con un
default heredado, un proveedor que sí soporta imágenes las perdería en silencio
hasta que alguien se diera cuenta.

`textOnlyCapabilities()` es la base conservadora; sobrescribí lo que tu
proveedor realmente añada:

```typescript
capabilities(): ProviderCapabilities {
  const base = textOnlyCapabilities();
  return { ...base, input: { ...base.input, image: true }, structuredOutput: 'jsonSchema' };
}
```

**Declará con honestidad.** Declarar de más convierte un error accionable del
SDK en un error opaco del proveedor.

---

## 2. `LLMProvider.providerType` es obligatorio

Una línea por proveedor:

```typescript
readonly providerType = 'mine';
```

**Por qué.** `name` mezclaba dos cosas: la identidad de la *instancia* (clave de
routing, métricas, auditoría) y el *tipo de adapter*. Ahora se separan:

- `name` — la instancia: `'gemini-eu'`, `'vllm-local'`.
- `providerType` — el adapter: `'gemini'`, `'openai-compatible'`.

Eso permite (a) resolver `providerOptions`, que se indexa por tipo para que dos
instancias del mismo adapter compartan opciones, y (b) rechazar la reutilización
de una referencia de archivo entre proveedores distintos.

Los adapters incorporados ya lo declaran. `OpenAIProvider` acepta
`providerType` por config; el wiring pasa `'openai-compatible'` para endpoints
de terceros.

---

## 3. `ContentBlock` es una unión discriminada

**Antes** — una interfaz con todo opcional, en la que `{ type: 'image' }` era
construible pero no transportaba imagen alguna:

```typescript
interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: any;
}
```

**Ahora** — cada variante declara exactamente lo que necesita:

```typescript
type ContentBlock =
  | { type: 'text'; text: string; providerData?: … }
  | { type: 'image' | 'document' | 'audio' | 'video'; source: ContentSource; options?: … }
  | { type: 'media_omitted'; mediaType; mimeType; reason; … }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: any; providerData?: … }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
```

### Qué cambia en la práctica

| Antes | Ahora |
|---|---|
| `{ type: 'text', text }` con `text` opcional | `text` requerido; usá `text('…')` |
| `{ type: 'tool_use', toolUseId?, toolName? }` | ambos requeridos |
| resultado de tool en `input` | campo propio `content: string` |
| `{ type: 'image' }` sin payload | `{ type: 'image', source }` |

**Construí con los helpers**, no a mano:

```typescript
import { text, imageFromPath, documentFromBytes, fromProviderFile } from 'agent349';
```

**Por qué.** El tipo anterior hacía representables estados sin sentido (un
bloque de texto con origen binario, un documento sin origen) y declaraba
`'image'` sin ningún campo capaz de llevar una imagen. Los campos opcionales
convertían cada lectura en una comprobación defensiva.

Si guardás historiales serializados producidos por 0.2, los bloques `text` y
`tool_use` siguen siendo compatibles en forma; sólo los `tool_result` que
guardaban su payload en `input` necesitan releerse desde `content`.

---

## 4. El módulo `content/`

Los helpers de contenido viven en `src/content/` (exportados desde la raíz del
paquete), no en `src/llm/`. Es una capa base: `llm/`, `memory/` y `core/`
dependen de ella, y ella sólo depende de `types/`.

```typescript
import { text, documentFromPath, contentToText } from 'agent349';   // sin cambios en el import raíz
```

---

## 5. El contenido no textual ya no se descarta en silencio

**Antes**, los tres providers hacían:

```typescript
content: typeof msg.content === 'string' ? msg.content : ''
```

Un mensaje de usuario con bloques **llegaba vacío al modelo, sin ningún error**.

**Ahora** se traduce, o se lanza `UnsupportedCapabilityError`.

Es la corrección de un bug latente, pero es un cambio de comportamiento
observable: código que dependiera (a sabiendas o no) de que los adjuntos se
ignoraran ahora verá un error. Es lo que se busca.

---

## 6. El preflight de tokens ya no mide media por su base64

`estimateLLMRequestTokens` estimaba `JSON.stringify(content).length / 4`. Un PDF
de 32 KB (~43 000 caracteres en base64) se estimaba en ~11 000 tokens cuando el
proveedor factura unos cientos — suficiente para **bloquear la petición por
cuota** con `tokens.limitMode: 'enforce'`.

Ahora los bloques media se estiman por modalidad. Si tenías límites calibrados
contra el comportamiento anterior, revisalos: los números cambian (a la baja) en
peticiones con adjuntos.

---

## 7. Cambios aditivos (sin acción)

- `LLMRequest`: `responseFormat`, `fileHandling`, `providerOptions`, `includeRaw`.
- `LLMResponse`: `structured`, `uploadedFiles`, `providerRaw`, `providerType`,
  `executionMode`, `usage.inputByModality` / `outputByModality`.
- `RunOptions` / `ChatOptions`: `responseFormat`, `fileHandling`, `providerOptions`.
- `AgentResponse`: `structured`, `uploadedFiles`.
- `chat()`, `runAgent()`, `AgentLoop.run()`: el mensaje pasa a
  `string | ContentBlock[]` (ensanchar un parámetro no rompe a quien llama).
- `MiddlewarePayload`: `blocks?`.
- Nuevo tipo de provider `'gemini'` y nueva dependencia `@google/genai`.
- Nuevo error `UnsupportedCapabilityError`.
- `ModelPricing` gana `batchInput` / `batchOutput` opcionales.
- Nueva config `memory.session.mediaPersistence` (default `'omit'`).
- Nueva config `llm.providers.<n>.capabilities` (para `openai-compatible`).
- Nuevos métodos del `Orchestrator`: `capabilities()`, `uploadFile()`,
  `deleteFile()`, `submitBatch()`, `getBatch()`, `streamBatchResults()`,
  `cancelBatch()`.

---

## 8. Checklist

- [ ] Añadir `providerType` y `capabilities()` a cada `LLMProvider` propio.
- [ ] Reemplazar la construcción manual de `ContentBlock` por los helpers.
- [ ] Leer los resultados de tool desde `content`, no desde `input`.
- [ ] Revisar código que asumiera que los adjuntos se ignoraban.
- [ ] Revisar límites de tokens calibrados con la estimación anterior.
- [ ] Decidir `memory.session.mediaPersistence` si guardás conversaciones con
      adjuntos (`'omit'` por defecto; ver `MULTIMODAL_MANUAL.md` §6).
- [ ] Declarar `capabilities` en las instancias `openai-compatible` que soporten
      más que el mínimo conservador.
