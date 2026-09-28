import { EventEmitter } from 'node:events';
import type { AgentEvent } from '../types/index.js';

/**
 * Handler function invoked when a subscribed event fires.
 * Receives the full {@link AgentEvent} envelope, including the automatic timestamp.
 */
export type EventHandler = (event: AgentEvent) => void;

/**
 * Converts a glob-style wildcard pattern (only `*` is supported) into a `RegExp`.
 *
 * Each `*` matches one or more characters, including dots.
 * Examples:
 * - `'tool.*'`      → `/^tool\..+$/`   matches `tool.call.start`, `tool.call.end`
 * - `'llm.*'`       → `/^llm\..+$/`    matches `llm.call.error`, `llm.fallback`
 * - `'tool.call.*'` → `/^tool\.call\..+$/`
 * - `'*'`           → `/^.+$/`         matches everything
 */
function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split('*').map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.+')}$`);
}

/**
 * Typed event bus for the Agent Orchestration SDK.
 *
 * Built on top of Node's `EventEmitter` (via composition) to handle exact-match
 * subscriptions efficiently, while adding:
 *
 * - **Wildcard patterns** — `on('tool.*', handler)` matches any event whose
 *   name starts with `tool.`, e.g. `tool.call.start`, `tool.call.end`.
 * - **Automatic timestamp** — every `emit()` call wraps the payload in an
 *   {@link AgentEvent} envelope with `timestamp: new Date()`.
 * - **Typed handlers** — all handlers receive `AgentEvent` instead of raw `any`.
 * - **`removeAllListeners()`** — clears both exact and wildcard subscriptions.
 *
 * ### Usage
 * ```typescript
 * const bus = new EventBus();
 *
 * bus.on('tool.call.end', (e) => console.log(e.data.toolName));
 * bus.on('tool.*',        (e) => console.log('any tool event', e.type));
 *
 * bus.emit('tool.call.end', { toolName: 'rag.search', success: true, durationMs: 120 });
 * ```
 */
export class EventBus {
  /**
   * Underlying Node.js `EventEmitter` — handles exact-match subscriptions.
   * Wildcard subscriptions are managed separately in `#wildcards`.
   */
  readonly #emitter: EventEmitter;

  /**
   * Stores wildcard subscriptions.
   * Outer key: pattern string (e.g. `'tool.*'`).
   * Inner key: the **original** handler passed by the caller.
   * Inner value: the **wrapper** handler stored for dispatch
   *   (identical to the original for `on`, self-removing for `once`).
   */
  readonly #wildcards = new Map<string, Map<EventHandler, EventHandler>>();

  constructor() {
    this.#emitter = new EventEmitter();
    // Silence Node's MaxListenersExceededWarning — a long-lived bus can have many listeners.
    this.#emitter.setMaxListeners(0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUBSCRIPTION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to an event by exact name or wildcard pattern.
   *
   * @param event   - Exact event name (`'tool.call.end'`) or glob pattern (`'tool.*'`).
   * @param handler - Called with the {@link AgentEvent} envelope on each matching emit.
   * @returns `this` for chaining.
   */
  on(event: string, handler: EventHandler): this {
    if (event.includes('*')) {
      this.#addWildcard(event, handler, handler);
      return this;
    }
    this.#emitter.on(event, handler);
    return this;
  }

  /**
   * Unsubscribe a previously registered handler.
   * For wildcard patterns the original handler reference must be the same object
   * that was passed to {@link on} or {@link once}.
   *
   * @param event   - Exact event name or wildcard pattern.
   * @param handler - Handler reference to remove.
   * @returns `this` for chaining.
   */
  off(event: string, handler: EventHandler): this {
    if (event.includes('*')) {
      this.#wildcards.get(event)?.delete(handler);
      return this;
    }
    this.#emitter.off(event, handler);
    return this;
  }

  /**
   * Subscribe for a **single** invocation. The handler is automatically
   * removed after the first matching event fires.
   *
   * @param event   - Exact event name or wildcard pattern.
   * @param handler - Called once with the {@link AgentEvent} envelope.
   * @returns `this` for chaining.
   */
  once(event: string, handler: EventHandler): this {
    if (event.includes('*')) {
      // Wrap the handler so it self-removes from #wildcards after the first call.
      const wrapper: EventHandler = (agentEvent) => {
        this.#wildcards.get(event)?.delete(handler);
        handler(agentEvent);
      };
      this.#addWildcard(event, handler, wrapper);
      return this;
    }
    this.#emitter.once(event, handler);
    return this;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EMISSION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Emit an event. All matching handlers (exact and wildcard) are called
   * synchronously with an {@link AgentEvent} envelope that includes an
   * automatically set `timestamp`.
   *
   * @param event - Dot-separated event name (e.g. `'tool.call.end'`).
   * @param data  - Arbitrary payload for this event.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, data: Record<string, any>): void {
    const agentEvent: AgentEvent = { type: event, data, timestamp: new Date() };

    // Dispatch to exact-match listeners via EventEmitter.
    this.#emitter.emit(event, agentEvent);

    // Dispatch to wildcard listeners.
    // Snapshot handlers before iteration so that self-removing `once` wrappers
    // do not corrupt the iteration in-flight.
    for (const [pattern, handlerMap] of this.#wildcards) {
      if (patternToRegex(pattern).test(event)) {
        for (const wrapper of [...handlerMap.values()]) {
          wrapper(agentEvent);
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CLEANUP
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Remove all listeners for a specific event or pattern, or every listener
   * on the bus when called with no arguments.
   *
   * @param event - Event name or wildcard pattern to clear. Omit to clear all.
   * @returns `this` for chaining.
   */
  removeAllListeners(event?: string): this {
    if (event !== undefined) {
      if (event.includes('*')) {
        this.#wildcards.delete(event);
        return this;
      }
      this.#emitter.removeAllListeners(event);
      return this;
    }
    // Clear everything.
    this.#wildcards.clear();
    this.#emitter.removeAllListeners();
    return this;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register an entry in the wildcard map.
   * The `key` is the caller's original handler (used for lookup in `off`).
   * The `wrapper` is what actually gets invoked on dispatch.
   */
  #addWildcard(pattern: string, key: EventHandler, wrapper: EventHandler): void {
    if (!this.#wildcards.has(pattern)) {
      this.#wildcards.set(pattern, new Map());
    }
    this.#wildcards.get(pattern)!.set(key, wrapper);
  }
}
