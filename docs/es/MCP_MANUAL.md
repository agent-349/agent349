# MCP Manual — Agent349

## 1. Introducción

MCP (Model Context Protocol) es un protocolo abierto que estandariza cómo un modelo de lenguaje accede a herramientas y datos externos. Un **servidor MCP** expone un catálogo de tools; un **cliente MCP** las descubre y las invoca.

El SDK implementa el lado **cliente**. Eso significa que puede consumir cualquier servidor MCP existente — sistemas de archivos, bases de datos, APIs corporativas, servidores de terceros — y exponer sus tools a los agentes como si fueran tools nativas.

El SDK **no** implementa el lado servidor: no publica sus propias tools por MCP. Si necesitás eso, es otro trabajo.

### Qué gana el agente

Una tool MCP, una vez puenteada, es una `Tool` común y corriente del SDK. Pasa por el mismo `ToolExecutor` (validación de input con AJV, timeout, retry, eventos `tool.call.*`), el mismo pipeline de seguridad (ACL, masking) y la misma auditoría. Nada aguas abajo — el agent loop, el planner, HITL — necesita saber que la implementación vive en otro proceso.

---

## 2. Instalación

El soporte MCP depende de `@modelcontextprotocol/sdk`, que es una **dependencia opcional**. Los proyectos que no usan MCP no la pagan.

```bash
npm install @modelcontextprotocol/sdk
```

Si falta y configurás un servidor MCP, obtenés un error accionable:

```
McpConnectionError: MCP server 'files': the optional dependency
'@modelcontextprotocol/sdk' is not installed. Run
`npm install @modelcontextprotocol/sdk` to enable MCP support.
```

---

## 3. Arquitectura

Tres piezas, en capas:

```
McpClient      — una conexión a un servidor. Habla el protocolo.
McpToolBridge  — traduce tools remotas ⇄ Tool del SDK.
McpLoader      — lee la config, crea clientes y bridges, registra tools.
```

El flujo completo:

```
mcp.servers (config)
      ↓  loadMcpServers()
  McpClient ── connect ──▶ servidor MCP (stdio | http)
      ↓
  McpToolBridge ── tools/list ──▶ Tool[]
      ↓
  ToolRegistry ──▶ ToolExecutor ──▶ agent loop
```

### Correspondencia de conceptos

| MCP | SDK |
|---|---|
| `tools/list` → `{name, description, inputSchema}` | `ToolDescriptor` |
| `tools/call` → `content[]` / `structuredContent` / `isError` | `ToolResult` |
| Servidor | `McpClient` + namespace de tools |
| `annotations.*` | metadata en `McpToolInfo` (no decide seguridad) |

---

## 4. Transports

### `stdio` — servidor como proceso hijo

El servidor se lanza como subproceso y se habla por stdin/stdout. Es el modo habitual para servidores locales.

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
        "cwd": "/srv/app",
        "env": { "LOG_LEVEL": "warn" }
      }
    }
  }
}
```

Notas:

- `env` **no** hereda todo el entorno del proceso padre. El SDK oficial pasa un subconjunto curado por seguridad, así que los secretos hay que reenviarlos explícitamente.
- El `stderr` del hijo **nunca** se escribe en la salida del host. Se drena y se reemite como evento `mcp.server.stderr` en el EventBus (el SDK no imprime a stdout por sí mismo).

### `http` — servidor remoto

Streamable HTTP, para servidores que corren fuera del proceso.

```json
{
  "mcp": {
    "servers": {
      "search": {
        "transport": "http",
        "url": "https://mcp.internal.corp/mcp",
        "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
      }
    }
  }
}
```

Los `${ENV_VAR}` se resuelven en runtime por el `ConfigLoader`, igual que en el resto de la config.

### `custom` — solo por código

Para transports que el SDK no envuelve nativamente (SSE, WebSocket, in-process). **No se puede expresar en JSON**: la config se deep-clonea con `structuredClone`, que no puede clonar funciones. Se inyecta programáticamente:

```typescript
import { McpClient, Orchestrator } from 'agent349';

const client = new McpClient('legacy', {
  transport: 'custom',
  create: () => new MyCustomTransport(),
});

