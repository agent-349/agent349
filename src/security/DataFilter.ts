import type { ExecutionContext, RAGFilter } from '../types/index.js';
import type { DataFilterRule } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// DataFilter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standalone data-filtering engine (Nivel 2).
 *
 * Applies registered {@link DataFilterRule} instances to filter records from
 * tool results and to produce RAG query filters, ensuring users only see the
 * data they are authorised to access.
 *
 * ### Supported filter types
 *
 * | Type               | Behaviour                                                        |
 * |--------------------|------------------------------------------------------------------|
 * | `tenant_isolation` | Keeps only records whose `tenantId` matches `context.tenantId`  |
 * | `role_based`       | Keeps records with no `accessRoles` (public) or with at least   |
 * |                    | one role that overlaps with `context.roles`                      |
 * | `custom`           | Delegates to `rule.config.customFilter(data, context)`           |
 *
 * ### Scoping
 * - `scope: 'rag'`  — rule is only applied via {@link getRAGFilters}.
 * - `scope: 'tool'` — rule is only applied via {@link filter}.
 * - `scope: 'all'`  — rule applies to both RAG and tool filtering.
 *
 * ### Key behaviours
 * - Non-array data is returned unchanged for `tenant_isolation` and `role_based`
 *   (those semantics only make sense for collections).
 * - For `role_based`, array items that have **no `accessRoles`** field (or an
 *   empty array) are treated as **public** and always included.
 * - Rules are applied in insertion order; `custom` filters can transform the shape.
 */
export class DataFilter {
  readonly #rules: DataFilterRule[] = [];

  /**
   * @param rules - Optional initial set of data filter rules.
   */
  constructor(rules: DataFilterRule[] = []) {
    for (const rule of rules) this.#rules.push(rule);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rule management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a new data filter rule.
   *
   * @param rule - The filter rule to add.
   */
  addRule(rule: DataFilterRule): void {
    this.#rules.push(rule);
  }

  /**
   * Removes the **first** registered rule matching the given criteria.
   *
   * @param scope      - The scope used when the rule was registered.
   * @param filterType - The filter type used when the rule was registered.
   * @param toolName   - When the rule was scoped to a specific tool, its name.
   * @returns `true` if a matching rule was found and removed; `false` otherwise.
   */
  removeRule(
    scope: DataFilterRule['scope'],
    filterType: DataFilterRule['filterType'],
    toolName?: string,
  ): boolean {
    const idx = this.#rules.findIndex(
      (r) => r.scope === scope && r.filterType === filterType && r.toolName === toolName,
    );
    if (idx !== -1) {
      this.#rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RAG filters
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds a {@link RAGFilter} from all rules whose scope is `'rag'` or `'all'`.
   *
   * - `tenant_isolation` → sets `filter.tenantId = context.tenantId`
   * - `role_based`       → sets `filter.accessRoles = context.roles`
   *
   * @param context - Execution context supplying `tenantId` and `roles`.
   * @returns The merged RAG filter to pass to the vector store.
   */
  getRAGFilters(context: ExecutionContext): RAGFilter {
    const filter: RAGFilter = {};

    for (const rule of this.#rules) {
      if (rule.scope !== 'rag' && rule.scope !== 'all') continue;

      if (rule.filterType === 'tenant_isolation') {
        filter.tenantId = context.tenantId;
      } else if (rule.filterType === 'role_based') {
        filter.accessRoles = context.roles;
      }
    }

    return filter;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool result filtering
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Applies all rules that match `toolName` and have scope `'tool'` or `'all'`
   * to `data`, returning the filtered result.
   *
   * Rules are evaluated in insertion order. `custom` rules may change the type
   * or shape of the data; subsequent rules see the transformed value.
   *
   * @param toolName - Name of the tool that produced `data`.
   * @param data     - Tool output to filter.
   * @param context  - Execution context providing `tenantId` and `roles`.
   * @returns The filtered data.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter(toolName: string, data: any, context: ExecutionContext): any {
    const rules = this.#rules.filter(
      (r) =>
        (r.scope === 'tool' || r.scope === 'all') &&
        (r.toolName === undefined || r.toolName === toolName),
    );

    let result = data;

    for (const rule of rules) {
      if (rule.filterType === 'tenant_isolation') {
        if (Array.isArray(result)) {
          result = (result as Record<string, unknown>[]).filter(
            (item) => item['tenantId'] === context.tenantId,
          );
        }
      } else if (rule.filterType === 'role_based') {
        if (Array.isArray(result)) {
          result = (result as Record<string, unknown>[]).filter((item) => {
            const itemRoles = item['accessRoles'];
            if (!Array.isArray(itemRoles) || itemRoles.length === 0) return true; // public
            return (itemRoles as string[]).some((r) => context.roles.includes(r));
          });
        }
      } else if (rule.filterType === 'custom' && rule.config.customFilter !== undefined) {
        result = rule.config.customFilter(result, context);
      }
    }

    return result;
  }
}
