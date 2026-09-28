# ACL Manual — Agent349

## Introducción

En un sistema de IA corporativo el control de acceso tiene una complejidad que no existe en APIs tradicionales: el LLM puede invocar tools de forma autónoma, recuperar documentos vía RAG, y producir respuestas que combinan datos de múltiples fuentes. Bloquear solo el endpoint HTTP no es suficiente — hay que controlar qué herramientas ve el modelo, qué registros puede leer, y qué campos llegan al output final.

El SDK implementa cuatro capas de seguridad que operan en puntos distintos del pipeline:

| Capa | Qué controla | Cuándo actúa |
|---|---|---|
| 1 — Tool/Skill ACL | ¿Puede este usuario invocar esta tool? | Antes de que el LLM vea el descriptor |
| 2 — Filtrado de datos | ¿Qué registros puede ver este usuario? | Después de que la tool retorna |
| 3 — Enmascaramiento | ¿Qué campos se ocultan en el resultado? | Después del filtrado |
| Auxiliares | Rate limiting + inyección de prompts | Al inicio de cada request |

Las cuatro capas se activan registrando `ACLService` y `SecurityMiddlewareChain` en el `Orchestrator` (API recomendada) o pasándolas al constructor de `AgentLoop` (bajo nivel). Ver sección **Wiring** al final de este documento.

---

## Arquitectura del pipeline de seguridad

```
Request del usuario
       │
       ▼
  AgentLoop.run()
       │
       ├─► [pre/agent_start] RateLimiterMiddleware → InputSanitizerMiddleware
       │        └─► block → AccessDeniedError   modify → reemplaza userMessage
       │
       ├─► ACLService.filterTools() → LLM solo ve las tools permitidas
       │
       │   [LLM decide invocar tool]
       │
       ├─► [pre/tool_call] ToolACLMiddleware
       │        └─► block → ACCESS_DENIED inyectado en el hilo (el LLM puede explicar el rechazo)
       │
       ├─► [ToolExecutor.execute()]
       │
       └─► [post/tool_result] DataFilterMiddleware → FieldMaskMiddleware
                └─► modify → resultado reemplazado antes de agregarse al hilo
```

---

## Capa 1 — Control de acceso a tools y skills

### ACLPolicy

Una política define qué roles pueden (o no pueden) acceder a un recurso:

```typescript
import { ACLService } from 'agent349';

const acl = new ACLService({
  policies: [
    {
      resourceType: 'tool',
      resourceId: 'finance.getBalance',
      allowedRoles: ['finance_viewer', 'finance_admin'],
    },
    {
      resourceType: 'tool',
      resourceId: 'hr.getEmployeeSalary',
      allowedRoles: ['hr_admin'],
    },
    {
      resourceType: 'skill',
      resourceId: 'audit-logs',
      allowedRoles: ['it_admin', 'compliance'],
    },
  ],
});
```

### Modelo de evaluación

- **Sin política → público.** Si no registrás una política, cualquier usuario autenticado puede acceder.
- **`deniedRoles` tiene prioridad sobre `allowedRoles`.**
- **Rol `'*'` = cualquier usuario autenticado.**
- **Múltiples políticas para el mismo recurso → semántica AND** (todas deben pasar).

### Denegar explícitamente

```typescript
acl.addPolicy({
  resourceType: 'tool',
  resourceId: 'admin.resetSystem',
  allowedRoles: ['it_admin'],
  deniedRoles: ['contractor'],  // contractors excluidos aunque tengan it_admin
});
```

### Condiciones contextuales

Las condiciones evalúan campos del `ExecutionContext` en runtime:

```typescript
acl.addPolicy({
  resourceType: 'tool',
  resourceId: 'reports.exportData',
  allowedRoles: ['analyst'],
  conditions: [
    {
      field: 'tenantId',     // dot-notation: 'metadata.department' también funciona
      operator: 'in',
      value: ['acme', 'globex'],
    },
  ],
});
```

Operadores disponibles: `eq`, `neq`, `in`, `not_in`, `exists`, `regex`.

### Evaluación manual

```typescript
const decision = acl.evaluate('tool', 'finance.getBalance', context);

if (!decision.allowed) {
  console.log(decision.reason);   // Qué regla denegó el acceso
  console.log(decision.durationMs); // Costo de evaluación
}
```