const orch = await Orchestrator.create(configPath, {
  mcpClients: { legacy: client },
});
```

---

## 5. Registrar tools: dos modos

### Modo explícito (recomendado en producción)

Cada tool remota se declara por separado. Es más verboso, pero fija exactamente qué capacidades remotas son alcanzables y permite darle a cada una sus propios tags, timeout y flag de aprobación.

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
      }
    }
  },
  "tools": {
    "definitions": [
      {
        "kind": "mcp",
        "name": "docs.read",
        "server": "filesystem",
        "remoteName": "read_file",
        "tags": ["docs", "readonly"],
        "requiresApproval": false,
        "timeout": 15000
      }
    ]
  }
}
```

- `name` es el nombre final en el `ToolRegistry`.
- `remoteName` es el nombre tal como lo expone el servidor.
- `server` referencia la clave en `mcp.servers`.

Si el servidor no expone esa tool, el arranque falla con la lista de las disponibles:

```
ToolLoadError: MCP tool 'read_fil' on server 'filesystem': not exposed by the
server. Available tools: read_file, write_file, list_directory
```

### Modo automático

`autoRegisterTools: true` registra todo lo que el servidor exponga, con nombres `<servidor>.<tool>`.

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
        "autoRegisterTools": true,
        "tags": ["mcp", "files"]
      }
    }
  }
}
```

Cómodo para levantar rápido un servidor de confianza. **El riesgo es que el catálogo lo controla el servidor**: si agrega una tool mañana, tu agente la tiene registrada sin que nadie la haya revisado.

Los dos modos conviven. La auto-registración corre **primero**, así que una definición explícita con el mismo `name` la sobrescribe (last-write-wins, igual que en el resto del sistema de config).

### Conexión perezosa

Un servidor **sin** `autoRegisterTools` no se contacta durante el arranque: su cliente conecta en el primer `listTools()`/`callTool()`. Eso mantiene el arranque rápido y evita abrir conexiones a servidores cuyas tools nunca se usan.

Con `autoRegisterTools: true` sí hay conexión en el arranque — hay que traer los schemas para poder registrar las tools.

### El catálogo es una foto: `refreshMcpTools()`

Las tools registradas con `autoRegisterTools` son un **snapshot tomado al arrancar**. Un servidor puede ganar, perder o cambiar tools mientras tu proceso corre — y MCP lo anuncia con `notifications/tools/list_changed`, a la que **el SDK todavía no se suscribe**.

Hasta que lo haga, un host de larga vida se re-sincroniza a mano:

```typescript
const results = await orch.refreshMcpTools('filesystem');
// [{ server: 'filesystem', added: ['filesystem.grep'], updated: [...], removed: [], skipped: [] }]

