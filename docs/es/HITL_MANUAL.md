# HITL — Guía de Producción

> Human-in-the-Loop: operación, integración REST y MongoDB

---

## 1. Cuándo usar HITL

| Situación | Recomendación |
|-----------|---------------|
| Acciones irreversibles (transferencias, borrados, envíos masivos) | Trigger `always` sobre esos tools |
| Umbral de monto o riesgo | Trigger `input_field` con `operator: 'gt'` |
| Usuarios con roles limitados | Trigger `context_field` sobre `roles` |
| Aprobación condicional (horario, jurisdicción) | Trigger `custom` con función evaluate |

---

## 2. Stack mínimo de producción

```
┌─────────────────────────────────────────────────────────┐
│  Tu aplicación (Express / Next.js / Fastify)            │
│                                                         │
│  orch.chat() ──► response.suspended                     │
│  orch.approve()  ◄── POST /api/approvals/:id/approve    │
│  orch.retryResume()                                     │
└─────────────────────────────────────────────────────────┘
           │               │
           ▼               ▼
┌─────────────────┐  ┌────────────────────────────┐
│  MongoPending   │  │  Notificaciones:            │
│  ActionStore    │  │  - EventChannel (EventBus)  │
│  (MongoDB Atlas)│  │  - WebhookChannel (Slack)   │
└─────────────────┘  └────────────────────────────┘
```

---

## 3. MongoDB — Setup

### 3.1 Crear el store

```typescript
import { MongoPendingActionStore } from 'agent349';

const store = await MongoPendingActionStore.create({
  uri: process.env.MONGO_URL!,
  database: 'agent349',
  collection: 'pending_actions',     // default — se puede omitir
  maxSnapshotBytes: 2 * 1024 * 1024, // 2 MB — protege documentos grandes
});
```

### 3.2 Índices creados automáticamente

El store crea 4 índices al inicializarse:

| Índice | Campos | Propósito |
|--------|--------|-----------|
| Consulta principal | `{ tenantId, status, createdAt }` | Cola de aprobación por tenant |
| Expiración | `{ status, expiresAt }` | `getExpired()` eficiente |
| Cola por rol | `{ approverRoles, status }` | Filtrado por rol de aprobador |
| TTL opcional | `{ updatedAt }` (si se configura) | Limpieza automática de registros terminales |

### 3.3 Variables de entorno recomendadas

```dotenv
MONGO_URL=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true
```

### 3.4 `maxSnapshotBytes` y truncamiento

Si el `messagesSnapshot` (checkpoint de la conversación) excede `maxSnapshotBytes`:
- El snapshot se descarta silenciosamente
- `savedContext.snapshotTruncated = true` queda en el documento
- La acción se crea con estado `pending` (la aprobación puede proceder)
- **Fase 2 (resume automático) no es posible** — el agente deberá reiniciar la conversación desde el estado post-tool

Ajustar `maxSnapshotBytes` según el `maxMessages` de la ventana de memoria y el tamaño promedio de mensaje.

---

## 3.5 Autorización de aprobadores

Desde 0.4, `approve()` y `reject()` verifican que el aprobador pertenezca al
tenant de la acción y tenga alguno de sus `approverRoles` (o figure en
`approverUsers`; `'*'` admite cualquier rol). Si no, lanzan `AccessDeniedError`,
la acción queda pendiente y se audita como `security/approval_denied`.
`retryResume()` exige el mismo tenant. Si tu aplicación ya autoriza por su
cuenta, `new ApprovalService(…, { authorizeApprovers: false })` desactiva el
chequeo.

Los textos que genera el SDK durante una suspensión están en inglés por
defecto y se pueden reemplazar con `ApprovalConfig.messages` (ver
`DEFAULT_APPROVAL_MESSAGES`).

## 4. Integración REST (Express)

Patrón de referencia para exponer la cola de aprobaciones como API:

```typescript
import express from 'express';

const app = express();
app.use(express.json());

// Helper: extraer ExecutionContext desde JWT/sesión
function contextFromAuth(req: express.Request): ExecutionContext {
  const claims = req.auth as { sub: string; roles: string[]; tenant: string };
  return {
    tenantId: claims.tenant,
    userId: claims.sub,
    roles: claims.roles,
    sessionId: randomUUID(),
    agentId: 'system',
    requestId: randomUUID(),
  };
}

// ── Cola de aprobación para el usuario autenticado ────────────────────────────
app.get('/api/approvals/queue', async (req, res) => {
  const ctx = contextFromAuth(req);
  const pending = await approvalService.getPending({
    tenantId: ctx.tenantId,
    approverRoles: ctx.roles,
    status: ['pending', 'escalated'],
    sortBy: 'risk',
    limit: 50,
  });
  res.json(pending);
});

// ── Detalle de una acción ─────────────────────────────────────────────────────
app.get('/api/approvals/:id', async (req, res) => {
  const action = await approvalService.getById(req.params.id!);
  if (!action) return res.status(404).json({ error: 'Not found' });
  res.json(action);
});

// ── Aprobar (Fase 1 + Fase 2 automáticas) ────────────────────────────────────
app.post('/api/approvals/:id/approve', async (req, res) => {
  try {
    const ctx = contextFromAuth(req);
    // orch.approve() = Fase 1 (tool) + Fase 2 (resume AgentLoop)
    const resumedResponse = await orch.approve(
      req.params.id!,
      { tenantId: ctx.tenantId, userId: ctx.userId, roles: ctx.roles },
      {
        comment: req.body.comment as string | undefined,
        modifiedInput: req.body.modifiedInput,
      },
    );
    // resumedResponse.content = respuesta final del agente
    res.json({
      decision: 'approve',
      agentResponse: resumedResponse.content,
      toolsUsed: resumedResponse.toolsUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // El error más común: acción ya procesada (doble-clic en UI)
    if (msg.includes('cannot be approved')) {
      return res.status(409).json({ error: 'Action already being processed' });
    }
    res.status(500).json({ error: msg });
  }
});

// ── Rechazar ──────────────────────────────────────────────────────────────────
app.post('/api/approvals/:id/reject', async (req, res) => {
  const ctx = contextFromAuth(req);
  const resolution = await approvalService.reject(
    req.params.id!,
    ctx,
    { comment: req.body.comment as string | undefined },
  );
  res.json({ decision: resolution.decision, comment: resolution.comment });
});

// ── Reintentar Fase 2 (si resume_failed) ─────────────────────────────────────
app.post('/api/approvals/:id/retry-resume', async (req, res) => {
  const ctx = contextFromAuth(req);
  const resumed = await orch.retryResume(
    req.params.id!,
    { tenantId: ctx.tenantId, userId: ctx.userId, roles: ctx.roles },
  );
  res.json({ agentResponse: resumed.content });
});

// ── Cancelar (solicitante) ────────────────────────────────────────────────────
app.post('/api/approvals/:id/cancel', async (req, res) => {
  const ctx = contextFromAuth(req);
  await approvalService.cancel(req.params.id!, ctx);
  res.json({ cancelled: true });
});
```

---

## 5. Scheduling — Escalaciones y Expiraciones

Las escalaciones y expiraciones deben procesarse periódicamente. En producción usar un job scheduler (cron, Bull, Temporal):

```typescript
// Cada 60 segundos — procesar escalaciones
setInterval(async () => {
  const result = await approvalService.processEscalations();
  if (result.escalated > 0 || result.expired > 0) {
    logger.info('HITL escalations processed', result);
  }
}, 60_000);

// Cada 5 minutos — procesar expiraciones
setInterval(async () => {
  const expired = await approvalService.processExpirations();
  if (expired > 0) {
    logger.info(`HITL: ${expired} actions expired`);
  }
}, 5 * 60_000);

// Cada semana — limpiar acciones terminales antiguas
setInterval(async () => {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 días
  const deleted = await pendingStore.deleteOlderThan(cutoff);
  logger.info(`HITL cleanup: ${deleted} old terminal actions removed`);
}, 7 * 24 * 60 * 60 * 1000);
```

---

## 6. Manejo de `resume_failed` en operaciones

Cuando `orch.approve()` completa Fase 1 (tool ejecutado) pero falla Fase 2 (resume del AgentLoop), el estado queda en `resume_failed`. El tool NO se debe volver a ejecutar.

