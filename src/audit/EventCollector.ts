import type { AgentEvent } from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import type { AuditRecord } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Partial record produced by a per-event mapper function.
 * The mandatory identity fields (`id`, `timestamp`, `requestId`, etc.) are
 * filled in by the {@link AuditLogger} after the mapper runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventMapper = (data: Record<string, any>) => Partial<AuditRecord>;

// ─────────────────────────────────────────────────────────────────────────────
// Event → AuditRecord mapping table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps each EventBus event name to a function that extracts a partial
 * {@link AuditRecord} from the event's `data` payload.
 *
 * Context fields (`tenantId`, `userId`, `agentId`, `sessionId`, `requestId`)
 * are read from `data._context` when present and merged by the logger.
 */
// ─── Helper: build metrics/security without undefined-valued keys ────────────

type MetricsBlock = NonNullable<import('../types/index.js').AuditRecord['metrics']>;
type SecurityBlock = NonNullable<import('../types/index.js').AuditRecord['security']>;

// Parameter types explicitly allow `| undefined` to satisfy exactOptionalPropertyTypes
type MetricsInput = {
  durationMs?: number | undefined;
  tokensInput?: number | undefined;
  tokensOutput?: number | undefined;
  estimatedCostUsd?: number | undefined;
  streamOpenMs?: number | undefined;
  timeToFirstChunkMs?: number | undefined;
  timeToFirstTokenMs?: number | undefined;
  generationMs?: number | undefined;
  visibleTokensPerSecond?: number | undefined;
  reasoningTokens?: number | undefined;
  visibleOutputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
};

type SecurityInput = {
  aclDecision?: import('../types/index.js').ACLDecision | undefined;
  fieldsMasked?: string[] | undefined;
  injectionDetected?: boolean | undefined;
  riskLevel?: string | undefined;
};

