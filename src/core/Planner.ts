import { randomUUID } from 'node:crypto';
import type {
  ExecutionContext,
  LLMRequest,
  Plan,
  PlanStep,
  ToolDescriptor,
} from '../types/index.js';
import type { LLMProvider } from '../llm/LLMProvider.js';
import { PlannerError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Planner system prompt
// ─────────────────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a planning agent. Given a user goal and a list of available tools, generate a structured JSON execution plan.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences. The structure must be:
{
  "goal": "<restate the user's goal clearly>",
  "steps": [
    {
      "stepId": "step-1",
      "toolName": "<exact tool name from the provided list>",
      "inputTemplate": { <tool input parameters, filled in where deterministic> },
      "dependsOn": [],
      "description": "<one-sentence description of what this step does>"
    }
  ],
  "estimatedTokens": <integer estimate of tokens needed to execute all steps>,
  "requiresApproval": <true if any step involves financial transactions, sends external messages, deletes data, or has irreversible side effects; false otherwise>
}

Rules:
- Only reference tools by their exact name from the provided list.
- stepId values must be unique strings: step-1, step-2, …
- dependsOn contains stepIds that must complete before this step.
- If no tools are needed to answer the goal, return an empty steps array.
- Set requiresApproval to true whenever any step is destructive, financial, or sends external communications.`;

// ─────────────────────────────────────────────────────────────────────────────
// Internal: JSON parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts and validates a Plan payload from an LLM text response.
 * Handles both raw JSON and content accidentally wrapped in markdown code fences.
 *
 * @throws {@link PlannerError} if the content cannot be parsed into a valid plan.
 */
function parsePlanFromContent(content: string): Omit<Plan, 'planId' | 'status' | 'createdAt'> {
  let json = content.trim();

  // Strip markdown code fences if the model added them despite instructions.
  const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1] !== undefined) {
    json = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new PlannerError(
      `LLM did not return valid JSON for the execution plan. Raw response: ${json.slice(0, 200)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PlannerError('Plan response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['goal'] !== 'string' || obj['goal'].length === 0) {
    throw new PlannerError("Plan is missing required string field: 'goal'");
  }

  if (!Array.isArray(obj['steps'])) {
    throw new PlannerError("Plan is missing required array field: 'steps'");
  }

  const steps: PlanStep[] = obj['steps'].map((raw: unknown, i: number) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PlannerError(`Plan step at index ${i} is not an object`);
    }
    const s = raw as Record<string, unknown>;

    if (typeof s['stepId'] !== 'string') {
      throw new PlannerError(`Plan step ${i} is missing required string field: 'stepId'`);
    }
    if (typeof s['toolName'] !== 'string') {
      throw new PlannerError(`Plan step ${i} is missing required string field: 'toolName'`);
    }
    if (typeof s['description'] !== 'string') {
      throw new PlannerError(`Plan step ${i} is missing required string field: 'description'`);
    }

    return {
      stepId: s['stepId'],
      toolName: s['toolName'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputTemplate: (s['inputTemplate'] ?? {}) as any,
      ...(Array.isArray(s['dependsOn']) ? { dependsOn: s['dependsOn'] as string[] } : {}),
      description: s['description'],
    };
  });

  return {
    goal: obj['goal'],
    steps,
    ...(typeof obj['estimatedTokens'] === 'number' && obj['estimatedTokens'] > 0
      ? { estimatedTokens: obj['estimatedTokens'] }
      : {}),
    requiresApproval: obj['requiresApproval'] === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Planner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an explicit execution plan before the agent loop runs.
 *
 * When an agent is configured with `usePlanner: true`, the `AgentLoop` calls
 * `generatePlan()` before the first iteration. The Planner makes a single LLM
 * call with a structured prompt that describes the user's goal and the available
 * tools, then parses the JSON response into a {@link Plan}.
 *
 * The plan provides:
 * - **Full auditability** — every intended tool call is documented before execution.
 * - **HITL gate** — when `plan.requiresApproval` is `true`, the `AgentLoop`
 *   returns early so the caller can inspect and approve the plan before any
 *   tool is executed.
 * - **Observability** — the `agent.plan.generated` event carries the full plan
 *   for logging and monitoring.
 *
 * @example
 * ```typescript
 * const planner = new Planner(llmProvider, 'claude-opus-5');
 * const plan = await planner.generatePlan(
 *   'Transfer $5 000 to account 9002 and send a confirmation email',
 *   availableToolDescriptors,
 *   executionContext,
 * );
 * // plan.steps → [{ toolName: 'finance.transfer', ... }, { toolName: 'email.send', ... }]
 * // plan.requiresApproval → true
 * ```
 */
export class Planner {
  readonly #llm: LLMProvider;
  readonly #model: string;
  readonly #temperature: number;
  readonly #maxTokens: number;

  /**
   * @param llm         - LLM provider used for plan generation.
   * @param model       - Model identifier (e.g. `'claude-opus-5'`).
   * @param temperature - Sampling temperature. Lower values yield more
   *   deterministic JSON output. Default: `0`.
   * @param maxTokens   - Maximum tokens for the plan response. Default: `1024`.
   */
  constructor(llm: LLMProvider, model: string, temperature = 0, maxTokens = 1024) {
    this.#llm = llm;
    this.#model = model;
    this.#temperature = temperature;
    this.#maxTokens = maxTokens;
  }

  /**
   * Generates a structured execution plan for the given goal.
   *
   * Makes one LLM call with the planner system prompt, then parses and
   * validates the JSON response. The returned plan has `status: 'draft'`;
   * the `AgentLoop` is responsible for transitioning it to `'executing'` or
   * returning it to the caller for approval when `requiresApproval` is `true`.
   *
   * @param goal    - The user's request to plan for (the raw user message).
   * @param tools   - Tool descriptors available to the agent for this request.
   * @param context - Execution context (used for tracing; not injected into the prompt).
   * @returns A {@link Plan} with `status: 'draft'`.
   * @throws {@link PlannerError} if the LLM response cannot be parsed into a valid plan.
   */
  async generatePlan(
    goal: string,
    tools: ToolDescriptor[],

    _context: ExecutionContext,
  ): Promise<Plan> {
    const toolList =
      tools.length === 0
        ? 'No tools available — the agent can only respond with text.'
        : tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');

    const userMessage = `Goal: ${goal}\n\nAvailable tools:\n${toolList}`;

    const request: LLMRequest = {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      model: this.#model,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
    };

    const response = await this.#llm.call(request);
    const partial = parsePlanFromContent(response.content);

    return {
      planId: randomUUID(),
      status: 'draft',
      createdAt: new Date(),
      ...partial,
    };
  }
}
