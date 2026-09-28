import { createHash } from 'node:crypto';
import type { ExecutionContext, ToolDescriptor, RAGFilter } from '../types/index.js';
import type { ACLPolicy, ACLDecision, FieldMaskRule, DataFilterRule } from './types.js';
import { ACLEvaluator, getNestedField } from './ACLEvaluator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initial configuration for {@link ACLService}.
 * All fields are optional — policies and rules can also be added after construction.
 */
export interface ACLConfig {
  /** Pre-loaded ACL policies. */
  policies?: ACLPolicy[];
  /** Pre-loaded field mask rules. */
  maskRules?: FieldMaskRule[];
  /** Pre-loaded data filter rules. */
  dataFilters?: DataFilterRule[];
}

// ─────────────────────────────────────────────────────────────────────────────
// ACLService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central access-control service for the Agent Orchestration SDK.
 *
 * `ACLService` manages three orthogonal layers of access control:
 *
 * - **Level 1 — Tool/Skill access:** which tools and skills can a user execute?
 *   Governed by {@link ACLPolicy} instances evaluated by {@link ACLEvaluator}.
 * - **Level 2 — Data filtering:** which rows/records can a user see? Governed by
 *   {@link DataFilterRule} instances applied to tool results and RAG queries.
 * - **Level 3 — Field masking:** which fields are masked in a user's results?
 *   Governed by {@link FieldMaskRule} instances applied to tool output objects.
 *
 * ### Evaluation model
 *
 * The model is **whitelist-based**:
 * - A resource with **no policy** is **public** (any authenticated user may access it).
 * - `deniedRoles` takes **priority** over `allowedRoles`.
 * - The special role `'*'` in `allowedRoles` grants access to any authenticated user.
 * - Multiple policies for the same resource are evaluated with **AND** semantics
 *   (all must pass).
 *
 * @example
 * ```typescript
 * const acl = new ACLService({});
 *
 * acl.addPolicy({
 *   resourceType: 'tool',
 *   resourceId: 'finance.getBalance',
 *   allowedRoles: ['finance_viewer', 'finance_admin'],
 * });
 *
 * const decision = acl.evaluate('tool', 'finance.getBalance', context);
 * if (!decision.allowed) throw new AccessDeniedError('tool', 'finance.getBalance', context.roles);
 * ```
 */
export class ACLService {
  // key: `${resourceType}:${resourceId}` → list of policies
  readonly #policies = new Map<string, ACLPolicy[]>();
  readonly #maskRules: FieldMaskRule[] = [];
  readonly #dataFilters: DataFilterRule[] = [];
  readonly #evaluator = new ACLEvaluator();

