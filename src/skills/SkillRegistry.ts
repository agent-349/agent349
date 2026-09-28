import type { Skill, Tool } from '../types/index.js';

/**
 * Central registry of all {@link Skill | skills} available to the orchestrator.
 *
 * Skills are stored by their unique `name`. Registering a skill whose name
 * already exists **replaces** the previous entry (last write wins).
 *
 * The registry is the single source of truth for:
 * - Which tools each skill exposes to the LLM.
 * - Which system-prompt text each skill contributes.
 *
 * @example
 * ```typescript
 * const skills = new SkillRegistry();
 *
 * skills.register({
 *   name: 'finance',
 *   description: 'Financial query tools',
 *   tools: [getBalanceTool, transferTool],
 *   systemPromptAddition: 'You have access to the finance system. Always confirm amounts.',
 * });
 *
 * const tools  = skills.resolveTools(['finance']);
 * const prompt = skills.resolveSystemPrompt(['finance']);
 * ```
 */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a skill.
   * If a skill with the same `name` already exists it is replaced.
   *
   * @param skill - The skill to register.
   */
  register(skill: Skill): void {
    this.#skills.set(skill.name, skill);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lookup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves a skill by exact name.
   *
   * @param name - Skill name as given at registration time.
   * @returns The skill, or `undefined` if not found.
   */
  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  /**
   * Returns the names of all registered skills, in insertion order.
   */
  list(): string[] {
    return [...this.#skills.keys()];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Resolution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Collects the {@link Tool | tools} from every named skill and returns them
   * as a deduplicated, ordered list.
   *
   * **Ordering** — tools are emitted in the order their owning skills appear
   * in `skillNames`, and within each skill in the order they were declared.
   *
   * **Deduplication** — if the same tool name appears in multiple skills only
   * the first occurrence is kept (the skill listed first wins).
   *
   * Unknown skill names are silently skipped.
   *
   * @param skillNames - Ordered list of skill names to resolve.
   * @returns Deduplicated array of tools across all named skills.
   */
  resolveTools(skillNames: string[]): Tool[] {
    const seen = new Set<string>();
    const result: Tool[] = [];

    for (const name of skillNames) {
      const skill = this.#skills.get(name);
      if (skill === undefined) continue;

      for (const tool of skill.tools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          result.push(tool);
        }
      }
    }

    return result;
  }

  /**
   * Concatenates the `systemPromptAddition` strings from every named skill
   * that defines one, separated by a double newline (`\n\n`).
   *
   * Skills without a `systemPromptAddition` and unknown skill names are
   * silently skipped. Returns an empty string when nothing matches.
   *
   * @param skillNames - Ordered list of skill names to resolve.
   * @returns Combined system-prompt text, or `''` if none of the skills
   *          contribute additions.
   */
  resolveSystemPrompt(skillNames: string[]): string {
    const parts: string[] = [];

    for (const name of skillNames) {
      const skill = this.#skills.get(name);
      if (skill?.systemPromptAddition !== undefined) {
        parts.push(skill.systemPromptAddition);
      }
    }

    return parts.join('\n\n');
  }
}
