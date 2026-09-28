import { createHash } from 'node:crypto';
import type { ExecutionContext } from '../types/index.js';
import type { FieldMaskRule } from './types.js';
import { getNestedField } from './ACLEvaluator.js';

// ─────────────────────────────────────────────────────────────────────────────
// FieldMasker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standalone field-masking engine (Nivel 3).
 *
 * Applies registered {@link FieldMaskRule} instances to tool output objects,
 * hiding or transforming sensitive fields before the result reaches the LLM.
 *
 * ### Supported mask types
 *
 * | Type      | Result                         | Typical use                            |
 * |-----------|--------------------------------|----------------------------------------|
 * | `redact`  | `'[REDACTED]'`                 | Fields that must never be seen         |
 * | `partial` | first/last N chars preserved   | IDs where a partial reference is OK    |
 * | `hash`    | first 12 hex chars of SHA-256  | Analytics without identifying data     |
 * | `custom`  | result of `rule.customMask()`  | Business-specific transformations      |
 *
 * ### Key behaviours
 * - The original `data` is **never mutated** (`structuredClone` is used internally).
 * - `field` supports **dot-notation** for nested paths (e.g. `'employee.salary'`).
 * - When `data` is an **array**, masking is applied to each element individually.
 * - Users whose roles appear in `rule.visibleToRoles` see the raw value unchanged.
 * - The special role `'*'` in `visibleToRoles` means the field is public (never masked).
 * - If the field path does not exist in the object the rule is silently skipped.
 */
export class FieldMasker {
  readonly #rules: FieldMaskRule[] = [];

  /**
   * @param rules - Optional initial set of field mask rules.
   */
  constructor(rules: FieldMaskRule[] = []) {
    for (const rule of rules) this.#rules.push(rule);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rule management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a new field mask rule.
   * Multiple rules for the same tool and field are all applied.
   *
   * @param rule - The masking rule to add.
   */
  addRule(rule: FieldMaskRule): void {
    this.#rules.push(rule);
  }

  /**
   * Removes the **first** registered rule that matches `toolName` and `field`.
   * Does nothing if no matching rule is found.
   *
   * @param toolName - Tool name used when the rule was registered.
   * @param field    - Dot-notation field path used when the rule was registered.
   */
  removeRule(toolName: string, field: string): void {
    const idx = this.#rules.findIndex((r) => r.toolName === toolName && r.field === field);
    if (idx !== -1) this.#rules.splice(idx, 1);
  }

  /**
   * Returns the field paths that have a mask rule registered for `toolName`.
   * Useful for observability (e.g. reporting which fields were masked) without
   * exposing the rule objects themselves.
   *
   * @param toolName - Tool name to inspect.
   * @returns Distinct field paths covered by mask rules for the tool.
   */
  ruleFieldsFor(toolName: string): string[] {
    const fields = new Set<string>();
    for (const r of this.#rules) {
      if (r.toolName === toolName) fields.add(r.field);
    }
    return [...fields];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Masking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Applies all registered rules for `toolName` to `data`, returning a masked copy.
   *
   * If `data` is an array each element is masked individually. Non-object elements
   * within the array are passed through unchanged.
   *
   * @param toolName - Name of the tool that produced `data`.
   * @param data     - Tool output to mask (object or array of objects).
   * @param context  - Execution context supplying the caller's roles.
   * @returns A deep clone of `data` with applicable fields masked.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mask(toolName: string, data: any, context: ExecutionContext): any {
    const rules = this.#rules.filter((r) => r.toolName === toolName);
    if (rules.length === 0) return data;

    const cloned = structuredClone(data);

    const applyToObject = (obj: Record<string, unknown>): void => {
      for (const rule of rules) {
        const canSee =
          rule.visibleToRoles.includes('*') ||
          rule.visibleToRoles.some((r) => context.roles.includes(r));
        if (canSee) continue;

        const value = getNestedField(obj, rule.field);
        if (value === undefined) continue;

        const masked = applyMask(value, rule, context);
        setNestedField(obj, rule.field, masked);
      }
    };

    if (Array.isArray(cloned)) {
      for (const item of cloned) {
        if (item !== null && typeof item === 'object') {
          applyToObject(item as Record<string, unknown>);
        }
      }
    } else if (cloned !== null && typeof cloned === 'object') {
      applyToObject(cloned as Record<string, unknown>);
    }

    return cloned;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a single field mask to `value` according to the rule's `maskType`.
 *
 * - `redact`  → `'[REDACTED]'`
 * - `partial` → showFirst chars + maskChar repeated + showLast chars
 * - `hash`    → first 12 hex characters of SHA-256 digest
 * - `custom`  → `rule.customMask(value, context)`, falls back to `'[REDACTED]'`
 */
function applyMask(value: unknown, rule: FieldMaskRule, context: ExecutionContext): unknown {
  switch (rule.maskType) {
    case 'redact':
      return '[REDACTED]';

    case 'partial': {
      const str = String(value);
      const showFirst = rule.partialConfig?.showFirst ?? 0;
      const showLast = rule.partialConfig?.showLast ?? 0;
      const maskChar = rule.partialConfig?.maskChar ?? '*';
      const maskLength = Math.max(0, str.length - showFirst - showLast);
      const prefix = str.slice(0, showFirst);
      const suffix = showLast > 0 ? str.slice(str.length - showLast) : '';
      return prefix + maskChar.repeat(maskLength) + suffix;
    }

    case 'hash':
      return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

    case 'custom':
      return rule.customMask !== undefined ? rule.customMask(value, context) : '[REDACTED]';

    default:
      return '[REDACTED]';
  }
}

/**
 * Sets a value at a dot-notation path within a nested object.
 * Creates intermediate objects if any segment along the path is missing.
 */
function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}