  /**
   * @param config - Optional initial policies, mask rules, and data filter rules.
   */
  constructor(config: ACLConfig = {}) {
    if (config.policies !== undefined) {
      for (const p of config.policies) this.addPolicy(p);
    }
    if (config.maskRules !== undefined) {
      for (const r of config.maskRules) this.addMaskRule(r);
    }
    if (config.dataFilters !== undefined) {
      for (const f of config.dataFilters) this.addDataFilter(f);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Policy management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers an ACL policy. Multiple policies for the same resource are
   * accumulated and ALL must pass (AND semantics) during evaluation.
   *
   * @param policy - The policy to register.
   */
  addPolicy(policy: ACLPolicy): void {
    const key = policyKey(policy.resourceType, policy.resourceId);
    const existing = this.#policies.get(key) ?? [];
    existing.push(policy);
    this.#policies.set(key, existing);
  }

  /**
   * Registers multiple policies in a single call.
   *
   * @param policies - Policies to register.
   */
  addPolicies(policies: ACLPolicy[]): void {
    for (const p of policies) this.addPolicy(p);
  }

  /**
   * Removes all policies for the given resource.
   *
   * @returns `true` if policies existed and were removed; `false` if not found.
   */
  removePolicy(resourceType: ACLPolicy['resourceType'], resourceId: string): boolean {
    const key = policyKey(resourceType, resourceId);
    return this.#policies.delete(key);
  }

  /**
   * Returns all registered policies for the given resource.
   * Returns an empty array if no policy has been registered.
   *
   * @param resourceType - Category of the resource.
   * @param resourceId   - Identifier of the resource.
   */
  getPolicies(resourceType: ACLPolicy['resourceType'], resourceId: string): ACLPolicy[] {
    return this.#policies.get(policyKey(resourceType, resourceId)) ?? [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACL evaluation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates whether the user in `context` may access the given resource.
   *
   * The decision is computed by {@link ACLEvaluator} against all registered
   * policies for the resource. No policy → public access.
   *
   * @param resourceType - Category of the resource.
   * @param resourceId   - Identifier of the resource.
   * @param context      - Execution context providing the user's roles.
   * @returns {@link ACLDecision} with `allowed`, `reason`, and timing metadata.
   */
  evaluate(
    resourceType: ACLPolicy['resourceType'],
    resourceId: string,
    context: ExecutionContext,
  ): ACLDecision {
    const policies = this.getPolicies(resourceType, resourceId);
    return this.#evaluator.evaluate(policies, context, resourceType, resourceId);
  }

  /**
   * Returns only the tools that the user in `context` is allowed to use.
   *
   * Tools without a registered policy are considered public and always included.
   * This filtered list is what the Agent Loop sends to the LLM — unreachable
   * tools are never exposed.
   *
   * @param tools   - Full set of tool descriptors to filter.
   * @param context - Execution context providing the user's roles.
   */
  filterTools(tools: ToolDescriptor[], context: ExecutionContext): ToolDescriptor[] {
    return tools.filter((t) => this.evaluate('tool', t.name, context).allowed);
  }

  /**
   * Returns only the skill names that the user in `context` is allowed to use.
   *
   * @param skills  - Full list of skill names to filter.
   * @param context - Execution context providing the user's roles.
   */
  filterSkills(skills: string[], context: ExecutionContext): string[] {
    return skills.filter((s) => this.evaluate('skill', s, context).allowed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Field masking (Level 3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a field mask rule for a specific tool's output.
   *
   * @param rule - The masking rule to add.
   */
  addMaskRule(rule: FieldMaskRule): void {
    this.#maskRules.push(rule);
  }

  /**
   * Applies all registered field mask rules for `toolName` to `data`.
   *
   * Users whose roles appear in `rule.visibleToRoles` receive the original value.
   * All other users receive the masked version according to `rule.maskType`.
   * If `data` is an array, masking is applied to each element individually.
   *
   * The input `data` is never mutated — a structural clone is made first.
   *
   * @param toolName - Name of the tool that produced `data`.
   * @param data     - Tool output to mask.
   * @param context  - Execution context providing the user's roles.
   * @returns The masked copy of `data`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maskFields(toolName: string, data: any, context: ExecutionContext): any {
    const rules = this.#maskRules.filter((r) => r.toolName === toolName);
    if (rules.length === 0) return data;

    const cloned = structuredClone(data);

    const applyToObject = (obj: Record<string, unknown>): void => {
      for (const rule of rules) {
        const canSee =
          rule.visibleToRoles.includes('*') ||
          rule.visibleToRoles.some((r) => context.roles.includes(r));
        if (canSee) continue;

        const rawValue = getNestedField(obj, rule.field);
        if (rawValue === undefined) continue;

        const masked = applyMask(rawValue, rule, context);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Data filtering (Level 2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a data filter rule.
   *
   * @param rule - The filter rule to add.
   */
  addDataFilter(rule: DataFilterRule): void {
    this.#dataFilters.push(rule);
  }

  /**
   * Builds a {@link RAGFilter} by merging all registered data-filter rules that
   * apply to RAG queries (`scope: 'rag'` or `'all'`).
   *
   * - `tenant_isolation` → sets `filter.tenantId = context.tenantId`
   * - `role_based`       → sets `filter.accessRoles = context.roles`
   *
   * @param context - Execution context supplying tenantId and roles.
   * @returns The merged RAG filter to pass to the vector store.
   */
  getRAGFilters(context: ExecutionContext): RAGFilter {
    const filter: RAGFilter = {};

    for (const rule of this.#dataFilters) {
      if (rule.scope !== 'rag' && rule.scope !== 'all') continue;

      if (rule.filterType === 'tenant_isolation') {
        filter.tenantId = context.tenantId;
      } else if (rule.filterType === 'role_based') {
        filter.accessRoles = context.roles;
      }
    }

    return filter;
  }

  /**
   * Applies all registered data filter rules that apply to the given tool.
   *
   * - `tenant_isolation` — if `data` is an array, keeps only items whose
   *   `tenantId` field matches `context.tenantId`.
   * - `role_based` — if `data` is an array, keeps only items whose `accessRoles`
   *   array overlaps with `context.roles` (or has no `accessRoles` — public).
   * - `custom` — calls `rule.config.customFilter(data, context)` and replaces data.
   *
   * Non-array data is passed through unchanged for `tenant_isolation` and
   * `role_based` (those semantics only apply to collections).
   *
   * @param toolName - Name of the tool that produced `data`.
   * @param data     - Tool output to filter.
   * @param context  - Execution context providing tenantId and roles.
   * @returns The filtered data.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filterToolResult(toolName: string, data: any, context: ExecutionContext): any {
    const rules = this.#dataFilters.filter(
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

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function policyKey(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

/**
 * Applies a single field mask to `value` according to the rule's `maskType`.
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
      const masked = maskChar.repeat(maskLength);
      const suffix = showLast > 0 ? str.slice(str.length - showLast) : '';
      return str.slice(0, showFirst) + masked + suffix;
    }

    case 'hash':
      return createHash('sha256').update(String(value)).digest('hex');

    case 'custom':
      return rule.customMask !== undefined ? rule.customMask(value, context) : '[REDACTED]';

    default:
      return '[REDACTED]';
  }
}

/**
 * Sets a value at a dot-notation path within a nested object.
 * Creates intermediate objects if they don't exist.
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
