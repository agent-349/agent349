import type { EventBus } from '../events/EventBus.js';
import type { ExecutionContext, ToolResult } from '../types/index.js';

/** Default number of turns kept in memory before the oldest are forgotten. */
const DEFAULT_MAX_TRACKED = 1_000;

/** Constructor options for {@link UntrustedTracker}. */
export interface UntrustedTrackerOptions {
  /**
   * Maximum turns tracked at once. The oldest entry is dropped when the cap is
   * reached, bounding memory without a background timer.
   * @default 1000
   */
  maxTracked?: number;
}

/**
 * Notes when content from a source the integrator does not control enters a
 * turn, and flags side-effecting tools that run afterwards.
 *
 * ### Why this exists
 * A tool that reads an arbitrary web page is an **inlet** for untrusted text —
 * text that reaches the model and may be written to instruct it. A tool that
 * sends mail or issues a mutating HTTP request is an **outlet**. Each is
 * harmless alone; combined in one turn they form an exfiltration path that
 * neither can see from the inside, because neither knows about the other.
 * This tracker is the piece that can see both.
 *
 * ### What it does not do
 * It **observes**. It never blocks a tool, never demands approval, never
 * interrupts the loop. The two events it emits are the whole mechanism —
 * routed to a SIEM through the existing forwarder, they let an integrator find
 * out that one of their agents is exposed. Turning that into policy is the
 * host's decision, not the SDK's.
 *
 * Turns are identified by `ExecutionContext.requestId`.
 */
export class UntrustedTracker {
  readonly #bus: EventBus;
  readonly #maxTracked: number;
  /** Request ids whose turn has seen untrusted content, in insertion order. */
  readonly #tainted = new Set<string>();

  /**
   * @param bus     - Event bus the two `security.untrusted.*` events go to.
   * @param options - Tracking bounds.
   */
  constructor(bus: EventBus, options: UntrustedTrackerOptions = {}) {
    this.#bus = bus;
    this.#maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
  }

  /**
   * Records a finished tool result, marking the turn when it carries untrusted
   * content.
   *
   * @param context  - Context of the execution that produced the result.
   * @param toolName - Tool that produced it.
   * @param result   - The result; only `untrusted === true` is acted on.
   */
  record(context: ExecutionContext, toolName: string, result: ToolResult): void {
    if (result.untrusted !== true) return;

    const known = this.#tainted.has(context.requestId);
    this.#remember(context.requestId);

    // Emitted once per turn: the fifth page read adds no information, and a
    // per-call event would drown the signal it is meant to carry.
    if (known) return;
    this.#bus.emit('security.untrusted.inflow', {
      toolName,
      requestId: context.requestId,
      sessionId: context.sessionId,
      agentId: context.agentId,
      tenantId: context.tenantId,
      userId: context.userId,
    });
  }

  /**
   * Reports that a side-effecting tool is about to run, emitting
   * `security.untrusted.mutating` when the turn is already tainted.
   *
   * @param context  - Context of the execution.
   * @param toolName - The side-effecting tool.
   */
  noteSideEffect(context: ExecutionContext, toolName: string): void {
    if (!this.#tainted.has(context.requestId)) return;
    this.#bus.emit('security.untrusted.mutating', {
      toolName,
      requestId: context.requestId,
      sessionId: context.sessionId,
      agentId: context.agentId,
      tenantId: context.tenantId,
      userId: context.userId,
      reason:
        'a side-effecting tool ran in a turn that had already taken in ' +
        'untrusted external content',
    });
  }

  /**
   * Whether untrusted content has entered this turn.
   *
   * @param context - Context identifying the turn.
   */
  isTainted(context: ExecutionContext): boolean {
    return this.#tainted.has(context.requestId);
  }

  /**
   * Forgets a turn. Optional — entries age out on their own — but worth
   * calling when a host knows a request is finished.
   *
   * @param context - Context identifying the turn.
   */
  clear(context: ExecutionContext): void {
    this.#tainted.delete(context.requestId);
  }

  /** Adds a request id, evicting the oldest entries past the cap. */
  #remember(requestId: string): void {
    this.#tainted.add(requestId);
    while (this.#tainted.size > this.#maxTracked) {
      // Sets iterate in insertion order, so this is the oldest entry.
      const oldest = this.#tainted.values().next();
      if (oldest.done === true) break;
      this.#tainted.delete(oldest.value);
    }
  }
}