### Filtrado de tools antes del LLM

`ACLService.filterTools()` es lo que llama el `AgentLoop` internamente. El LLM **nunca recibe el descriptor** de una tool bloqueada — no puede pedirla aunque quisiera.

```typescript
// Si necesitás hacer esto fuera del loop:
const visibleTools = acl.filterTools(allTools, context);
const visibleSkills = acl.filterSkills(allSkillNames, context);
```

---

## Capa 2 — Filtrado de datos

El filtrado opera sobre el resultado que retorna una tool, antes de que se agregue al hilo de la conversación. Aplica a arrays de registros — objetos individuales pasan sin cambios (sin estructura de lista no hay qué filtrar).

### Tipos de filtro

**`tenant_isolation` — multi-tenancy**

Mantiene solo los registros cuyo campo `tenantId` coincide con `context.tenantId`. El usuario nunca ve datos de otro tenant.

**`role_based` — control por rol**

Mantiene los registros cuyo campo `accessRoles` incluye alguno de los roles del usuario, o cuyo `accessRoles` está vacío (público dentro del tenant).

**`custom` — lógica arbitraria**

Función que recibe `(data, context)` y retorna el subconjunto filtrado.

```typescript
acl.addDataFilter({
  scope: 'tool',          // 'tool' | 'rag' | 'all'
  filterType: 'tenant_isolation',
});

acl.addDataFilter({
  scope: 'all',
  filterType: 'role_based',
});

acl.addDataFilter({
  scope: 'tool',
  toolName: 'crm.getDeals',   // Opcional: aplica solo a esta tool
  filterType: 'custom',
  config: {
    customFilter: (data, ctx) =>
      Array.isArray(data)
        ? data.filter((d) => d.ownerId === ctx.userId || ctx.roles.includes('sales_manager'))
        : data,
  },
});
```

### Cuándo usar scope `'all'`

`scope: 'all'` aplica tanto a resultados de tools como a queries RAG. Es útil para `tenant_isolation` y `role_based` que deben ser universales en el sistema. Para filtros específicos de una tool, usá `scope: 'tool'` con `toolName`.

---

## Capa 3 — Enmascaramiento de campos

El enmascaramiento opera después del filtrado, campo por campo, dentro de cada registro. A diferencia del filtrado (que elimina filas), el enmascaramiento modifica valores dentro de una fila.

### Tipos de máscara

| Tipo | Resultado | Configuración |
|---|---|---|
| `redact` | `'[REDACTED]'` | — |
| `partial` | `'Jua****mez'` | `showFirst`, `showLast`, `maskChar` |
| `hash` | `'a3f2b8c1d4e5...'` (SHA-256, 12 hex) | — |
| `custom` | Lo que retorne tu función | `customMask(value, context)` |

```typescript
// Redactar salario para todos excepto hr_admin y finance_admin
acl.addMaskRule({
  toolName: 'hr.getEmployeeProfile',
  field: 'salary',
  maskType: 'redact',
  visibleToRoles: ['hr_admin', 'finance_admin'],
});

// Mostrar últimos 4 dígitos de tarjeta
acl.addMaskRule({
  toolName: 'billing.getCard',
  field: 'cardNumber',
  maskType: 'partial',
  visibleToRoles: ['billing_admin'],
  partialConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
});

// Hashear email para auditoría
acl.addMaskRule({
  toolName: 'users.search',
  field: 'email',
  maskType: 'hash',
  visibleToRoles: ['*'],          // Nadie ve el email en claro
});
```

### Campos anidados y arrays

Ambos soportados via dot-notation:

```typescript
acl.addMaskRule({
  toolName: 'crm.getContact',
  field: 'billing.bankAccount',   // Objeto anidado
  maskType: 'redact',
  visibleToRoles: ['finance_admin'],
});
```

Si el resultado de la tool es un array, la máscara se aplica a cada elemento individualmente. El input original nunca se muta — `ACLService.maskFields()` trabaja sobre un `structuredClone`.

---

## Componentes auxiliares

### Rate Limiter

Límites de ventana fija, separados por tenant y usuario. Opera en la fase `pre/agent_start` — bloquea antes de llamar al LLM.

