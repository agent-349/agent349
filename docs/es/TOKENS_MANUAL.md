# Consumo de Tokens y Observabilidad — Guía de Uso

> Métricas de consumo de Agent349: costos por modelo, desglose multi-dimensión y fachada de observabilidad

---

## 1. Introducción

El `TokenTracker` es el **plano de métricas de consumo** de Agent349 (billing, quotas, FinOps), distinto del log técnico y de la auditoría funcional. Registra cada llamada LLM con su costo y permite consultar el consumo desglosado por **tenant, user, agent, session, request, modelo, proveedor, skill y tool**.

---

## 2. Pricing automático

El costo se calcula con una **tabla de precios por modelo** (`config.tokens.pricing`, en USD por 1 000 tokens):

```jsonc
{
  "tokens": {
    "pricing": {
      "claude-opus-5": { "input": 0.005, "output": 0.025 },
      "gpt-6-sol": { "input": 0.002, "output": 0.01 }
    }
  }
}
```

Regla de costo en cada registro:

1. Si el provider reporta `usage.cost`, **ese gana**.
2. Si no, se calcula desde la tabla de precios (`PricingTable`).
3. Modelo sin precio configurado → costo `0`.

El `AgentLoop` aplica esta misma regla, de modo que `AgentResponse.usage.totalCostUsd` y los registros persistidos comparten un costo **consistente**.

```typescript
import { PricingTable } from 'agent349';
const pricing = new PricingTable({ 'gpt-6-sol': { input: 0.002, output: 0.01 } });
pricing.cost('gpt-6-sol', 1000, 500); // 0.007
```

---

## 3. Registro y atribución

Cada llamada LLM se registra con `tokens.record(context, usage)`. El SDK lo hace automáticamente en el `AgentLoop` (razonamiento del agente) y en el `RAGPipeline` / ingestión, **atribuyendo el origen**:

| Origen | `toolName` / `skillId` |
|---|---|
| Reranker LLM en RAG | `toolName: 'rag.search'` |
| Embeddings de ingestión | `toolName: 'rag.ingest'` |
| Razonamiento del agente | (sin tool/skill) |

`usage` admite `provider`, `model`, `skillId`, `toolName` además de los tokens.

---

## 4. Consultas multi-dimensión

```typescript
const range = { from: new Date('2026-01-01'), to: new Date('2026-02-01') };

await orch.tokens.getByTenant('acme', range);
await orch.tokens.getByUser('acme', 'u1', range);
await orch.tokens.getByAgent('acme', 'agent-finance', range);
await orch.tokens.getBySession('sess-1');     // sin rango: toda la conversación
await orch.tokens.getByRequest('req-1');       // costo de un chat() (incluye tools/RAG)
```

Todas devuelven un `TokenUsageSummary`:

```typescript
interface TokenUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel:    Record<string, { tokens; cost }>;
  byProvider: Record<string, { tokens; cost }>;
  byAgent:    Record<string, { tokens; cost }>;
  bySkill:    Record<string, { tokens; cost }>;  // sólo registros atribuidos
  byTool:     Record<string, { tokens; cost }>;  // sólo registros atribuidos
  recordCount: number;
}
```

### Quotas

```typescript
const { allowed, remaining, limit } = await orch.tokens.checkLimit('acme');        // tenant
const perUser = await orch.tokens.checkLimit('acme', 'u1');                         // usuario
```

> **Concurrencia:** el almacenamiento usa read-modify-write no atómico por bucket. Para quotas exactas bajo alta concurrencia, usar un adaptador con append/incremento atómico (p. ej. Redis). Cada dimensión consultable tiene su propio bucket, lo que amplía esa ventana — es un trade-off consciente a favor de lecturas O(1).
>
> **Despliegue en clúster (multi-instancia):** en clúster es **imprescindible** usar un backend compartido (Mongo/Redis) para `tokens`, `session` y `memory`; con `memory` la quota se cuenta por pod. Las dos ventanas de carrera (lost-update y overshoot por llamadas LLM lentas) y los niveles de enforcement (blando / conteo exacto / tope duro) están detallados en **`CLUSTER_MANUAL.md`**.

---

## 5. Fachada de Observabilidad