function metrics(m: MetricsInput): MetricsBlock | undefined {
  const result: MetricsBlock = {};
  if (m.durationMs !== undefined) result.durationMs = m.durationMs;
  if (m.tokensInput !== undefined) result.tokensInput = m.tokensInput;
  if (m.tokensOutput !== undefined) result.tokensOutput = m.tokensOutput;
  if (m.estimatedCostUsd !== undefined) result.estimatedCostUsd = m.estimatedCostUsd;
  if (m.streamOpenMs !== undefined) result.streamOpenMs = m.streamOpenMs;
  if (m.timeToFirstChunkMs !== undefined) result.timeToFirstChunkMs = m.timeToFirstChunkMs;
  if (m.timeToFirstTokenMs !== undefined) result.timeToFirstTokenMs = m.timeToFirstTokenMs;
  if (m.generationMs !== undefined) result.generationMs = m.generationMs;
  if (m.visibleTokensPerSecond !== undefined) {
    result.visibleTokensPerSecond = m.visibleTokensPerSecond;
  }
  if (m.reasoningTokens !== undefined) result.reasoningTokens = m.reasoningTokens;
  if (m.visibleOutputTokens !== undefined) result.visibleOutputTokens = m.visibleOutputTokens;
  if (m.cachedInputTokens !== undefined) result.cachedInputTokens = m.cachedInputTokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function security(s: SecurityInput): SecurityBlock | undefined {
  const result: SecurityBlock = {};
  if (s.aclDecision !== undefined) result.aclDecision = s.aclDecision;
  if (s.fieldsMasked !== undefined) result.fieldsMasked = s.fieldsMasked;
  if (s.injectionDetected !== undefined) result.injectionDetected = s.injectionDetected;
  if (s.riskLevel !== undefined) result.riskLevel = s.riskLevel;
  return Object.keys(result).length > 0 ? result : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────

const EVENT_MAPPERS: Record<string, EventMapper> = {
  'agent.loop.start': (_data) => ({
    category: 'agent',
    action: 'loop_start',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'Agent loop started' },
  }),

  'agent.loop.end': (data) => {
    const m = metrics({ durationMs: data.durationMs as number | undefined });
    return {
      category: 'agent',
      action: 'loop_end',
      outcome: 'success',
      severity: 'info',
      detail: { summary: `Agent loop completed in ${data.iterations as number} iterations` },
      ...(m !== undefined && { metrics: m }),
    };
  },

  'llm.call.start': (data) => ({
    category: 'llm',
    action: 'call_start',
    outcome: 'success',
    severity: 'info',
    detail: {
      summary: 'LLM call started',
      input: {
        model: data.model,
        provider: data.provider,
        reasoningEffort: data.reasoningEffort,
      },
    },
  }),

  'llm.call.end': (data) => {
    const usage = data.usage as
      | { inputTokens?: number; outputTokens?: number; cost?: number }
      | undefined;
    const performance = data.performance as
      | {
          streamOpenMs?: number;
          timeToFirstChunkMs?: number;
          timeToFirstTokenMs?: number;
          generationMs?: number;
          visibleTokensPerSecond?: number;
          reasoningTokens?: number;
          visibleOutputTokens?: number;
          cachedInputTokens?: number;
        }
      | undefined;
    const m = metrics({
      durationMs: data.latencyMs as number | undefined,
      tokensInput: usage?.inputTokens,
      tokensOutput: usage?.outputTokens,
      estimatedCostUsd: usage?.cost,
      streamOpenMs: performance?.streamOpenMs,
      timeToFirstChunkMs: performance?.timeToFirstChunkMs,
      timeToFirstTokenMs: performance?.timeToFirstTokenMs,
      generationMs: performance?.generationMs,
      visibleTokensPerSecond: performance?.visibleTokensPerSecond,
      reasoningTokens: performance?.reasoningTokens,
      visibleOutputTokens: performance?.visibleOutputTokens,
      cachedInputTokens: performance?.cachedInputTokens,
    });
    return {
      category: 'llm',
      action: 'call_end',
      outcome: 'success',
      severity: 'info',
      detail: {
        summary: 'LLM call completed',
        output: {
          model: data.model,
          provider: data.provider,
          reasoningEffort: data.reasoningEffort,
        },
      },
      ...(m !== undefined && { metrics: m }),
    };
  },

  'llm.call.error': (_data) => ({
    category: 'llm',
    action: 'call_error',
    outcome: 'error',
    severity: 'warning',
    detail: { summary: 'LLM call failed' },
  }),

  'llm.fallback': (_data) => ({
    category: 'llm',
    action: 'fallback',
    outcome: 'success',
    severity: 'warning',
    detail: { summary: 'LLM provider fallback triggered' },
  }),

  'tool.call.start': (data) => ({
    category: 'tool',
    action: 'call_start',
    outcome: 'success',
    severity: 'info',
    resource: { type: 'tool', id: data.toolName as string, name: data.toolName as string },
    detail: { summary: `Tool ${data.toolName as string} started` },
  }),

  'tool.call.end': (data) => {
    const m = metrics({ durationMs: data.durationMs as number | undefined });
    return {
      category: 'tool',
      action: 'call_end',
      outcome: data.success ? 'success' : 'failure',
      severity: data.success ? 'info' : 'warning',
      resource: { type: 'tool', id: data.toolName as string, name: data.toolName as string },
      detail: { summary: `Tool ${data.toolName as string} completed` },
      ...(m !== undefined && { metrics: m }),
    };
  },

  'tool.call.error': (data) => ({
    category: 'tool',
    action: 'call_error',
    outcome: 'error',
    severity: 'warning',
    resource: { type: 'tool', id: data.toolName as string, name: data.toolName as string },
    detail: { summary: `Tool ${data.toolName as string} failed` },
  }),

  'rag.query_rewrite.end': (data) => ({
    category: 'rag',
    action: 'query_rewrite',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'RAG query rewrite completed' },
    metrics: { durationMs: data.latencyMs as number },
  }),

  'rag.embed.end': (data) => ({
    category: 'rag',
    action: 'embedding',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'RAG query embedding completed' },
    metrics: { durationMs: data.latencyMs as number },
  }),

  'rag.search.end': (data) => ({
    category: 'rag',
    action: 'vector_search',
    outcome: 'success',
    severity: 'info',
    detail: {
      summary: 'RAG vector search completed',
      output: { totalFound: data.totalFound },
    },
    metrics: { durationMs: data.latencyMs as number },
  }),

  'rag.rerank.end': (data) => ({
    category: 'rag',
    action: 'rerank',
    outcome: 'success',
    severity: 'info',
    detail: {
      summary: 'RAG reranking completed',
      output: { finalCount: data.finalCount },
    },
    metrics: { durationMs: data.latencyMs as number },
  }),

  'rag.pipeline.complete': (data) => ({
    category: 'rag',
    action: 'search_complete',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'RAG pipeline search completed', output: data.metrics },
    metrics: { durationMs: data.totalLatencyMs as number },
  }),

  'rag.chat.stage': (data) => ({
    category: 'rag',
    action: data.stage as string,
    outcome: 'success',
    severity: 'info',
    detail: {
      summary: `RAG chat stage completed: ${data.stage as string}`,
      ...(data.detail !== undefined && { output: data.detail }),
    },
    metrics: { durationMs: data.durationMs as number },
  }),

  'security.acl.denied': (data) => {
    const s = security({
      aclDecision: data.decision as import('../types/index.js').ACLDecision | undefined,
    });
    return {
      category: 'security',
      action: 'access_denied',
      outcome: 'blocked',
      severity: 'warning',
      detail: { summary: `ACL denied access: ${data.reason as string}` },
      ...(s !== undefined && { security: s }),
    };
  },

  'security.approval.denied': (data) => ({
    category: 'security',
    action: 'approval_denied',
    outcome: 'blocked',
    severity: 'warning',
    detail: {
      summary: `Approver not authorized to ${data.decision as string} action ${data.actionId as string}: ${data.reason as string}`,
    },
    resource: { type: 'approval', id: data.actionId as string, name: data.toolName as string },
  }),

  'security.injection.detected': (data) => {
    const s = security({ injectionDetected: true, riskLevel: data.riskLevel as string });
    return {
      category: 'security',
      action: 'injection_detected',
      outcome: data.action === 'block' ? 'blocked' : 'success',
      severity: 'critical',
      ...(s !== undefined && { security: s }),
      detail: {
        summary: `Prompt injection detected: ${data.riskLevel as string}`,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        input: data.patterns,
      },
    };
  },

  'security.ratelimit.hit': (data) => ({
    category: 'security',
    action: 'rate_limit_hit',
    outcome: 'blocked',
    severity: 'warning',
    detail: { summary: `Rate limit hit for key: ${data.key as string}` },
  }),

  'security.field.masked': (data) => {
    const s = security({ fieldsMasked: data.fields as string[] | undefined });
    return {
      category: 'security',
      action: 'field_masked',
      outcome: 'success',
      severity: 'info',
      ...(s !== undefined && { security: s }),
      detail: { summary: 'Fields masked by security policy' },
    };
  },

  'tokens.recorded': (data) => {
    const m = metrics({ tokensInput: data.tokens as number | undefined });
    return {
      category: 'system',
      action: 'token_usage',
      outcome: 'success',
      severity: 'info',
      detail: { summary: `Token usage recorded: ${data.tokens as number} tokens` },
      ...(m !== undefined && { metrics: m }),
    };
  },

  'memory.compress': (_data) => ({
    category: 'memory',
    action: 'compression',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'Memory compression executed' },
  }),

  'session.created': (data) => ({
    category: 'session',
    action: 'session_created',
    outcome: 'success',
    severity: 'info',
    resource: { type: 'session', id: data.sessionId as string },
    detail: { summary: 'Session created' },
  }),

  'session.closed': (data) => ({
    category: 'session',
    action: 'session_closed',
    outcome: 'success',
    severity: 'info',
    resource: { type: 'session', id: data.sessionId as string },
    detail: { summary: 'Session closed' },
  }),

  'skill.activated': (data) => ({
    category: 'skill',
    action: 'skill_activated',
    outcome: 'success',
    severity: 'info',
    resource: { type: 'skill', id: data.skillId as string, name: data.skillId as string },
    detail: { summary: `Skill ${data.skillId as string} activated` },
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// EventCollector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribes to all auditable events on the {@link EventBus} and converts
 * each into a partial {@link AuditRecord} that is forwarded to a caller-supplied
 * `log` callback.
 *
 * This class owns the subscription lifecycle. Call {@link stop} to remove all
 * listeners (e.g. during graceful shutdown or in test teardown).
 *
 * ### Context extraction
 * Each incoming event may carry context fields under `data._context` —
 * a plain object with `tenantId`, `userId`, `agentId`, `sessionId`, and/or
 * `requestId`. These are merged into the partial record before passing it to
 * the `log` callback, allowing the logger to fill in correlation fields
 * automatically without requiring manual instrumentation at every call site.
 *
 * @example
 * ```typescript
 * const collector = new EventCollector(eventBus, (partial) => {
 *   auditLogger.log(partial);
 * });
 * collector.start();
 * // ...later:
 * collector.stop();
 * ```
 */
export class EventCollector {
  readonly #bus: EventBus;
  readonly #log: (record: Partial<AuditRecord>) => void;
  /** Handlers keyed by event name, stored for later removal. */
  readonly #handlers = new Map<string, (event: AgentEvent) => void>();

  /**
   * @param eventBus - The shared EventBus to subscribe on.
   * @param log      - Callback invoked with a partial AuditRecord for each captured event.
   */
  constructor(eventBus: EventBus, log: (record: Partial<AuditRecord>) => void) {
    this.#bus = eventBus;
    this.#log = log;
  }

  /**
   * Registers listeners for all mapped events. Idempotent — calling `start()`
   * when already active first calls `stop()` to reset.
   */
  start(): void {
    this.stop();

    for (const [eventName, mapper] of Object.entries(EVENT_MAPPERS)) {
      const handler = (event: AgentEvent): void => {
        const data = event.data;
        const partial = mapper(data);

        // Merge context fields injected by the emitter under `_context`
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = data._context as Record<string, any> | undefined;
        if (ctx !== undefined) {
          if (ctx.tenantId !== undefined) partial.tenantId = ctx.tenantId as string;
          if (ctx.userId !== undefined) partial.userId = ctx.userId as string;
          if (ctx.agentId !== undefined) partial.agentId = ctx.agentId as string;
          if (ctx.sessionId !== undefined) partial.sessionId = ctx.sessionId as string;
          if (ctx.requestId !== undefined) partial.requestId = ctx.requestId as string;
        }

        this.#log(partial);
      };

      this.#handlers.set(eventName, handler);
      this.#bus.on(eventName, handler);
    }
  }

  /**
   * Removes all listeners registered by this collector.
   */
  stop(): void {
    for (const [eventName, handler] of this.#handlers.entries()) {
      this.#bus.off(eventName, handler);
    }
    this.#handlers.clear();
  }

  /** Number of events currently being listened to. */
  get listenerCount(): number {
    return this.#handlers.size;
  }
}