```typescript
import { RateLimiterMiddleware, RateLimiter } from 'agent349';

const limiter = new RateLimiter();
const rateLimiterMw = new RateLimiterMiddleware(limiter, {
  perTenant: { minute: 100 },
  perUser: { minute: 20 },
});
```

Cuando el límite se supera, el middleware retorna `block` y el `AgentLoop` lanza `AccessDeniedError`.

### Input Sanitizer

Detecta inyección de prompts con 23 patrones predefinidos (agrupados en `role_override`, `instruction_inject`, `delimiter_escape`, `context_manipulation`). El resultado depende del nivel de riesgo:

| Nivel | Acción | Resultado |
|---|---|---|
| `high` | `block` | Request rechazado, `AccessDeniedError` |
| `medium` | `modify` | Substrings peligrosos reemplazados, loop continúa |
| `low` | `continue` | Log del evento, request continúa sin cambios |

```typescript
import { InputSanitizerMiddleware, InputSanitizer } from 'agent349';

const sanitizer = new InputSanitizer();
const sanitizerMw = new InputSanitizerMiddleware(sanitizer);
```

---

## Seguridad en RAG — dos capas

El sistema RAG tiene su propio modelo de seguridad que opera de forma diferente al ACL de tools.

### Capa 1 — ACL de tool (misma que cualquier tool)

`rag.search` es un `Tool` como cualquier otro. Registrá una política en `ACLService` para controlar quién puede invocarlo:

```typescript
acl.addPolicy({
  resourceType: 'tool',
  resourceId: 'rag.search',
  allowedRoles: ['employee', 'manager'],
});
```

### Capa 2 — RAGFilter por documento

Esta es la capa crítica. `DataFilter` con `scope: 'rag'` genera un `RAGFilter` que se inyecta en la query al vector store antes de la búsqueda:

```typescript
acl.addDataFilter({ scope: 'rag', filterType: 'tenant_isolation' });
acl.addDataFilter({ scope: 'rag', filterType: 'role_based' });

// Internamente, ACLService.getRAGFilters(context) produce:
// { tenantId: 'acme', accessRoles: ['employee'] }
```

El vector store traduce esto a un filtro sobre la metadata de cada chunk. Con `MeilisearchAdapter`:

```
tenantId = 'acme' AND (accessRoles IN ['employee', '*'] OR accessRoles IS EMPTY)
```

Un usuario con rol `employee` **nunca recibe** chunks marcados para `hr_admin` o `finance_admin`, aunque haga exactamente la misma query. El aislamiento opera a nivel de resultado de búsqueda, no solo de invocación del tool.

### Por qué son complementarias, no redundantes

- **Capa 1** responde: ¿puede este usuario buscar en el RAG?
- **Capa 2** responde: ¿qué documentos puede encontrar dentro del RAG?

Un usuario puede tener permiso de invocar `rag.search` pero recibir resultados distintos que otro usuario con diferente rol, aunque ambos hagan la misma pregunta.

### Requisito de ingesta

Para que el filtrado funcione, los documentos deben ingestarse con la metadata correcta:

```typescript
await orch.rag.ingest({
  source: { type: 'text', content: politicaFinanzas },
  collection: 'politicas',
  metadata: {
    documentId: 'politica-gastos-v2',
    tenantId: 'acme',
    accessRoles: ['finance_viewer', 'finance_admin'],  // Quiénes pueden leerlo
    tags: ['finanzas', 'gastos'],
  },
});
```

Documentos sin `accessRoles` (array vacío o ausente) son públicos dentro del tenant. Los `accessRoles` se definen al momento de ingesta y se propagan a cada chunk.

---

## Middleware Chain — arquitectura de ejecución

### SecurityMiddlewareChain

Orquesta todos los middlewares. Ejecuta en dos fases:

- **`pre`:** antes de la operación (bloquear o modificar input)
- **`post`:** después de la operación (filtrar o modificar output)

Cada middleware tiene una prioridad numérica — menor número = ejecuta primero. La cadena se detiene inmediatamente en el primer `block`.

### Orden de ejecución por defecto

| Middleware | Fase | Prioridad | Scope |
|---|---|---|---|
| `RateLimiterMiddleware` | pre | 10 | agent |
| `InputSanitizerMiddleware` | pre | 20 | agent |
| `ToolACLMiddleware` | pre | 30 | tool |
| `DataFilterMiddleware` | post | 40 | tool |
| `FieldMaskMiddleware` | post | 50 | tool |