await orch.refreshMcpTools();   // todos los servidores auto-registrados
```

Llamalo en un intervalo, ante una acción de operador, o después de redeployar el servidor.

**Qué toca y qué no.** Solo servidores auto-registrados, y dentro de ellos solo los nombres que el propio Orchestrator registró. Una tool declarada en `tools.definitions` nunca se sobrescribe ni se elimina: la declaración explícita sigue ganándole al catálogo del servidor, igual que en el arranque (aparecen en `skipped`). Las tools registradas por código tampoco se tocan.

Un servidor declarado **sin** `autoRegisterTools` no tiene nada que re-sincronizar — sus tools están fijadas por definiciones explícitas por construcción — así que refrescarlo devuelve `[]`.

Si el servidor está caído, el refresh lanza y **el catálogo anterior queda intacto**: un fallo de red no te vacía el registry.

Emite `mcp.tools.refreshed` con los conteos de cambios.

---

## 6. Opciones por servidor

| Campo | Default | Qué hace |
|---|---|---|
| `autoRegisterTools` | `false` | Registra todas las tools del servidor |
| `namespace` | clave del servidor | Prefijo de los nombres de tool |
| `tags` | `['mcp', <namespace>]` | Tags para filtrado y ACL |
| `requiresApproval` | sin setear | Marca las tools del servidor como no confiables (§8) |
| `toolTimeoutMs` | global de tools | Timeout de ejecución por tool |
| `requestTimeoutMs` | `30000` | Timeout de handshake y de cada request |
| `maxTextLength` | `100000` | Corte del output textual |

---

## 7. Mapeo de resultados

Un `tools/call` de MCP devuelve `content[]`, opcionalmente `structuredContent`, y un flag `isError`. El bridge lo traduce a `ToolResult` con esta precedencia:

1. **`isError: true`** → `{ success: false, error: <texto del servidor> }`.
   Es un error *de aplicación*: el agent loop se lo pasa al LLM para que reaccione, no rompe la ejecución.
2. **`structuredContent` presente** → `{ success: true, data: structuredContent }`.
   El servidor ya lo validó contra su propio `outputSchema`.
3. **Todo el contenido es texto** → los bloques unidos con `\n`.
4. **Contenido mixto** → el array de bloques crudo, para que imágenes y recursos sobrevivan.
5. **Contenido vacío** → `{ success: true, data: null }`.

El output textual se trunca en `maxTextLength` con una marca explícita (`…[truncated N characters]`). Es una red de seguridad: un bloque base64 de varios MB desperdicia la ventana de contexto y normalmente hace fallar el request igual.

### Errores de protocolo vs. errores de aplicación

| Situación | Resultado |
|---|---|
| El servidor responde `isError: true` | `ToolResult` fallido → lo ve el LLM |
| Error JSON-RPC, timeout, tool inexistente | `McpToolError` lanzado → lo maneja el `ToolExecutor` (retry) |
| No se puede conectar | `McpConnectionError` |

Que los errores de protocolo se lancen es deliberado: así entran en la política de retry del `ToolExecutor`, que es lo correcto para fallos de red transitorios.

---

## 8. Seguridad

Esta sección importa más que el resto del manual. **Un servidor MCP es input no confiable.**

### Prompt injection

El servidor controla los **nombres, las descripciones y los resultados** de sus tools, y las tres cosas llegan al LLM literalmente. Una descripción de tool puede contener instrucciones dirigidas al modelo. Tratá a todo servidor que no controles como texto hostil.

Mitigación que el SDK aplica:

- **Namespacing obligatorio.** Los nombres quedan como `<servidor>.<tool>`, así que un servidor no puede secuestrar una tool de primera parte declarando su nombre.

### Aprobación: confianza explícita por servidor

Las tools MCP **no requieren aprobación por defecto**, igual que cualquier tool registrada localmente.

Esto es deliberado. El riesgo de una tool depende de **qué hace** (mueve plata, borra datos, manda mensajes al exterior) y de **cuánto confiás en su origen** — no del transporte por el que llega. Un servidor MCP interno que corre tu propio equipo no es más peligroso que una tool local que hace lo mismo.

En particular, el SDK **no** usa `annotations.readOnlyHint` para elegir un default. Esa annotation la declara el propio servidor sobre sí mismo: si el servidor es la parte en la que no confiás, un servidor hostil solo tendría que declararla para bajarse la guardia. Las annotations son información para mostrar y filtrar, nunca un límite de seguridad.

La confianza se declara donde vive la decisión — la config del servidor:

```json
{
  "mcp": {
    "servers": {
      "erp-interno": {
        "transport": "stdio",
        "command": "/opt/erp/mcp-server"
      },
      "partner-externo": {
        "transport": "http",
        "url": "https://partner.example.com/mcp",
        "requiresApproval": true
      }
    }
  }
}
```

O por tool, con `kind: "mcp"` y `requiresApproval` en la definición.

> ⚠️ **`requiresApproval` es solo metadata.** El gate real de HITL lo decide el `ApprovalService` evaluando sus *triggers*. Sin un trigger declarado, poner `requiresApproval: true` **no bloquea nada**. Ver "Cómo frenar de verdad una tool MCP", más abajo.

### Cómo frenar de verdad una tool MCP

Para que una llamada se suspenda hace falta un `ApprovalTrigger` cuyo `scope` matchee el nombre del tool. El namespacing juega a favor: `scope.skills` hace prefix match sobre `<servidor>.`, así que cubre todas las tools de un servidor.

```typescript
approvalService.addTrigger({
  id: 'mcp-partner-externo',
  name: 'Tools del partner externo',
  enabled: true,
  scope: { skills: ['partner-externo'] },   // matchea partner-externo.*
  conditions: [{ type: 'always' }],
  approvalConfig: { approverRoles: ['ops-lead'], risk: 'high', timeoutMinutes: 30 },
});
```

Para una tool puntual, `scope.tools: ['facturas.marcar_pagada']` (nombre exacto).

> ⚠️ **`scope.tags` no funciona hoy.** El `TriggerEvaluator` sabe resolver tags, pero necesita un `ToolRegistry` que el `ApprovalService` nunca le pasa (`new TriggerEvaluator()` sin argumentos), así que los triggers con `scope.tags` **nunca disparan**. Usá `scope.skills` o `scope.tools` hasta que se corrija.

---
### El `ExecutionContext` no viaja al servidor

MCP no tiene identidad de tenant ni de usuario en `tools/call`. El servidor remoto **no sabe** quién está llamando.

Consecuencia directa: el aislamiento multi-tenant se hace de este lado — políticas ACL sobre los tags de las tools, o una instancia de servidor por tenant. Nunca lo asumas del remoto.

### `stdio` es ejecución de procesos

`command` se ejecuta tal cual. Tratalo como input confiable y **nunca** lo construyas a partir de datos de usuario.

Como defensa en profundidad, `mcp.allowedCommands` restringe qué ejecutables pueden lanzarse — el equivalente de `tools.moduleRoots` para módulos externos:

```json
{
  "mcp": {
    "allowedCommands": ["/opt/erp/mcp-server", "/usr/local/bin/mcp-search"],
    "servers": {
      "erp": { "transport": "stdio", "command": "/opt/erp/mcp-server" }
    }
  }
}
```

Un `command` fuera de la lista falla en la validación de config, al arrancar:

```
ConfigError: mcp.servers.erp.command 'curl' is not in mcp.allowedCommands.
Allowed: /opt/erp/mcp-server, /usr/local/bin/mcp-search
```

Dos límites que conviene tener claros:

- **El match es exacto.** `npx` no cubre `/usr/bin/npx` ni al revés.
- **Restringe el binario, no el argv completo.** Permitir un lanzador genérico como `npx` sigue habilitando la descarga y ejecución de cualquier paquete del registry. Para que el guard valga algo, fijá ejecutables concretos.

Omitir el campo no restringe nada (comportamiento por defecto).

### El pipeline de seguridad sí aplica

Los resultados de las tools MCP pasan por el mismo `SecurityMiddlewareChain` (masking de campos, sanitización) que cualquier otra tool. No hay que configurar nada especial, pero conviene saber que la protección existe.

---

## 9. Eventos

Todo se observa por el EventBus.

| Evento | Cuándo |
|---|---|
| `mcp.server.connect` | Handshake completado |
| `mcp.server.close` | Conexión cerrada |
| `mcp.server.error` | Fallo de conexión o de cierre |
| `mcp.server.stderr` | Línea de stderr de un servidor stdio |
| `config.mcp.server.loaded` | Auto-registración exitosa (con `toolCount`) |
| `config.mcp.server.error` | Servidor salteado en modo `tolerant` |
| `mcp.tools.refreshed` | `refreshMcpTools()` re-sincronizó un catálogo |

Las llamadas a tools emiten los `tool.call.start` / `tool.call.end` / `tool.call.error` de siempre — no hay eventos MCP separados, porque una tool MCP es una tool.

```typescript
orch.events.on('mcp.*', (e) => {
  logger.info(`[mcp] ${e.type}`, e.data);
});
```

---

## 10. Tolerancia a fallos

`tools.loadMode` gobierna qué pasa si un servidor no arranca:

- **`'strict'`** (default): el arranque aborta. La conexión que se hubiera abierto se cierra antes de propagar el error.
- **`'tolerant'`**: se saltea ese servidor, se emite `config.mcp.server.error` y el resto sigue cargando.

```json
{ "tools": { "loadMode": "tolerant" } }
```

`tolerant` tiene sentido cuando un servidor MCP opcional no debe tumbar la aplicación entera. La contra es que el agente arranca sin tools que quizás espera tener.

---

## 11. Ciclo de vida

`Orchestrator.shutdown()` cierra todos los clientes MCP — incluidos los inyectados por `overrides.mcpClients` — junto con los adapters de storage.

Esto no es opcional: un servidor `stdio` es un proceso hijo. Si no cerrás, queda huérfano.

```typescript
process.on('SIGTERM', async () => {
  await orch.shutdown();
  process.exit(0);
});
```

`McpClient.close()` es idempotente, así que un cierre redundante no cuesta nada. Un cliente cerrado no se puede reconectar: construí uno nuevo.

---

## 12. Uso programático

Sin config, directo:

```typescript
import { McpClient, McpToolBridge } from 'agent349';