**Detección:**

```typescript
// Suscripción al evento
orch.events.on('approval.resume_failed', (event) => {
  const { actionId, error } = event.data as { actionId: string; error: string };
  // Alertar al equipo de operaciones
  alerting.send(`HITL resume_failed: ${actionId} — ${error}`);
});
```

**Recuperación:**

```typescript
// El equipo de ops (o un retry automático) llama:
const retried = await orch.retryResume(
  actionId,
  { tenantId, userId: 'ops-bot', roles: ['ops'] },
);
// Si retryResume también falla → el estado vuelve a resume_failed
// → reintentable tantas veces como sea necesario
```

**¿Cuándo puede ocurrir `resume_failed`?**
- El proceso Node se reinició entre Fase 1 y Fase 2
- El AgentLoop lanzó por un error transitorio del LLM (timeout, rate limit)
- El agente fue dado de baja del Orchestrator entre la suspensión y la reanudación

---

## 7. Concurrencia y atomicidad

| Store | Garantía | Escenario |
|-------|----------|-----------|
| `InMemoryPendingStore` | Event loop de Node — atómico dentro del mismo proceso | Solo desarrollo y testing |
| `MongoPendingActionStore` | `findOneAndUpdate` con filtro de estado — atómico entre procesos | Producción, múltiples réplicas |

**Nunca usar `InMemoryPendingStore` detrás de un load balancer.** Dos instancias del proceso compiten por `claimForExecution` sin coordinación.

---

## 8. Ejemplo completo de configuración

```typescript
// config/hitl.ts
import {
  Orchestrator,
  MongoPendingActionStore,
  ApprovalService,
  ApprovalNotifier,
  EventChannel,
  WebhookChannel,
  ToolExecutor,
  ToolRegistry,
} from 'agent349';

export async function setupHITL(orch: Orchestrator, toolRegistry: ToolRegistry): Promise<ApprovalService> {
  const store = await MongoPendingActionStore.create({
    uri: process.env.MONGO_URL!,
    database: 'agent349',
    maxSnapshotBytes: 2 * 1024 * 1024,
  });

  const notifier = new ApprovalNotifier([
    new EventChannel(orch.events),
    new WebhookChannel({
      url: process.env.APPROVAL_WEBHOOK_URL!,
      headers: { Authorization: `Bearer ${process.env.WEBHOOK_SECRET}` },
      timeoutMs: 5000,
    }),
  ]);

  const toolExecutor = new ToolExecutor(toolRegistry, orch.events);

  const svc = new ApprovalService(store, notifier, toolExecutor, orch.events, {
    defaultTimeoutMinutes: 60,
    expiration: { onExpire: 'expire', notifyRequestor: true, checkIntervalMs: 60_000 },
  });

  svc.addTrigger({
    id: 'large-transfer',
    name: 'Transferencias > USD 10,000',
    enabled: true,
    scope: { tools: ['finance.transfer'] },
    conditions: [{ type: 'input_field', field: 'amount', operator: 'gt', value: 10000 }],
    approvalConfig: {
      approverRoles: ['finance_admin'],
      risk: 'high',
      timeoutMinutes: 60,
      escalation: {
        levels: [{ level: 1, afterMinutes: 30, approverRoles: ['cfo'] }],
      },
    },
    description: 'Transferencias grandes requieren aprobación de finance_admin o CFO',
  });

  orch.registerApprovalService(svc);
  return svc;
}
```

---

## 9. Checklist de producción

- [ ] `MongoPendingActionStore` configurado con URI de Atlas/Mongo
- [ ] `maxSnapshotBytes` ajustado al tamaño de conversación esperado
- [ ] Triggers registrados con `approverRoles` correctos
- [ ] `processEscalations()` corriendo cada 60 s
- [ ] `processExpirations()` corriendo cada 5 min
- [ ] `approval.resume_failed` suscrito con alerting
- [ ] Endpoint `/api/approvals/:id/retry-resume` expuesto (para recuperación ops)
- [ ] `orch.shutdown()` llamado en `SIGTERM`/`SIGINT` para cerrar conexión Mongo