### Construir la cadena

```typescript
import {
  ACLService,
  SecurityMiddlewareChain,
  ToolACLMiddleware,
  DataFilterMiddleware,
  FieldMaskMiddleware,
  InputSanitizerMiddleware,
  RateLimiterMiddleware,
  InputSanitizer,
  RateLimiter,
} from 'agent349';

const acl = new ACLService({
  policies: [...],
  maskRules: [...],
  dataFilters: [...],
});

const chain = new SecurityMiddlewareChain([
  new RateLimiterMiddleware(new RateLimiter(), { perUser: { minute: 30 } }),
  new InputSanitizerMiddleware(new InputSanitizer()),
  new ToolACLMiddleware(acl),
  new DataFilterMiddleware(acl),
  new FieldMaskMiddleware(acl),
]);
```

### Middlewares custom

Implementar la interfaz `SecurityMiddleware`:

```typescript
import type { SecurityMiddleware, MiddlewareResult } from 'agent349';

const auditMiddleware: SecurityMiddleware = {
  name: 'audit-logger',
  phase: 'pre',
  priority: 25,
  appliesTo: 'tool',
  async execute(context, payload) {
    await myAuditLogger.log({ tool: payload.toolName, user: context.userId });
    return { action: 'continue' };
  },
};

chain.add(auditMiddleware);
```

---

## Wiring con Orchestrator (recomendado para producción)

`Orchestrator` expone dos métodos de registro que habilitan el pipeline de seguridad completo. Una vez registrados, se propagan a **cada** `AgentLoop` creado por `chat()` y al resume de HITL — no hay que pasarlos en cada request.

```typescript
import {
  Orchestrator,
  ACLService,
  ToolACLMiddleware,
  SecurityMiddlewareChain,
} from 'agent349';

const orch = await Orchestrator.create('./config.json');

const acl = new ACLService({ policies: [ /* ... */ ] });

// Capa 1 — filtrado de tools antes del prompt:
// el LLM solo recibe las tools que el usuario puede invocar
orch.registerACLService(acl);

// Capa 2 — interceptor pre-ejecución (segunda línea de defensa):
// bloquea tool calls incluso si el LLM alucinó una tool denegada
const chain = new SecurityMiddlewareChain();
chain.use(new ToolACLMiddleware(acl));
orch.registerSecurityChain(chain);

// A partir de aquí, todo orch.chat() y todo orch.approve() (resume HITL)
// aplican ACL y security automáticamente.
const response = await orch.chat(agentId, message, context);
```

Por qué ambas capas son necesarias en producción:

| Capa | Qué hace | Qué cubre |
|------|----------|-----------|
| `registerACLService` | Filtra descriptores de tools antes de armar el prompt | Reduce tokens; el LLM no intenta usar tools vedadas |
| `registerSecurityChain` + `ToolACLMiddleware` | Intercepta cada tool call pre-ejecución | Protege contra alucinaciones: el LLM invoca una tool que no estaba en el prompt |

En desarrollo local sin multi-tenancy es válido no registrar ninguno de los dos.

---

## Wiring con AgentLoop (bajo nivel)

Cuando se instancia `AgentLoop` directamente (casos de uso avanzados o tests), los componentes se pasan por constructor:

```typescript
import { AgentLoop } from 'agent349';

const loop = new AgentLoop(
  resolvedAgent,
  toolRegistry,
  skillRegistry,
  llmProvider,
  memoryManager,
  eventBus,
  tokenTracker,
  chain,    // SecurityMiddlewareChain — posición 8
  acl,      // ACLService              — posición 9
);
```

Ambos son opcionales. Si no se pasan, el loop corre sin seguridad.

---

## Buenas prácticas

**1. Definí las políticas al inicio, no en cada request.**
`ACLService` es stateful pero thread-safe para lecturas concurrentes. Construilo una vez, en el bootstrap de la aplicación.

**2. Usá `deniedRoles` para casos de excepción explícita.**
Si una regla de negocio dice "los contractors nunca deben ver datos salariales aunque tengan rol finance", usá `deniedRoles`. Las políticas de deny son más explícitas y auditables que reestructurar `allowedRoles`.