const client = new McpClient(
  'filesystem',
  {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  },
  { eventBus: bus, requestTimeoutMs: 20_000 },
);

// Inspeccionar el catálogo
const remote = await client.listTools();
console.log(remote.map((t) => t.name));

// Puentear con filtro: solo tools de lectura
const bridge = new McpToolBridge(client, {
  namespace: 'files',
  tags: ['mcp', 'readonly'],
  filter: (info) => info.annotations?.readOnlyHint === true,
});

registry.registerMany(await bridge.createTools());

// …
await client.close();
```

Desde un Orchestrator ya construido:

```typescript
const client = orch.getMcpClient('filesystem');
const tools = await client?.listTools();
console.log(orch.listMcpServers()); // ['filesystem', 'search']
```

El Orchestrator es dueño del ciclo de vida de esos clientes — no los cierres a mano, usá `shutdown()`.

---

## 13. Interoperabilidad: el detalle de `$schema`

Muchos servidores MCP se construyen con `zod-to-json-schema`, que anuncia `"$schema": "https://json-schema.org/draft/2020-12/schema"` en el `inputSchema`.

El `ToolExecutor` valida con AJV 8 en su modo draft-07 por defecto, y AJV **lanza** ante un `$schema` desconocido. Sin tratamiento, una porción grande de servidores MCP reales fallaría en la primera ejecución.

El SDK elimina la clave `$schema` de nivel superior de los schemas remotos, para que AJV compile con su dialecto por defecto en vez de rechazar la tool. El resto del schema se pasa intacto.

---

## 14. Referencia de errores

| Error | `code` | Causa |
|---|---|---|
| `McpConnectionError` | `MCP_CONNECTION_ERROR` | Servidor inalcanzable, handshake fallido, dependencia opcional ausente, cliente cerrado |
| `McpToolError` | `MCP_TOOL_ERROR` | Error JSON-RPC, timeout de request, tool inexistente |
| `ToolLoadError` | `TOOL_LOAD_ERROR` | Servidor desconocido en una definición `kind: "mcp"` |
| `ConfigError` | `CONFIG_ERROR` | Transport inválido, falta `command`/`url`, URL malformada |

---

## 15. Referencia de config

```jsonc
{
  "mcp": {
    // Allowlist de ejecutables para servidores stdio. Match exacto.
    // Omitir para no restringir. Ver §8.
    "allowedCommands": ["/opt/erp/mcp-server"],
    "servers": {
      "<nombre>": {
        // stdio
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@scope/server"],
        "env": { "KEY": "value" },
        "cwd": "/srv/app",

        // http (alternativa a stdio)
        // "transport": "http",
        // "url": "https://host/mcp",
        // "headers": { "Authorization": "Bearer ${TOKEN}" },

        // bridging (opcional, aplica a ambos transports)
        "autoRegisterTools": false,
        "namespace": "files",
        "tags": ["mcp", "files"],
        "requiresApproval": true,
        "toolTimeoutMs": 15000,
        "requestTimeoutMs": 30000,
        "maxTextLength": 100000
      }
    }
  },
  "tools": {
    "loadMode": "strict",
    "definitions": [
      {
        "kind": "mcp",
        "name": "docs.read",
        "server": "<nombre>",
        "remoteName": "read_file",
        "tags": ["docs"],
        "requiresApproval": false,
        "timeout": 15000
      }
    ]
  }
}
```