`orch.observability` unifica los tres planos y agrega lecturas transversales.

```typescript
orch.observability.events   // EventBus (logs en vivo)
orch.observability.tokens   // métricas de consumo
orch.observability.audit    // auditoría funcional (undefined si está deshabilitada)

// Reporte cruzado de un request: costo + rastro de auditoría en una llamada.
const report = await orch.observability.getRequestReport('req-1');
// { requestId, usage: TokenUsageSummary, auditTrail: AuditRecord[] }

await orch.observability.flush(); // flush del buffer de auditoría (0 si deshabilitada)
```

`getRequestReport` es el caso de uso estrella: "¿cuánto costó y qué pasó en este request?" en una sola consulta, combinando consumo y auditoría.

---

## 6. `AgentResponse.usage`

Cada respuesta de `chat()` / `run()` ya incluye el consumo del request:

```typescript
const res = await orch.chat('agent-finance', '¿saldo?', identity);
res.usage.totalInputTokens;
res.usage.totalOutputTokens;
res.usage.totalCostUsd;     // calculado con la tabla de precios
res.usage.byIteration;      // desglose por iteración del loop
```

---

## 6.bis. Media, thinking y batch

### Estimación de preflight con adjuntos

El chequeo de cuota previo (`estimateLLMRequestTokens`) estima el texto a cuatro
caracteres por token, pero **no** mide los bloques media por la longitud de su
base64: lo hace por modalidad (una imagen como un presupuesto fijo de tiles; un
documento por páginas estimadas; audio y vídeo por duración estimada).

La diferencia no es cosmética. Un PDF de 32 KB son ~43 000 caracteres en base64:
la regla de cuatro caracteres lo estimaría en ~11 000 tokens cuando el proveedor
factura unos cientos — suficiente para **bloquear la petición por cuota** con
`tokens.limitMode: 'enforce'`. Sigue siendo una estimación conservadora: el
número autoritativo llega en la respuesta.

### Tokens de *thinking*

Los modelos con razonamiento facturan esos tokens como salida. El SDK sigue esa
convención: `usage.outputTokens` los **incluye**, y quedan visibles aparte en
`performance.reasoningTokens`. Así `usage.cost` cuadra con la factura del
proveedor y las comparaciones entre proveedores siguen teniendo sentido.

`performance.visibleOutputTokens` es lo que vio el usuario, sin los de
razonamiento.

### Tokens por modalidad

Cuando el proveedor lo reporta (Gemini lo hace), la respuesta trae el desglose:

```typescript
response.usage.inputByModality;   // [{ modality: 'image', tokens: 532 }, { modality: 'text', tokens: 6 }]
response.usage.outputByModality;
```

### Precio de batch

No existe un descuento universal de batch en la abstracción. Que hoy varios
proveedores facturen el batch al 50 % es un hecho de sus listas de precios, y se
declara **por modelo**:

```json
{ "gemini-3.8-flash": { "input": 0.00075, "output": 0.00375,
                        "batchInput": 0.000375, "batchOutput": 0.001875 } }
```

Un modelo sin tarifas de batch factura a las síncronas. Los registros llevan
`executionMode: 'sync' | 'batch'` para poder segmentar el consumo, y el consumo
de un batch se registra **al recoger cada resultado** (al enviarlo todavía no se
conocen los tokens). Ver `docs/BATCH_MANUAL.md`.

---

## 7. Referencia rápida

```typescript
// Pricing
new PricingTable({ 'modelo': { input, output } }).cost(model, inTok, outTok)

// TokenTracker
tokens.record(context, usage)               // usage: { inputTokens, outputTokens, provider?, model?, skillId?, toolName?, cost? }
tokens.estimateCost(model, inTok, outTok)
tokens.getByTenant / getByUser / getByAgent (tenant[, id], range)
tokens.getBySession(sessionId) / getByRequest(requestId)
tokens.checkLimit(tenantId, userId?)

// Observability
orch.observability.{ events, tokens, audit }
orch.observability.getRequestReport(requestId)
orch.observability.flush()
```

Ejemplo completo: `examples/tokens-observability.ts`.

Manuales relacionados: `AUDIT_MANUAL.md`, `LOGGING_MANUAL.md`.
