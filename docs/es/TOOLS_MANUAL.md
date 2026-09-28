# Manual de Tools de Integración

Referencia vigente de las tools de integración del SDK y de la infraestructura
que comparten. El diseño completo y sus fundamentos están en
el registro de diseño original; acá está lo que **hoy** hace el código.

**Estado: completo.** El núcleo transversal (conexiones, credenciales,
bindings, límites, procedencia) y las ocho tools: `sql.query`, `sql.schema`,
`mongo.query`, `mongo.schema`, `http.request`, `web.read`, `doc.read` y
`mail.send`.

## Tabla de contenidos

1. [La regla que gobierna todo](#1-la-regla-que-gobierna-todo)
2. [Conexiones](#2-conexiones)
3. [Credenciales](#3-credenciales)
4. [Bindings: el origen de cada parámetro](#4-bindings-el-origen-de-cada-parámetro)
5. [Límites y truncado](#5-límites-y-truncado)
6. [`sql.query` — modo declarado](#6-sqlquery--modo-declarado)
7. [`sql.query` — modo libre y text-to-SQL](#7-sqlquery--modo-libre-y-text-to-sql)
8. [`sql.schema`](#8-sqlschema)
9. [`mongo.query` y `mongo.schema`](#9-mongoquery-y-mongoschema)
10. [`http.request`](#10-httprequest)
11. [`web.read`](#11-webread)
11.bis. [`feed.read`](#11bis-feedread)
12. [`doc.read`](#12-docread)
12.bis. [`file.read`](#12bis-fileread)
13. [`mail.send`](#13-mailsend)
14. [Drivers](#14-drivers)
14.bis. [Ejecutar una tool desde el host](#14bis-ejecutar-una-tool-desde-el-host)
15. [Procedencia del contenido](#15-procedencia-del-contenido)
16. [Eventos](#16-eventos)
17. [Checklist de producción](#17-checklist-de-producción)

---

## 1. La regla que gobierna todo

> Credenciales y destino son **configuración**.
> El modelo solo aporta los parámetros declarados como suyos.

El `inputSchema` que ve el LLM se **genera** a partir de los bindings marcados
`model`. Un parámetro `context` o `literal` no se filtra después de que el
modelo responde: nunca estuvo en su espacio de decisión, así que no tiene forma
de nombrarlo.

---

## 2. Conexiones

Sección de primer nivel. Una conexión se declara una vez y la comparten todas
las tools que la referencian por nombre.

```jsonc
{
  "connections": {
    "erp": {
      "type": "sql",
      "driver": "postgres",
      "host": "db.interno", "port": 5432, "database": "erp",
      "credential": { "ref": "erp-readonly" },
      "readOnlyUser": true,
      "pool": { "max": 5, "idleTimeoutMs": 30000 },
      "limits": { "maxRows": 500, "maxBytes": 262144, "timeoutMs": 15000 },
      "relations": [ /* ver §8 */ ]
    }
  }
}
```

**Apertura perezosa.** Nada se abre al construir el Orchestrator: una conexión
se abre en su primer uso real, y una que ninguna tool usa no se abre nunca. Que
la base esté caída no impide arrancar el proceso.

**Propiedad.** `shutdown()` cierra únicamente lo que abrió el SDK. Una conexión
inyectada por el host sigue siendo del host.

```typescript
// El host ya tiene un pool: una conexión, un ciclo de vida.
const orch = await Orchestrator.fromConfig(config, {
  connections: { erp: { resource: miPool } },
});
orch.connections.registerDriver(new PostgresDriver()); // sigue haciendo falta
```

`limits` en la conexión es un **techo**: una tool puede bajarlo, nunca subirlo.

### Conexiones creadas en runtime

La sección `connections` cubre las fuentes que se conocen al arrancar. Para las
que no —una por tenant, por proyecto, o creada por un administrador con el
sistema andando— están `registerConnection` / `unregisterConnection`:

```typescript
await orch.registerConnection(`ds_${contentId}`, {
  type: 'sql', driver: 'postgres', host, database,
  credential: { ref: `ds:${contentId}` },
  readOnlyUser: true,
  relations: catalogo,          // allowlist y grounding, igual que en config
});

orch.registerTool(createSqlQueryTool(
  { name: 'ds.query', connection: `ds_${contentId}`, mode: 'freeform' },
  orch.toolServices,
));
```

- **Registrar no abre nada.** Vale la pena repetirlo porque es lo que hace que
  esto sea seguro en un request: la apertura sigue siendo perezosa, y declarar
  una fuente cuyo host está caído no falla.
- **Reemplazar un nombre cierra el recurso que el SDK había abierto** para él.
  Sin eso, una conexión re-apuntada seguiría sirviendo consultas desde el pool
  viejo.
- `unregisterConnection(name)` borra la declaración y cierra lo propio; devuelve
  `false` si no había nada declarado. Una conexión **inyectada** con ese nombre
  no se toca: es del host.
- Después de `shutdown()`, registrar lanza `ConfigError`.

---

## 3. Credenciales

Para credenciales estáticas alcanza la sección `credentials`, con los secretos
como `${ENV_VAR}`:

```jsonc
{
  "credentials": {
    "erp-readonly": { "kind": "basic", "username": "agente_ro", "password": "${ERP_PASSWORD}" }
  }
}
```

Tipos: `none`, `basic`, `bearer`, `apiKey`, `custom`.

Para cualquier cosa **con ciclo de vida** — OAuth, rotación, cifrado en reposo —
el SDK no la gestiona a propósito. Se implementa la clase abstracta y se inyecta:

```typescript
class MiProveedorOAuth extends CredentialProvider {
  readonly name = 'mi-oauth';

  async get(ref: string, context: ExecutionContext): Promise<Credential> {
    // `context` permite credenciales POR USUARIO, no solo de servicio.
    const token = await this.store.tokenFresco(context.userId, ref);
    if (token === null) throw new CredentialError(ref, 'sin autorización para este usuario');
    return { kind: 'bearer', token };
  }
}

await Orchestrator.fromConfig(config, { credentialProvider: new MiProveedorOAuth() });
```

`get()` se invoca **en cada ejecución**, nunca se cachea. Eso es lo que permite
refrescar un token vencido sin que el SDK sepa que existe tal cosa.

---

## 4. Bindings: el origen de cada parámetro

| Origen | Quién decide el valor | ¿Lo ve el modelo? |
|---|---|---|
| `model` | el LLM, validado por AJV | **Sí** |
| `context` | el `ExecutionContext` | No |
| `literal` | la config | No |

```jsonc
"params": {
  "clienteId": { "from": "context", "path": "metadata.clienteId", "required": true },
  "desde":     { "from": "model", "required": true,
                 "schema": { "type": "string", "format": "date" },
                 "description": "Fecha inicial YYYY-MM-DD" },
  "origen":    { "from": "literal", "value": "agente" }
}
```

Rutas de contexto válidas: `userId`, `tenantId`, `sessionId`, `agentId`,
`roles`, y cualquier `metadata.<clave>`. El SDK transporta el valor **sin
interpretarlo**: qué significa `metadata.clienteId` es asunto del integrador.

Un binding `context` con `required: true` cuyo valor falta **falla la
ejecución**. Es deliberado: la alternativa silenciosa es una consulta sin acotar.

---

## 5. Límites y truncado

Cascada: tool → conexión → default del SDK (`tools.defaultLimits`:
`maxRows: 200`, `maxBytes: 131072`, `timeoutMs: 15000`).

Toda tool que devuelve colecciones usa el mismo envelope:

```json
{
  "rows": [ /* … */ ],
  "rowCount": 200,
  "truncated": true,
  "truncatedBy": "maxRows",
  "notice": "Truncated: showing the first 200 rows… do not present this as a complete or total count."
}
```

El `notice` no es decorativo: sin él, el modelo informa un total recortado como
si fuera el total real.

---

## 6. `sql.query` — modo declarado

El default, y lo recomendado para operaciones repetitivas.

```jsonc
{
  "name": "ventas.porCliente",
  "kind": "internal",
  "ref": "sql.query",
  "config": {
    "connection": "erp",
    "description": "Ventas confirmadas de un cliente desde una fecha.",
    "statement": "SELECT fecha, importe FROM v_ventas WHERE cliente_id = :clienteId AND fecha >= :desde ORDER BY fecha DESC",
    "params": {
      "clienteId": { "from": "context", "path": "metadata.clienteId", "required": true },
      "desde": { "from": "model", "required": true, "schema": { "type": "string", "format": "date" } }
    },
    "limits": { "maxRows": 200 }
  }
}
```

Equivalente por código:

```typescript
orch.registerTool(createSqlQueryTool({
  name: 'ventas.porCliente',
  connection: 'erp',
  statement: 'SELECT fecha, importe FROM v_ventas WHERE cliente_id = :clienteId',
  params: { clienteId: { from: 'context', path: 'metadata.clienteId', required: true } },
}, orch.toolServices));
```

Los `:nombre` se traducen a los marcadores nativos del driver y **los valores
viajan fuera de la sentencia, siempre**. Un placeholder repetido reutiliza su
marcador.

Un `:nombre` sin binding declarado **falla al cargar**, no en la primera
consulta.

`exposeDriverErrors` es `false` acá: el error del motor revelaría estructura que
el modelo nunca vio.

---

## 7. `sql.query` — modo libre y text-to-SQL

El modelo escribe el SQL. Junto con `sql.schema`, es lo que habilita consultar
en lenguaje natural.

```jsonc
{
  "name": "erp.consulta",
  "kind": "internal",
  "ref": "sql.query",
  "config": { "connection": "erp", "mode": "freeform", "limits": { "maxRows": 200 } }
}
```

`inputSchema`: `{ sql: string, params?: object }`. La `description` que ve el
LLM se **genera** desde la config e incluye el dialecto y las relaciones
disponibles — que el modelo sepa si escribe `LIMIT` o `TOP` cambia su tasa de
acierto.

### Qué garantiza y qué no

La garantía **real** es que cada sentencia corre dentro de una transacción de
solo lectura (`BEGIN READ ONLY` en PostgreSQL) con `statement_timeout`. Una
escritura la rechaza el motor, diga lo que diga la sentencia y tenga los
permisos que tenga el usuario.

Encima de eso hay una cadena de guardas sintácticas: sentencia única, prefijo de
lectura, palabras prohibidas (incluido `INTO`, que escribe disfrazado de
`SELECT`), y allowlist de relaciones. Reconocen literales, comentarios e
identificadores entrecomillados, así que `WHERE nota = 'please delete me'` no da
falso positivo y `FROM "salaries"` **sí** se verifica.

> **Estas guardas no son la frontera de seguridad.** La extracción de relaciones
> es escaneo de identificadores, no un parser SQL. Lo que acota de verdad **qué**
> puede leer el agente es un usuario de base con permisos limitados a las
> relaciones expuestas. Declararlo con `readOnlyUser: true` es una afirmación
> del integrador que el SDK no puede verificar; omitirla emite
> `security.sql.unrestricted` al cargar.

Una query rechazada **no lanza**: vuelve como `ToolResult` fallido para que el
modelo la corrija en la iteración siguiente. Lo mismo con el error del motor,
que acá sí vuelve textual (`exposeDriverErrors` es `true` por default): el
modelo ya conoce el esquema, así que no revela nada nuevo y es justo lo que le
permite arreglar la consulta.

---

## 8. `sql.schema`

El catálogo se declara en la **conexión**, no en la tool, porque cumple dos
funciones a la vez: es el allowlist que aplica el modo libre y el grounding que
el modelo necesita. Una sola declaración, imposible que se desincronicen.

```jsonc
"relations": [
  {
    "name": "v_ventas",
    "description": "Una fila por venta confirmada. No incluye presupuestos ni anuladas.",
    "columns": [
      { "name": "fecha", "type": "date", "description": "Fecha de confirmación" },
      { "name": "importe", "type": "numeric", "description": "Importe sin impuestos" }
    ]
  }
]
```

```jsonc
{ "name": "erp.esquema", "kind": "internal", "ref": "sql.schema",
  "config": { "connection": "erp" } }
```

El modelo la llama primero y consulta después: dos vueltas del loop, sin cargar
el esquema entero en el prompt de sistema de cada turno. Acepta un filtro
opcional `{ relations: [...] }` para catálogos grandes.

> **Exponé vistas curadas, no tablas transaccionales.** Text-to-SQL sobre un
> esquema crudo con nombres crípticos y reglas de negocio implícitas tiene
> precisión mediocre. Lo que funciona son vistas pensadas para consulta, con
> nombres y descripciones legibles.

---

## 9. `mongo.query` y `mongo.schema`

Misma estructura de dos modos que SQL. Solo cambian las guardas, que son las
que el motor exige.

```jsonc
{
  "connections": {
    "ops": {
      "type": "mongo",
      "url": "mongodb://localhost:27017",
      "database": "ops",
      "readOnlyUser": true,
      "relations": [
        { "name": "tickets", "description": "Un documento por ticket.",
          "columns": [{ "name": "estado", "type": "string", "description": "abierto | cerrado" }] }
      ]
    }
  },
  "tools": { "definitions": [
    { "name": "tickets.abiertos", "kind": "internal", "ref": "mongo.query",
      "config": {
        "connection": "ops",
        "collection": "tickets",
        "filter": { "estado": "abierto", "area": ":area", "org": ":org" },
        "sort": { "creado": -1 },
        "params": {
          "area": { "from": "model", "required": true, "schema": { "type": "string" } },
          "org":  { "from": "context", "path": "metadata.organizacion", "required": true }
        }
      } },
    { "name": "ops.esquema", "kind": "internal", "ref": "mongo.schema",
      "config": { "connection": "ops" } }
  ] }
}
```

Los `:nombre` se sustituyen **por valor tras parsear el JSON**, nunca
concatenando texto.

**Guardas propias de Mongo:**

| Control | Motivo |
|---|---|
| Prohibir `$where`, `$function`, `$accumulator` | Ejecutan JavaScript en el servidor: es RCE disfrazada de filtro |
| Prohibir `$out`, `$merge` | **Escriben**: son la razón por la que "un pipeline es de solo lectura" es falso |
| `$lookup` restringido al allowlist | Si no, un lookup lee una colección que la query no tenía permitido nombrar |
| `$limit` forzado y `maxTimeMS` | Acotan resultado y tiempo |

Como en SQL, la garantía real es un usuario con rol `read` sobre las colecciones
expuestas.

`mongo.schema` sirve un catálogo **curado**: Mongo no declara esquema. Se
descartó inferirlo por muestreo porque metería datos reales —posiblemente
personales— en una descripción que viaja al prompt en cada turno.

---

## 10. `http.request`

Una tool = **una operación declarada** = un verbo fijo. El modelo nunca elige
host, path ni método.

```jsonc
{
  "connections": {
    "crm": { "type": "http", "baseUrl": "https://crm.interno/api/v2",
             "credential": { "ref": "crm-token" }, "followRedirects": false }
  },
  "tools": { "definitions": [
    { "name": "crm.buscarCliente", "kind": "internal", "ref": "http.request",
      "config": {
        "connection": "crm", "method": "GET", "path": "/clientes/{id}",
        "description": "Devuelve la ficha de un cliente por su identificador.",
        "params": {
          "id":      { "in": "path",   "from": "model", "required": true,
                       "schema": { "type": "string", "pattern": "^[0-9]{1,10}$" } },
          "expand":  { "in": "query",  "from": "literal", "value": "contactos" },
          "X-Actor": { "in": "header", "from": "context", "path": "userId" }
        },
        "response": { "pick": "data" }
      } },

    { "name": "crm.crearNota", "kind": "internal", "ref": "http.request",
      "requiresApproval": true,
      "config": {
        "connection": "crm", "method": "POST", "path": "/clientes/{id}/notas",
        "params": { "id": { "in": "path", "from": "model", "required": true,
                            "schema": { "type": "string" } } },
        "body": {
          "template": { "texto": ":texto", "autor": ":autor", "origen": "agente" },
          "params": {
            "texto": { "from": "model", "required": true,
                       "schema": { "type": "string", "maxLength": 2000 } },
            "autor": { "from": "context", "path": "userId" }
          }
        }
      } }
  ] }
}
```

**Lo que garantiza:**

- El host sale de `baseUrl`. Un parámetro de path que contenga `..` o parezca
  una URL absoluta se **rechaza**: sin eso, un parámetro de path es la salida
  del endpoint declarado.
- Los valores de path se codifican; un objeto o un array se rechazan en vez de
  convertirse en `[object Object]`.
- Redirecciones **apagadas por default**. Un `302` hacia otro host es el bypass
  clásico de una allowlist; con `followRedirects: true` cada salto se revalida.
- Un no-2xx vuelve como resultado fallido legible, no como excepción: fundir el
  loop por un 404 no ayuda a nadie.
- `response.pick` recorta el subárbol útil antes de gastar contexto en envoltorios.
- Los verbos mutantes se marcan `sideEffects` y emiten
  `security.http.mutating.unapproved` si no llevan `requiresApproval`.
- **`blockPrivateAddresses` en la conexión** (default `false`). Un endpoint que
  declaró el integrador puede ser un servicio interno legítimo, y por eso no se
  valida su dirección. Cuando el `baseUrl` lo carga **otra persona** —un usuario
  de la aplicación que configura una integración con el sistema andando—,
  `true` aplica la cadena de direcciones de `web.read`: resolución DNS, rechazo
  de rangos privados, loopback y link-local, y conexión a la IP validada.

---

## 11. `web.read`

Lee una URL **elegida por el modelo**. Es el opuesto de `http.request`, no una
variante suya.

```jsonc
{ "name": "web.leer", "kind": "internal", "ref": "web.read",
  "config": {
    "allowedDomains": ["docs.proveedor.com", "*.gob.uy"],
    "followRedirects": true, "maxRedirects": 3, "maxChars": 40000,
    "limits": { "maxBytes": 2097152, "timeoutMs": 10000 }
  } }
```

**Cadena anti-SSRF**, en orden:

| # | Control | Bloquea |
|---|---|---|
| 1 | Esquema | Todo lo que no sea `http`/`https`: `file:`, `data:`, `gopher:` |
| 2 | `allowedDomains` | Dominios fuera de la lista (comodín `*.dominio` soportado) |
| 3 | Validación de **todas** las IPs resueltas | Rangos privados, loopback, link-local — incluido `169.254.169.254` — y equivalentes IPv6, incluidas formas IPv4-mapped y 6to4 |
| 4 | **Conexión a la IP ya validada** | DNS rebinding |
| 5 | Revalidación por salto | Una redirección hacia un host interno |
| 6 | Corte en streaming | Una respuesta deliberadamente enorme |

El control 4 es el que la mayoría omite, y sin él los otros cinco son
decorativos. Se implementa con el hook `lookup` de Node, de modo que la
conexión va a la IP verificada mientras el `Host` y el SNI conservan el nombre
original.

**Los controles 1 y 3-6 se aplican siempre**, haya o no allowlist. `allowedDomains`
es opcional —investigación abierta es un caso legítimo— pero omitirla emite
`security.web.unrestricted`.

El resultado lleva `untrusted: true` y un `warning` explícito en el payload:
el texto es información de un tercero, nunca instrucciones.

### Una región de la página: `selector`

```jsonc
{ "name": "agencia.novedades", "kind": "internal", "ref": "web.read",
  "config": { "allowedDomains": ["www.gub.uy"], "selector": "main .listado" } }
```

Devuelve sólo el texto de los elementos que coinciden, en orden de documento, y
`selectorMatches` con cuántos hubo. **Cero coincidencias no es un error**: es la
señal de que el sitio cambió su marcado y hay que revisar el selector. Un
selector inválido falla al construir la tool. Con selector no se descartan
`nav`, `footer` ni `aside`: quien lo declaró ya eligió la región.

Con o sin selector, el texto conserva **un salto de línea por elemento de
bloque** (párrafo, ítem, título, fila), así que un host puede comparar una página
contra su lectura anterior bloque por bloque.

### Formato crudo: `format: "raw"`

Devuelve el cuerpo tal como llegó —con los mismos topes de `maxChars` y
`limits.maxBytes`— para un host que parsea el formato por su cuenta. No admite
`selector`.

### Leer periódicamente: `conditionalRequests`

Todo resultado exitoso trae `status`, `notModified` y, si el servidor los envía,
`etag` y `lastModified`. Con `"conditionalRequests": true` el `inputSchema` suma
`ifNoneMatch` e `ifModifiedSince`: devolverlos en la lectura siguiente convierte
una página sin cambios en un `304` —`success: true`, `notModified: true`, sin
texto— en lugar de otra descarga y otra extracción.

- Apagado por defecto: un agente conserva el schema de un solo campo.
- Un `304` sólo significa "sin cambios" si el pedido fue condicional; si no, es
  un error HTTP.
- Un valor con saltos de línea (sería un header inyectado) o de más de 512
  caracteres se rechaza sin hacer el pedido.

---

## 11.bis. `feed.read`

Lee un feed RSS 2.0, Atom 1.0 o RSS 1.0 (RDF) y devuelve sus entradas
normalizadas. Misma cadena anti-SSRF que `web.read`, mismos
`conditionalRequests`, mismo resultado `untrusted`. Sin `allowedDomains` emite
`security.web.unrestricted`.

```jsonc
{ "name": "compras.llamados", "kind": "internal", "ref": "feed.read",
  "config": {
    "allowedDomains": ["*.gub.uy"],
    "maxEntries": 100, "maxSummaryChars": 2000,
    "conditionalRequests": true,
    "limits": { "maxBytes": 4194304, "timeoutMs": 15000 }
  } }
```

`inputSchema`: `{ url }` (más `ifNoneMatch` e `ifModifiedSince` con
`conditionalRequests`).

```jsonc
// data
{ "url": "…", "status": 200, "notModified": false, "etag": "\"f1\"",
  "format": "rss", "title": "Llamados", "link": "https://…",
  "entries": [
    { "id": "call-12345", "link": "https://…/12345",
      "title": "Llamado 12345: plataforma de analítica con IA",
      "summary": "Consultoría en machine learning — ANEP",
      "published": "2026-09-09T13:00:00.000Z",
      "categories": ["TI", "IA"], "author": "Compras" } ],
  "totalEntries": 42 }
```

**`id` es la identidad estable de la entrada**: su `guid`/`id`; si no tiene, el
link; si tampoco, un hash `sha1:` de título, fecha y resumen. Es lo que un host
guarda para saber qué entradas ya vio sin comparar texto.

Lo que garantiza el parseo:

- **Sin expansión de entidades.** Un documento que declara `<!ENTITY>` se
  rechaza, y el parser corre igual con el procesamiento de entidades apagado.
  Sólo se decodifican las cinco entidades predefinidas y las referencias
  numéricas, en una sola pasada.
- **Texto plano.** HTML en descripciones, CDATA y títulos Atom `type="html"`
  (doblemente escapados) pasan por la misma extracción que `web.read`.
- **Links sólo `http`/`https`**, resueltos contra la URL del feed. Un
  `javascript:` se descarta.
- **Fechas en ISO 8601**; una fecha que no parsea se omite.
- **Un cuerpo cortado por `maxBytes` falla**, con un mensaje que dice qué subir:
  medio XML no parsea, e inventar la mitad que falta sería peor.

Dependencia: `fast-xml-parser`, sin dependencias propias.

---

## 12. `doc.read`

Extrae texto de PDF, Word (`.docx`), HTML y texto plano, reutilizando las
librerías que ya usan los loaders de RAG. **Excel no está**: ninguna dependencia
instalada lee `.xlsx` y no se agregó ninguna.

```jsonc
{ "name": "doc.leer", "kind": "internal", "ref": "doc.read",
  "config": {
    "sources": [
      { "name": "manuales", "kind": "fs", "root": "./documentos/manuales" },
      { "name": "adjuntos", "kind": "store" }
    ],
    "maxChars": 40000, "maxBytes": 20971520
  } }
```

`inputSchema`: `{ source, ref, pages? }`.

**De dónde sale el archivo** es la pregunta crítica, no el parseo: una tool que
acepta un path arbitrario es un lector del filesystem entero del servidor.

- **`kind: "fs"`** — el `ref` se resuelve bajo `root`, se rechazan paths
  absolutos y `..`, y se **vuelve a verificar tras resolver symlinks**. Sin ese
  último paso, un symlink dentro del directorio permitido escapa del corral.
- **`kind: "store"`** — el `ref` es opaco y lo traduce un `DocumentStore`
  inyectado por `overrides.documentStores`, que recibe el `ExecutionContext` y
  aplica el control de acceso del host antes de devolver bytes.

```typescript
class AlmacenAdjuntos extends DocumentStore {
  readonly name = 'adjuntos';

  async fetch(ref: string, context: ExecutionContext): Promise<FetchedDocument> {
    const archivo = await this.repo.buscar(ref);
    if (!(await this.acl.puedeLeer(context.userId, archivo))) {
      throw new AccessDeniedError('document', ref, context.roles);
    }
    return { bytes: await this.repo.bytes(archivo), mimeType: archivo.mimeType };
  }
}
```

`pages` acota rangos en PDFs (`"3"`, `"3-8"`), y el truncado sugiere leer el
resto por partes.

> **Cuándo no usarla.** Es para *un* documento puntual. Para preguntas sobre un
> corpus, ingerilo y usá `rag.search`: volcar un PDF de 300 páginas al contexto
> es caro y responde peor que recuperar los pasajes relevantes.

## 12.bis. `file.read`

Lee un archivo de texto de una raíz declarada **a partir de un offset**, para
leer incrementalmente un archivo que crece —un log— sin volver a leerlo entero.

```jsonc
{ "name": "logs.leer", "kind": "internal", "ref": "file.read",
  "config": {
    "roots": [ { "name": "syslogs", "path": "/mnt/hostlogs" } ],
    "maxBytes": 1048576,
    "denyPatterns": ["*.secret"]
  } }
```

`inputSchema`: `{ root, path, offset?, maxBytes?, lineAligned?, expect? }`.

```jsonc
// data
{ "root": "syslogs", "path": "auth.log", "text": "…",
  "fromOffset": 81920, "nextOffset": 90112, "bytesRead": 8192,
  "size": 90210, "mtime": "2026-09-10T12:00:00.000Z",
  "fileId": "16777220:9123412", "headHash": "3f…", "headBytes": 256,
  "rotated": false, "eof": false, "partialLine": true }
```

**Sin estado.** La tool no guarda cursores: devuelve dónde terminó
(`nextOffset`) y cómo reconocer el archivo (`fileId`, `headHash`, `headBytes`).
El host lo guarda y lo devuelve en la lectura siguiente como `offset` y
`expect`. Cuándo confirmar ese cursor es decisión del host.

**Rotación y truncado.** Con `expect`, la lectura detecta que el offset ya no
corresponde al archivo, lo informa con `rotated: true` y `rotationReason`, y lee
desde el principio:

| Motivo | Situación típica |
|---|---|
| `file-id` | Rotado por rename (`auth.log` → `auth.log.1` y archivo nuevo). El remanente del viejo se lee pidiendo `auth.log.1` con el offset anterior |
| `shrunk` | Truncado en el lugar (`copytruncate`) |
| `head` | Reescrito con el mismo tamaño |

Un archivo chico que crece no se confunde con uno rotado: la cabecera se compara
sobre los mismos `headBytes` que se hashearon la vez anterior.

**Líneas enteras.** Con `lineAligned` (default) la lectura termina en el último
salto de línea y una línea nunca llega partida. Una última línea sin terminar
espera a la lectura siguiente (`partialLine`); una sola línea más larga que el
tope se entrega en partes (`splitLine`) en vez de trabar la lectura para
siempre. Para leer completo un archivo que puede no terminar en salto de línea
(un JSON), `lineAligned: false`. Un carácter multibyte nunca se corta al medio.

**El corral**, que es lo que importa:

- La ruta se resuelve dentro de la raíz y se **re-verifica después de seguir
  symlinks**: el mismo control que `doc.read`, compartido en
  `resolveInsideRoot()`. Rutas absolutas, `..` y bytes nulos se rechazan.
- **Nombres protegidos en toda raíz**, además de `denyPatterns`: `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `id_rsa*` y las demás claves
  SSH, `.env`, `.env.*`, `*.env`, `.htpasswd`, `shadow` y `gshadow`. Se evalúan
  sobre el nombre pedido **y** sobre el destino real: un symlink de nombre
  inocente que apunta a una clave también se rechaza.
- Archivos binarios (un byte nulo en los primeros 8 KB) y directorios se rechazan.
- Apertura de solo lectura, con `O_NOFOLLOW` donde el sistema lo soporta.
- El `maxBytes` del input puede bajar el de la config, nunca subirlo.
- Resultado `untrusted` por defecto: un log guarda texto que escribió otro —un
  nombre de usuario en `auth.log` lo elige quien ataca—. `"untrusted": false`
  sólo para archivos que controla el integrador.

> **En cluster**, la tool lee el sistema de archivos **del proceso que la
> ejecuta**. Una raíz tiene que verse igual desde todos los nodos (un volumen
> compartido), o el host tiene que decidir en qué nodo corre la lectura.

---

## 13. `mail.send`

```jsonc
{ "name": "mail.enviar", "kind": "internal", "ref": "mail.send",
  "requiresApproval": true,
  "config": {
    "connection": "corp-mail",
    "from": { "from": "literal", "value": "agente@empresa.com" },
    "allowedRecipientDomains": ["empresa.com"],
    "maxRecipients": 5, "maxBodyChars": 20000
  } }
```

**Enviar es el canal de exfiltración más directo que tiene un agente**: el
modelo elige destinatario y cuerpo, y un documento que leyó puede pedirle que
mande algo afuera. De ahí las tres guardas, en orden de importancia:

1. **`allowedRecipientDomains`.** Sin ella la tool **no construye**, salvo
   `allowExternalRecipients: true` explícito, que emite
   `security.mail.unrestricted`.
2. **`maxRecipients`**, contando cc.
3. **El remitente nunca es `model`.** Solo `literal` o `context`; declararlo
   `model` es un error de carga.

La tool se marca `sideEffects`, así que un envío en un turno que tomó contenido
no confiable dispara `security.untrusted.mutating`.

### Transporte

**El SDK no trae ninguno.** Define el contrato y el host inyecta el suyo:

```typescript
class TransporteCorporativo extends MailTransport {
  readonly name = 'smtp-corp';

  async send(mensaje: OutgoingMail, context: ExecutionContext): Promise<{ messageId?: string }> {
    const info = await this.mailer.sendMail(mensaje);
    return { messageId: info.messageId };
  }
}

await Orchestrator.fromConfig(config, { mailTransport: new TransporteCorporativo() });
```

Las razones: un SMTP built-in exigiría `nodemailer`, y cualquier aplicación que
quiera esta tool **ya tiene** un mailer con su cola, sus reintentos y su
remitente verificado. `send()` recibe el `ExecutionContext`, así que un
transporte que envía desde la casilla del usuario puede hacerlo.

---

## 14. Drivers

```typescript
import { PostgresDriver } from 'agent349';

orch.connections.registerDriver(new PostgresDriver());
```

```typescript
import { MySqlDriver, MsSqlDriver, OracleDriver } from 'agent349';

orch.connections.registerDriver(new MySqlDriver());            // driver: "mysql"
orch.connections.registerDriver(new MySqlDriver('mariadb'));   // driver: "mariadb"
orch.connections.registerDriver(new MsSqlDriver());            // driver: "mssql"
orch.connections.registerDriver(new OracleDriver());           // driver: "oracle"
```

**Ningún cliente de base es dependencia efectiva del SDK.** Se importan
dinámicamente: instalá en el host el que uses (`pg`, `mysql2`, `mssql`,
`oracledb`). Si falta, el error llega en el primer uso y dice qué hacer.

> **Con el SDK enlazado (`file:` o `npm link`), instalalo también en el SDK.**
> Node resuelve los imports por la **ruta real**, no por la del enlace: un
> `import('mysql2')` hecho desde el código del SDK busca en el `node_modules`
> del propio SDK, no en el de la aplicación. Instalado sólo en el host, el
> paquete existe y aun así no se encuentra. En una instalación normal desde npm
> no pasa, porque el SDK vive dentro del `node_modules` de la aplicación. Los
> clientes están declarados como `optionalDependencies` del SDK, así que un
> `npm install` en su directorio alcanza.

Motores implementados: **PostgreSQL**, **MySQL/MariaDB**, **SQL Server** y
**Oracle**.

| | PostgreSQL | MySQL / MariaDB | SQL Server | Oracle |
|---|---|---|---|---|
| Paquete | `pg` | `mysql2` | `mssql` | `oracledb` |
| Marcadores | `$1`; un `:name` repetido **reusa** su marcador | `?`; repetido **duplica** el valor (posicional) | `@p1`; repetido **reusa** (con nombre) | `:1`; repetido **reusa** |
| Tope de filas | `… AS q LIMIT n` | igual | **dos casos** (ver abajo) | `… q FETCH FIRST n ROWS ONLY`, **sin `AS`** |
| Solo lectura | `BEGIN READ ONLY` ✅ | `START TRANSACTION READ ONLY` ✅ | ❌ **no existe** → transacción con `ROLLBACK` siempre | `SET TRANSACTION READ ONLY` ✅ |
| Timeout | `SET LOCAL statement_timeout` | `SET SESSION max_execution_time` (MariaDB: `max_statement_time`, **en segundos**) | `request.timeout` del cliente | `callTimeout` de la conexión |

Tres particularidades que conviene conocer:

**MySQL no tiene `SET LOCAL`.** El tope de tiempo queda en la sesión y sobrevive
al `COMMIT` en una conexión del pool. No cambia el comportamiento —se re-aplica
antes de cada sentencia— pero explica por qué una conexión ociosa muestra ese
valor.

**SQL Server prohíbe `ORDER BY` dentro de una derived table** salvo que la
subconsulta traiga también `TOP`, `OFFSET/FETCH` o `FOR XML`. El envoltorio
ingenuo fallaría con `Msg 1033` justo en las consultas analíticas típicas
(`GROUP BY … ORDER BY total DESC`), así que `applyLimit` distingue dos casos: si
hay `ORDER BY` de primer nivel sin paginación, appendea `OFFSET 0 ROWS FETCH
NEXT n ROWS ONLY`; si no, envuelve con `TOP (n)`.

**SQL Server no tiene transacción de solo lectura, y eso cambia la garantía.**
En los otros tres motores una escritura falla dentro de la transacción. Acá lo
que hay es una transacción que **siempre se revierte**: un `INSERT` que pasó
todas las guardas se deshace, pero no se impide. Un rollback no puede deshacer
lo que nunca fue transaccional, y la ventana entre la escritura y el rollback
existe. En este motor **los permisos del usuario cargan el peso** que el motor
carga en los demás: `readOnlyUser: true` merece verificarse contra los permisos
reales, no declararse.

Para otro motor, se extiende `SqlDriver` (que agrega `query()` y un `dialect` a
`ConnectionDriver`). El dialecto solo sabe deletrear tres cosas: marcadores de
parámetros, tope de filas y guardas de sesión.

Para MongoDB, `MongoDriver` usa el paquete `mongodb`, que **ya es
`optionalDependency`** del SDK y se importa dinámicamente.

```typescript
import { MongoDriver } from 'agent349';
orch.connections.registerDriver(new MongoDriver());
```

Un driver hace falta incluso con la conexión inyectada por el host: el recurso
es opaco y el driver es lo que sabe consultarlo.

---

## 14.bis. Ejecutar una tool desde el host

No toda ejecución necesita un modelo que la decida. Un host que ya sabe qué tool
llamar y con qué input —un pipeline determinístico, un job, un endpoint— la
corre directo:

```typescript
const result = await orch.executeTool('ds.query',
  { sql: 'SELECT region, SUM(amount) FROM v_sales GROUP BY region' },
  context);
```

Llamar `tool.execute()` sobre el objeto también "funciona", y es justo lo que hay
que evitar: saltea todo lo que agrega el executor —validación AJV del input,
política de reintentos, timeout, seguimiento de procedencia, y los eventos
`tool.call.*` de los que se alimenta la auditoría—. Pasando por acá, una
ejecución iniciada por el host se observa **exactamente igual** que una que
decidió el agente.

Los fallos de validación y de ejecución vuelven como `success: false`, no como
excepción; sólo una tool inexistente lanza (`ToolNotFoundError`).

---

## 15. Procedencia del contenido

`ToolResult.untrusted` marca material de un origen que el integrador no
controla. `ToolDescriptor.sideEffects` marca las tools que actúan hacia afuera.
El `UntrustedTracker` emite `security.untrusted.inflow` cuando entra contenido
no confiable a un turno y `security.untrusted.mutating` cuando una tool con
efecto externo corre en un turno ya marcado.

**Es observabilidad, no aplicación:** el SDK no bloquea, no exige aprobación y
no interrumpe el loop. Construir política sobre esos eventos es del host.

---

## 16. Eventos

| Evento | Cuándo |
|---|---|
| `connection.opened` / `connection.error` | Ciclo de vida de una conexión |
| `tool.query.rejected` | Una guarda rechazó una consulta libre (incluye `control`) |
| `security.egress.denied` | Un destino HTTP o un destinatario de correo fue bloqueado |
| `security.sql.unrestricted` | Carga: modo libre (SQL o Mongo) sin `readOnlyUser: true` |
| `security.http.mutating.unapproved` | Carga: operación mutante sin `requiresApproval` |
| `security.web.unrestricted` | Carga: `web.read` o `feed.read` sin `allowedDomains` |
| `security.mail.unrestricted` | Carga: `mail.send` sin allowlist de dominios |
| `security.untrusted.inflow` | Entró contenido no confiable al turno |
| `security.untrusted.mutating` | Tool con efecto externo en un turno marcado |

---

## 17. Checklist de producción

- [ ] La conexión apunta a un usuario de base **de solo lectura**, con permisos
      acotados a las relaciones expuestas. Es la garantía real, no las guardas.
- [ ] `readOnlyUser: true` declarado, y sin `security.sql.unrestricted` al
      arrancar.
- [ ] Se exponen **vistas curadas** con descripciones, no tablas crudas.
- [ ] Toda identidad que acote una consulta viaja por un binding `context`,
      nunca `model`.
- [ ] `limits` fijados en la conexión como techo.
- [ ] Los secretos entran por `${ENV_VAR}` o por un `CredentialProvider`
      inyectado; ninguno hardcodeado.
- [ ] `pg` instalado en el host, o el pool inyectado por `overrides.connections`.
- [ ] Las operaciones HTTP mutantes llevan `requiresApproval`, o la omisión es
      deliberada y el evento de carga está revisado.
- [ ] `web.read` tiene `allowedDomains`, salvo que investigación abierta sea el
      requisito.
- [ ] Si el agente combina `web.read` con `mail.send` o verbos HTTP mutantes,
      alguien vio los eventos `security.untrusted.*` y aceptó el riesgo.
- [ ] `mail.send` tiene allowlist de dominios y su transporte inyectado.
- [ ] Las fuentes de `doc.read` apuntan a directorios acotados o a un
      `DocumentStore` que aplica el control de acceso del host.
- [ ] `shutdown()` se llama al terminar el proceso.