**3. El modelo whitelist tiene una trampa.**
Recursos sin política son públicos. En sistemas donde el default debería ser restrictivo, registrá una política catch-all o documentá explícitamente qué tools son públicas.

**4. Separar `scope: 'rag'` de `scope: 'tool'` para RAG.**
`tenant_isolation` y `role_based` con `scope: 'all'` aplican a todo. Si tenés tools internas que no deben ser filtradas por `accessRoles` (porque retornan datos ya aislados), usá `scope: 'rag'` para el filtro de documentos y `scope: 'tool'` con `toolName` explícito para el resto.

**5. Los `accessRoles` de RAG son ingest-time.**
No hay una capa de ACL dinámica sobre documentos. Si cambian las políticas de acceso, los documentos afectados deben re-ingestarse con la nueva metadata. Diseñá la ingesta para que esto sea operable.

**6. Field masking no reemplaza el control de acceso.**
`redact` y `partial` son para UI/UX — evitan que datos sensibles aparezcan en respuestas de texto del LLM. Si un usuario no debería tener acceso a un recurso en absoluto, usá una política ACL, no una máscara.

**7. `hash` revela estructura aunque oculte el valor.**
Un campo hasheado todavía ocupa espacio en el payload. Si la presencia del campo es sensible (e.g., `hasActiveInvestigation: true`), usá `redact`.

---

## Anti-patrones

**❌ Confiar en que el LLM no pedirá tools bloqueadas.**
El LLM puede alucinarse y generar una tool call hacia una tool que no está en sus descriptores. El `AgentLoop` valida via `ACLService` antes de ejecutar — pero sin `ACLService` conectado, cualquier tool del registry es ejecutable.

**❌ Poner lógica de negocio en `conditions` en vez de en la tool.**
Las condiciones de ACL son para contexto del request (tenant, roles, metadata del usuario). Si la lógica depende del estado de la base de datos ("el empleado tiene acceso si es gerente del proyecto"), ponela en la tool, no en una condición ACL.

**❌ Registrar `allowedRoles: ['*']` en resources sensibles.**
Rol `'*'` significa "cualquier usuario autenticado". En un sistema multi-tenant, eso incluye usuarios de todos los tenants. Para tools globales sensibles, combiná con `conditions` que verifiquen `tenantId`.

**❌ Usar `scope: 'all'` para filtros custom con lógica específica de tool.**
Un filtro custom con `scope: 'all'` y sin `toolName` aplica a cada tool result. Si la lógica solo tiene sentido para una tool específica, siempre especificá `toolName`.

**❌ No registrar la cadena de seguridad porque "el agente es interno".**
Un agente "interno" que procesa input del usuario sigue siendo vulnerable a inyección de prompts. El `InputSanitizerMiddleware` es barato (sin I/O externo) y vale la pena tenerlo siempre.

**❌ Re-crear `ACLService` por request.**
Las políticas no cambian por request. Crear una nueva instancia en cada llamada re-registra todo y aumenta el garbage pressure sin ningún beneficio.

---

## Trade-offs de performance

| Operación | Latencia | Costo tokens | Notas |
|---|---|---|---|
| `ACLService.evaluate()` | < 0.1ms | 0 | Lookup en Map + evaluación O(n policies) |
| `ACLService.filterTools()` | < 0.5ms | 0 | Una evaluación por tool registrada |
| `ACLService.maskFields()` | < 1ms | 0 | `structuredClone` + traversal; costo crece con tamaño del objeto |
| `ACLService.filterToolResult()` | < 1ms | 0 | Array traversal; costo crece con cantidad de registros |
| `InputSanitizer.analyze()` | < 1ms | 0 | Regex matching contra 23 patrones; sin I/O |
| `RateLimiter.check()` | < 0.1ms | 0 | Map lookup in-memory; sin I/O |
| `ACLService.getRAGFilters()` | < 0.1ms | 0 | Linear scan de dataFilters registrados |

**La seguridad agrega < 2ms de overhead por request** en la implementación in-memory. El cuello de botella es siempre el LLM call (200–3000ms) y la tool execution.

En producción con rate limiter conectado a Redis (para compartir estado entre instancias), agregar ~5–15ms de latencia de red. Para el resto de las capas (ACL, masking, filtering), in-memory es correcto y performante.
