# Observability

Agent349 reports what it does through an in-process **EventBus**. Three
consumers turn those events into three planes with different audiences:

| Plane            | Question                                 | Audience               | Guide                   |
| ---------------- | ---------------------------------------- | ---------------------- | ----------------------- |
| Technical logs   | What is the system doing right now?      | Developers, SRE        | This page               |
| Token accounting | What did it cost, and who is over quota? | FinOps, administrators | This page               |
| Audit trail      | Who did what, with which outcome?        | Security, compliance   | [Audit trail](audit.md) |

## Events

```ts
orch.events.on('tool.call.end', (event) => {
  const { toolName, durationMs, success } = event.data as {
    toolName: string;
    durationMs: number;
    success: boolean;
  };
  metrics.histogram('tool_duration_ms', durationMs, { toolName, success: String(success) });
});

orch.events.on('security.*', (event) => alerting.notify(event.type, event.data));

declare const metrics: {
  histogram(name: string, value: number, tags: Record<string, string>): void;
};
declare const alerting: { notify(type: string, data: unknown): void };
```

Patterns support `*` wildcards. Events emitted during a run carry `_context`
(tenant, user, agent, session and request IDs) for correlation.

| Family                                                | Examples                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `agent.*`                                             | `agent.loop.start`, `agent.loop.end`, `agent.plan.generated`                                                                    |
| `llm.*`                                               | `llm.call.start`, `llm.call.end`, `llm.call.error`, `llm.token`                                                                 |
| `tool.*`                                              | `tool.call.start`, `tool.call.end`                                                                                              |
| `security.*`                                          | `security.acl.denied`, `security.injection.detected`, `security.ratelimit.hit`, `security.field.masked`, `security.untrusted.*` |
| `approval.*`                                          | `approval.required`, `approval.resolved`, `approval.resume_failed`                                                              |
| `rag.*`, `memory.*`, `session.*`, `tokens.*`, `mcp.*` | Pipeline stages, compression, lifecycle, usage, MCP connections                                                                 |

The EventBus is in-process. In a cluster, each instance sees only its own
events. Forward them to your own bus or log pipeline if you need a global view.

## Technical logs

The SDK never writes to stdout by itself. Enable a logger:

```json config
{
  "logging": {
    "adapter": "console",
    "level": "info",
    "format": "json",
    "includeData": true,
    "redactFields": ["password", "token", "apiKey"]
  }
}
```

Or send logs to your stack by extending `LoggerAdapter`:

```ts
import { LoggerAdapter, Orchestrator } from 'agent349';
import type { LogEntry, SDKConfig } from 'agent349';

class JsonLinesLogger extends LoggerAdapter {
  readonly name = 'json-lines';
  // Called on the hot path: keep it synchronous and never throw.
  log(entry: LogEntry): void {
    process.stderr.write(
      JSON.stringify({ level: entry.level, event: entry.event, ...entry.context }) + '\n',
    );
  }
}

declare const config: SDKConfig;
const orch = await Orchestrator.fromConfig(config, { logger: new JsonLinesLogger() });
```

The same pattern plugs in pino, winston, Loki or an OpenTelemetry log exporter.

## Token accounting and quotas

Every model call (agent reasoning, `complete()`, query rewriting, reranking and
embeddings) is recorded with its tokens and cost, and attributed to tenant,
user, agent, session, request, model, provider, skill and tool.

```json config
{
  "storage": { "backends": { "shared": { "type": "redis", "url": "${REDIS_URL}" } } },
  "tokens": {
    "backend": "shared",
    "limitMode": "enforce",
    "limits": {
      "perTenant": { "daily": 2000000, "monthly": 40000000 },
      "perUser": { "daily": 100000, "monthly": 2000000 }
    },
    "pricing": {
      "claude-opus-5": { "input": 0.005, "output": 0.025 },
      "gpt-6-sol": { "input": 0.002, "output": 0.01 }
    }
  }
}
```

Prices are USD per 1,000 tokens, and you maintain them. A cost reported by the
provider takes precedence, and models without a price count as `0`.
`limitMode` is `observe` by default: usage is recorded and a call that would
exceed a quota emits `tokens.limit.observed`, but nothing is blocked. Set
`enforce`, with limits sized for your workload, to reject such calls with
`TokenLimitError`. `disabled` turns quota checks and recording off.

```ts
const month = { from: new Date('2026-09-01'), to: new Date('2026-10-01') };

const tenant = await orch.tokens.getByTenant('acme', month);
console.log(tenant.totalCostUsd, tenant.byModel, tenant.byAgent);

await orch.tokens.getByUser('acme', 'ana', month);
await orch.tokens.getBySession('sess-9');
await orch.tokens.getByRequest('req-123');
```

Each response also carries its own usage: `response.usage.totalInputTokens`,
`totalOutputTokens`, `totalCostUsd` and a per-iteration breakdown.

Quota checks read and then write, so they are approximate under concurrency:
calls already in flight can overshoot a limit. With more than one instance,
use a shared backend, or each instance enforces its own quota. See
[Deployment](deployment.md).

## One view per request

```ts
const report = await orch.observability.getRequestReport('req-123');
console.log(report.usage.totalCostUsd, report.auditTrail.length);
```

`orch.observability` exposes `events`, `tokens` and `audit` together, plus
cross-plane reads like this one.

More detail: the Spanish [logging](../es/LOGGING_MANUAL.md) and
[tokens](../es/TOKENS_MANUAL.md) manuals.
