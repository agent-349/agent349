import type {
  ApprovalTrigger,
  ApprovalCondition,
  ApprovalRequirement,
  ExecutionContext,
} from '../types/index.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';

// ─────────────────────────────────────────────────────────────────────────────
// TriggerEvaluator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a set of {@link ApprovalTrigger} rules to determine whether a tool
 * call requires human approval before execution.
 *
 * ### Scope matching
 * A trigger fires only when the tool falls within its declared scope:
 * - `scope.tools` — exact tool name match.
 * - `scope.all` — matches every tool (use with caution).
 * - `scope.skills` — tool name must start with `<skill>.` (e.g. tool
 *   `'hr.getEmployee'` is in skill `'hr'`).
 * - `scope.tags` — tool must carry **all** the specified tags; requires a
 *   {@link ToolRegistry} to be supplied at construction time.
 *
 * ### Condition evaluation
 * Once a trigger's scope matches, **all** its `conditions` are evaluated
 * (logical AND). The trigger fires only when every condition is satisfied.
 *
 * ### Condition types
 * | Type            | Logic                                                    |
 * |-----------------|----------------------------------------------------------|
 * | `always`        | Always returns `true`.                                   |
 * | `input_field`   | Reads a dot-notation path from the tool `input`.         |
 * | `context_field` | Reads a dot-notation path from the `ExecutionContext`.   |
 * | `custom`        | Calls the caller-supplied `evaluate` function.           |
 *
 * The first matching (scoped + all-conditions-true) trigger wins.
 */
export class TriggerEvaluator {
  readonly #toolRegistry: ToolRegistry | undefined;

  /**
   * @param toolRegistry - Optional registry used to resolve tool tags for
   *   `scope.tags` matching. When omitted, tag-scoped triggers are skipped.
   */
  constructor(toolRegistry?: ToolRegistry) {
    this.#toolRegistry = toolRegistry;
  }

  /**
   * Tests `toolName + input + context` against the provided triggers in order.
   *
   * @param triggers  - Triggers to evaluate (in order; first match wins).
   * @param toolName  - Name of the tool about to be executed.
   * @param input     - Validated tool input.
   * @param context   - Execution context of the current request.
   * @returns An {@link ApprovalRequirement} if any trigger fires, or `null`.
   */
  evaluate(
    triggers: ApprovalTrigger[],
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ): ApprovalRequirement | null {
    for (const trigger of triggers) {
      if (!trigger.enabled) continue;
      if (!this.#matchesScope(trigger, toolName)) continue;
      if (!this.#allConditionsMet(trigger.conditions, toolName, input, context)) continue;

      return {
        triggerId: trigger.id,
        triggerName: trigger.name,
        risk: trigger.approvalConfig.risk,
        approverRoles: trigger.approvalConfig.approverRoles,
        reason: trigger.description,
      };
    }
    return null;
  }

  // ─── Private: scope matching ────────────────────────────────────────────────

  #matchesScope(trigger: ApprovalTrigger, toolName: string): boolean {
    const { scope } = trigger;

    if (scope.all === true) return true;

    if (scope.tools !== undefined && scope.tools.includes(toolName)) return true;

    if (scope.skills !== undefined) {
      for (const skill of scope.skills) {
        if (toolName === skill || toolName.startsWith(`${skill}.`)) return true;
      }
    }

    if (scope.tags !== undefined && scope.tags.length > 0 && this.#toolRegistry !== undefined) {
      const tool = this.#toolRegistry.get(toolName);
      if (tool !== undefined) {
        const toolTags = tool.tags ?? [];
        if (scope.tags.every((tag) => toolTags.includes(tag))) return true;
      }
    }

    return false;
  }

  // ─── Private: condition evaluation ─────────────────────────────────────────

  #allConditionsMet(
    conditions: ApprovalCondition[],
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ): boolean {
    return conditions.every((condition) =>
      this.#evaluateCondition(condition, toolName, input, context),
    );
  }

  #evaluateCondition(
    condition: ApprovalCondition,
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ): boolean {
    switch (condition.type) {
      case 'always':
        return true;

      case 'input_field': {
        if (condition.field === undefined) return false;
        const value = getNestedField(input, condition.field);
        return applyOperator(value, condition.operator, condition.value);
      }

      case 'context_field': {
        if (condition.field === undefined) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = getNestedField(context as unknown as Record<string, any>, condition.field);
        return applyOperator(value, condition.operator, condition.value);
      }

      case 'custom': {
        if (typeof condition.evaluate !== 'function') return false;
        return condition.evaluate(toolName, input, context);
      }

      default:
        return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a dot-notation path from an object, returning `undefined` if any
 * segment is missing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNestedField(obj: Record<string, any>, path: string): unknown {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Applies a comparison operator between a field value and a configured value.
 *
 * For the `in` / `not_in` operators, when `fieldValue` is an **array** the
 * check tests whether **any** element of the array is present in the `value`
 * array (useful for the `roles` context field which is always a string array).
 */
function applyOperator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fieldValue: any,
  operator: ApprovalCondition['operator'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compareValue: any,
): boolean {
  switch (operator) {
    case 'gt':
      return typeof fieldValue === 'number' && fieldValue > compareValue;
    case 'lt':
      return typeof fieldValue === 'number' && fieldValue < compareValue;
    case 'gte':
      return typeof fieldValue === 'number' && fieldValue >= compareValue;
    case 'lte':
      return typeof fieldValue === 'number' && fieldValue <= compareValue;
    case 'eq':
      return fieldValue === compareValue;
    case 'neq':
      return fieldValue !== compareValue;

    case 'in': {
      if (!Array.isArray(compareValue)) return false;
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((v) => compareValue.includes(v));
      }
      return compareValue.includes(fieldValue);
    }

    case 'not_in': {
      if (!Array.isArray(compareValue)) return false;
      if (Array.isArray(fieldValue)) {
        return !fieldValue.some((v) => compareValue.includes(v));
      }
      return !compareValue.includes(fieldValue);
    }

    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;

    case 'regex': {
      const pattern =
        compareValue instanceof RegExp ? compareValue : new RegExp(String(compareValue));
      return typeof fieldValue === 'string' && pattern.test(fieldValue);
    }

    default:
      return false;
  }
}
