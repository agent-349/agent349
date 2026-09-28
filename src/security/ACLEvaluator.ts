import type { ExecutionContext } from '../types/index.js';
import type { ACLPolicy, ACLCondition, ACLDecision } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// ACLEvaluator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure evaluation engine for ACL policies.
 *
 * `ACLEvaluator` contains no state — all inputs are passed as arguments.
 * This makes it easy to unit-test each evaluation rule in complete isolation.
 *
 * The full evaluation algorithm applied by {@link evaluate} follows this
 * priority order (first matching rule wins):
 *
 * 1. **No policies** → `allowed: true` (public by default).
 * 2. **`deniedRoles` match** → `allowed: false` (explicit deny takes priority).
 * 3. **`allowedRoles` no match** → `allowed: false` (user lacks required role).
 * 4. **Condition fails** → `allowed: false` (runtime condition not met).
 * 5. **All policies pass** → `allowed: true`.
 *
 * The special role `'*'` in `allowedRoles` means public (any authenticated user
 * passes the role check). `deniedRoles` overrides `'*'`.
 *
 * **Condition operators:**
 *
 * | Operator    | Semantics                                              |
 * |-------------|--------------------------------------------------------|
 * | `eq`        | `fieldValue === value`                                 |
 * | `neq`       | `fieldValue !== value`                                 |
 * | `in`        | `fieldValue` is contained in the `value` array         |
 * | `not_in`    | `fieldValue` is NOT in the `value` array               |
 * | `exists`    | `fieldValue` is not `undefined` or `null`              |
 * | `regex`     | `new RegExp(value).test(String(fieldValue))`           |
 *
 * Fields are resolved from `ExecutionContext` using dot-notation
 * (e.g. `'metadata.department'` → `context.metadata?.department`).
 */
/**
 * Renders a condition operand for regex matching.
 *
 * Objects are JSON-encoded instead of going through `String()`, which would
 * render every object as `[object Object]` and make unrelated values match the
 * same pattern.
 */
function stringifyValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (typeof value === 'symbol') return value.toString();
  return String(value as string | number | boolean | bigint);
}

export class ACLEvaluator {
  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates all policies for a resource against the given context.
   *
   * This is the main entry-point used by {@link ACLService}. It wraps
   * {@link evaluatePolicy} for each policy and measures wall-clock latency.
   *
   * @param policies     - All policies registered for the resource (may be empty).
   * @param context      - Execution context carrying the user's roles and metadata.
   * @param resourceType - Category of the resource being checked.
   * @param resourceId   - Identifier of the resource being checked.
   * @returns A complete {@link ACLDecision} with timing information.
   */
  evaluate(
    policies: ACLPolicy[],
    context: ExecutionContext,
    resourceType: ACLPolicy['resourceType'],
    resourceId: string,
  ): ACLDecision {
    const start = Date.now();

    if (policies.length === 0) {
      return this.#decision(true, 'No policy defined (public)', undefined, start);
    }

    for (const policy of policies) {
      const { allowed, reason } = this.evaluatePolicy(policy, context);
      if (!allowed) {
        const matchedPolicy = `${resourceType}:${resourceId}`;
        return this.#decision(false, reason, matchedPolicy, start);
      }
    }

    const matchedPolicy = `${resourceType}:${resourceId}`;
    return this.#decision(true, 'All policies satisfied', matchedPolicy, start);
  }

  /**
   * Evaluates a single ACL policy against the given execution context.
   *
   * Returns `{ allowed: false }` as soon as any rule in the policy fails.
   * If the policy passes completely, returns `{ allowed: true }`.
   *
   * @param policy  - The ACL policy to evaluate.
   * @param context - Execution context to evaluate against.
   */
  evaluatePolicy(
    policy: ACLPolicy,
    context: ExecutionContext,
  ): { allowed: boolean; reason: string } {
    // ── Step 1: explicit deny ────────────────────────────────────────────────
    if (policy.deniedRoles !== undefined) {
      const matchedDenied = policy.deniedRoles.find((r) => context.roles.includes(r));
      if (matchedDenied !== undefined) {
        return {
          allowed: false,
          reason: `Role explicitly denied: ${matchedDenied}`,
        };
      }
    }

    // ── Step 2: allowedRoles check ───────────────────────────────────────────
    const isPublic = policy.allowedRoles.includes('*');
    const hasRole = isPublic || policy.allowedRoles.some((r) => context.roles.includes(r));
    if (!hasRole) {
      return {
        allowed: false,
        reason:
          `Required roles: [${policy.allowedRoles.join(', ')}], ` +
          `user has: [${context.roles.join(', ')}]`,
      };
    }

    // ── Step 3: conditions ───────────────────────────────────────────────────
    if (policy.conditions !== undefined) {
      for (const condition of policy.conditions) {
        if (!this.evaluateCondition(condition, context)) {
          return {
            allowed: false,
            reason: `Condition failed: ${condition.field} ${condition.operator}`,
          };
        }
      }
    }

    return { allowed: true, reason: 'Policy satisfied' };
  }

  /**
   * Evaluates a single runtime condition against the execution context.
   *
   * The `field` path supports dot notation for nested `metadata` access
   * (e.g. `'metadata.department'`). If the field does not exist in the context,
   * it is treated as `undefined` for all operators.
   *
   * @param condition - The condition to evaluate.
   * @param context   - Execution context to read field values from.
   * @returns `true` if the condition passes, `false` otherwise.
   */
  evaluateCondition(condition: ACLCondition, context: ExecutionContext): boolean {
    const fieldValue = getNestedField(
      context as unknown as Record<string, unknown>,
      condition.field,
    );

    switch (condition.operator) {
      case 'eq':
        return fieldValue === condition.value;

      case 'neq':
        return fieldValue !== condition.value;

      case 'in':
        if (!Array.isArray(condition.value)) return false;
        return (condition.value as unknown[]).includes(fieldValue);

      case 'not_in':
        if (!Array.isArray(condition.value)) return true;
        return !(condition.value as unknown[]).includes(fieldValue);

      case 'exists':
        return fieldValue !== undefined && fieldValue !== null;

      case 'regex': {
        if (fieldValue === undefined || fieldValue === null) return false;
        try {
          return new RegExp(condition.value as string).test(stringifyValue(fieldValue));
        } catch {
          return false;
        }
      }

      default:
        return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #decision(
    allowed: boolean,
    reason: string,
    matchedPolicy: string | undefined,
    startMs: number,
  ): ACLDecision {
    const now = Date.now();
    return {
      allowed,
      reason,
      evaluatedAt: new Date(),
      durationMs: now - startMs,
      ...(matchedPolicy !== undefined && { matchedPolicy }),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a value from a nested object using dot-notation path.
 *
 * Returns `undefined` if any segment in the path is not an object or does not
 * exist, rather than throwing.
 *
 * @example
 * ```typescript
 * getNestedField({ metadata: { department: 'finance' } }, 'metadata.department')
 * // → 'finance'
 * ```
 */
export function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
