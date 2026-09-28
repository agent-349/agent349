import type {
  AgentConfig,
  AgentEvent,
  AgentResponse,
  ContentBlock,
  ExecutionContext,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  MessageContent,
  Plan,
  PendingActionSummary,
  RunOptions,
  Tool,
  ToolDescriptor,
  UserContext,
} from '../types/index.js';
import { MaxIterationsError, AccessDeniedError, TokenLimitError } from '../errors/index.js';
import { EventBus } from '../events/EventBus.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import { UntrustedTracker } from '../security/UntrustedTracker.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { TokenTracker, estimateLLMRequestTokens } from '../tokens/TokenTracker.js';
import { LLMProvider } from '../llm/LLMProvider.js';
import { ContentResolver } from '../llm/ContentResolver.js';
import { applyMediaPersistence } from '../memory/mediaPersistence.js';
import { contentToText, text as textBlock } from '../content/index.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import type { SecurityMiddlewareChain } from '../security/middleware/SecurityMiddlewareChain.js';
import type { ACLService } from '../security/ACLService.js';
import type { MiddlewarePayload } from '../security/types.js';
import type { ApprovalService } from '../approval/ApprovalService.js';
import { DEFAULT_APPROVAL_MESSAGES, formatApprovalMessage } from '../approval/messages.js';
import type { ApprovalMessages } from '../approval/messages.js';
import type { Planner } from './Planner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fully-resolved LLM config — all fields required except fallbacks. */
interface ResolvedLLMConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fallbackProvider?: string;
  fallbackModel?: string;
}

/** Strips `execute` from a Tool, leaving only the ToolDescriptor fields. */
// The `execute` binding exists solely to be discarded by the rest spread; it is
// never read or invoked, so both the unused-var and unbound-method rules are
// reporting on a value that does not escape this line.
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/unbound-method
function toDescriptor({ execute, ...descriptor }: Tool): ToolDescriptor {
  return descriptor;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentLoop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The core agent loop that orchestrates LLM calls, tool executions, and
 * memory management for a single user request.
 *
 * The loop follows the pattern defined in the architecture doc (section 8.2):
 *
 * 1. Load conversation history (or use the caller-supplied `externalContext`).
 * 2. Build the composite system prompt.
 * 3. Append the user's message.
 * 4. Iterate: call LLM → execute tool calls (if any) → repeat; break on a
 *    text-only response.
 * 5. Persist the updated conversation (unless stateless mode).
 * 6. Emit lifecycle events at every step.
 *
 * ### Security integration (section 5.4)
 *
 * When a {@link SecurityMiddlewareChain} is provided the loop inserts three
 * security checkpoints:
 *
 * - **Pre `agent_start`** — rate limiting and prompt-injection detection.
 *   A `block` decision throws {@link AccessDeniedError}; a `modify` decision
 *   replaces the raw user message with the sanitised version.
 * - **Pre `tool_call`** — ACL check for each tool. A `block` injects an
 *   `ACCESS_DENIED` error message for that tool and skips execution, so the
 *   LLM can explain the refusal without crashing the loop.
 * - **Post `tool_result`** — data filtering and field masking. A `modify`
 *   decision replaces the raw tool output with the filtered/masked version
 *   before it is added to the conversation history.
 *
 * When an {@link ACLService} is provided, tools are filtered by ACL **before**
 * the first LLM call in each iteration, so the LLM never sees tools the user
 * cannot invoke.
 *
 * @example
 * ```typescript
 * const loop = new AgentLoop(
 *   agentConfig, toolRegistry, skillRegistry,
 *   claudeProvider, memoryManager, eventBus, tokenTracker,
 *   securityChain, aclService,
 * );
 *
 * const response = await loop.run(
 *   'What is the balance of account 1001?',
 *   executionContext,
 * );
 * ```
 */
export class AgentLoop {
  readonly #agent: AgentConfig;
  /** Guaranteed non-null: Orchestrator always passes a resolved agent config. */
  readonly #llmCfg: ResolvedLLMConfig;
  readonly #skills: SkillRegistry;
  readonly #toolExecutor: ToolExecutor;
  readonly #llm: LLMProvider;
  readonly #memory: MemoryManager;
  readonly #bus: EventBus;
  readonly #tokens: TokenTracker;
  readonly #securityChain: SecurityMiddlewareChain | undefined;
  readonly #aclService: ACLService | undefined;
  readonly #approvalService: ApprovalService | undefined;
  readonly #planner: Planner | undefined;
  /** Set at the start of each run() call; used to inject _context into emitted events. */
  #currentContext: ExecutionContext | undefined;

  /**
   * @param agent            - Configuration of the agent to run.
   * @param toolRegistry     - Registry containing all registered tools.
   * @param skillRegistry    - Registry resolving skills to tools and prompt additions.
   * @param llmProvider      - LLM backend to call on each iteration.
   * @param memoryManager    - Memory backend for loading and saving conversation history.
   * @param eventBus         - Event bus for broadcasting lifecycle events.
   * @param tokenTracker     - Tracker for recording LLM token consumption.
   * @param securityChain    - Optional middleware chain for security checkpoints.
   * @param aclService       - Optional ACL service for filtering tools before LLM calls.
   * @param approvalService  - Optional HITL approval service. When provided, tool calls
   *   are evaluated against approval triggers before execution. Matching tool calls are
   *   deferred as {@link PendingAction}s and the LLM is informed via a `PENDING_APPROVAL`
   *   tool result message so it can explain the situation to the user.
   * @param planner          - Optional Planner. When provided and `agent.usePlanner` is
   *   `true`, a structured execution plan is generated before the loop starts. If the
   *   plan's `requiresApproval` flag is `true`, the loop returns immediately so the
   *   caller can inspect and approve the plan before any tool is executed.
   */
  constructor(
    agent: AgentConfig,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    llmProvider: LLMProvider,
    memoryManager: MemoryManager,
    eventBus: EventBus,
    tokenTracker: TokenTracker,
    securityChain?: SecurityMiddlewareChain,
    aclService?: ACLService,
    approvalService?: ApprovalService,
    planner?: Planner,
  ) {
    this.#agent = agent;
    // Orchestrator always passes an agent with a resolved llmConfig.

    this.#llmCfg = agent.llmConfig as ResolvedLLMConfig;
    this.#skills = skillRegistry;
    // One tracker per loop: a loop serves a single turn, which is exactly the
    // scope provenance is tracked over, so nothing outlives the run.
    this.#toolExecutor = new ToolExecutor(toolRegistry, eventBus, {
      untrustedTracker: new UntrustedTracker(eventBus),
    });
    this.#llm = llmProvider;
    this.#memory = memoryManager;
    this.#bus = eventBus;
    this.#tokens = tokenTracker;
    this.#securityChain = securityChain;
    this.#aclService = aclService;
    this.#approvalService = approvalService;
    this.#planner = planner;
  }

  /**
   * Applies a middleware's sanitised text to a turn while preserving its media.
   *
   * A sanitiser rewrites text, not attachments: the rewritten text replaces the
   * turn's text blocks in place (at the position of the first one) and every
   * media block is kept, so sanitisation never silently discards a document.
   */
  static #applySanitisedText(content: MessageContent, sanitised: string): MessageContent {
    if (typeof content === 'string') return sanitised;

    const out: ContentBlock[] = [];
    let replaced = false;
    for (const block of content) {
      if (block.type === 'text') {
        if (!replaced) {
          out.push(textBlock(sanitised));
          replaced = true;
        }
        continue;
      }
      out.push(block);
    }
    if (!replaced) out.unshift(textBlock(sanitised));
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the agent loop for a single user turn and returns the final response.
   *
   * @param userMessage - The user's input: plain text, or content blocks when the
   *                      turn carries images, documents or other media. Build
   *                      blocks with the helpers in `llm/content.ts`.
   * @param context     - Execution context (tenant, user, session, agent, request).
   * @param options     - Optional stateless context, user profile, response format
   *                      and event callback.
   * @returns The agent's final text response, tool usage summary, and token stats.
   * @throws {@link AccessDeniedError} if the security chain blocks the request at `agent_start`.
   * @throws {@link MaxIterationsError} if the loop exceeds `agent.maxLoopIterations`.
   * @throws {@link UnsupportedCapabilityError} if the turn needs a capability the
   *         provider or model does not have.
   */
  async run(
    userMessage: MessageContent,
    context: ExecutionContext,
    options?: RunOptions,
  ): Promise<AgentResponse> {
    this.#currentContext = context;
    const startMs = Date.now();
    // maxLoopIterations is always set by the Orchestrator from config defaults
    const maxIterations = this.#agent.maxLoopIterations ?? 10;

    // ── 0. Pre agent_start security check ────────────────────────────────
    if (this.#securityChain !== undefined) {
      const preCheck = await this.#securityChain.executePre(context, {
        type: 'agent_start',
        // Middlewares reason over text; media travels alongside so a chain can
        // inspect or replace it without the text view ever holding binaries.
        message: contentToText(userMessage),
        ...(typeof userMessage !== 'string' && { blocks: userMessage }),
      });

      if (preCheck.action === 'block') {
        this.#emit(
          'security.access.denied',
          { type: 'agent_start', reason: preCheck.reason },
          options?.onEvent,
        );
        throw new AccessDeniedError('agent', context.agentId ?? 'session', context.roles);
      }

      if (preCheck.action === 'modify') {
        const modified = preCheck.modifiedPayload as MiddlewarePayload;
        if (modified.blocks !== undefined) {
          userMessage = modified.blocks;
        } else if (modified.message !== undefined) {
          userMessage = AgentLoop.#applySanitisedText(userMessage, modified.message);
        }
      }
    }

    // ── 1. Load memory or use external context ────────────────────────────
    // _resumeContext is set internally by Orchestrator.approve() and carries
    // a pre-built message array that already includes the approved tool result
    // and DEFERRED placeholders for any sibling calls. When present, we use it
    // directly and skip the user-message push below.
    const isResume = options?._resumeContext !== undefined;

    // Clone the loaded array so in-loop mutations (push) do not corrupt the
    // stored history if the loop fails before reaching save().
    const messages: LLMMessage[] = isResume
      ? [...options._resumeContext!]
      : options?.externalContext
        ? [...options.externalContext]
        : [...(await this.#memory.load(context.sessionId))];

    // ── 2. Build composite system prompt ─────────────────────────────────
    const skillAdditions = this.#skills.resolveSystemPrompt(this.#agent.skills);
    const systemPrompt = this.#buildSystemPrompt(
      this.#agent.systemPrompt,
      skillAdditions,
      options?.externalUserContext,
    );

    // ── 3. Resolve tools for this agent ──────────────────────────────────
    const tools = this.#skills.resolveTools(this.#agent.skills);
    const allDescriptors = tools.map(toDescriptor);

    // Record which skills participated in this run (one event per skill).
    for (const skillId of this.#agent.skills) {
      this.#emit('skill.activated', { skillId }, options?.onEvent);
    }

    // ── 3a. Filter tools by ACL before exposing to the LLM ───────────────
    const descriptors: ToolDescriptor[] =
      this.#aclService !== undefined
        ? this.#aclService.filterTools(allDescriptors, context)
        : allDescriptors;

    // ── 3b. Generate execution plan (optional) ───────────────────────────
    // Skip the planner on resume: the plan was already generated (and approved)
    // in the original run. Re-planning would incorrectly gate the resumed flow.
    let plan: Plan | undefined;
    if (!isResume && this.#planner !== undefined && this.#agent.usePlanner === true) {
      // The planner reasons over the goal in words; attachments reach the loop
      // itself, so it receives the text view of the turn.
      plan = await this.#planner.generatePlan(contentToText(userMessage), descriptors, context);

      this.#emit('agent.plan.generated', { plan }, options?.onEvent);

      if (plan.requiresApproval) {
        // Emit a dedicated event so callers can hook into plan-level approval.
        this.#emit('agent.plan.approval_required', { plan }, options?.onEvent);

        // Return before executing any tool — let the caller inspect and decide.
        return {
          content: formatApprovalMessage(this.#messages.planRequiresApproval, {
            goal: plan.goal,
            steps: plan.steps.length,
          }),
          toolsUsed: [],
          iterations: 0,
          plan,
          usage: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCostUsd: 0,
            byIteration: [],
          },
          durationMs: Date.now() - startMs,
          hasPendingApprovals: true,
        };
      }

      // Plan approved (no approval required) — transition to executing.
      plan = { ...plan, status: 'executing' };
    }

    // ── 4. Append the user message ───────────────────────────────────────
    // On resume, the full message history (including the user turn) is already
    // in the array supplied by _resumeContext — do not push again.
    if (!isResume) {
      messages.push({ role: 'user', content: userMessage });
    }

    // ── 5. Emit loop start ───────────────────────────────────────────────
    this.#emit('agent.loop.start', { context }, options?.onEvent);

    const toolsUsed: string[] = [];
    const pendingActionSummaries: PendingActionSummary[] = [];
    // References created by the provider while transporting attachments, so the
    // caller can reuse or delete them instead of re-uploading on the next turn.
    const uploadedFiles: NonNullable<AgentResponse['uploadedFiles']> = [];
    const usageByIteration: LLMResponse['usage'][] = [];
    let iterations = 0;

    // ── 6. Main loop ─────────────────────────────────────────────────────
    while (iterations < maxIterations) {
      iterations++;

      // 6a. Emit LLM call start
      const media = ContentResolver.describe(
        messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)),
      );
      this.#emit(
        'llm.call.start',
        {
          iteration: iterations,
          model: this.#llmCfg.model,
          // Counts, types and sizes only — never the content itself.
          ...(media.length > 0 && { media }),
        },
        options?.onEvent,
      );

      // 6b. Call LLM
      let response: LLMResponse;
      try {
        // Capture the iteration number for the streaming closure below.
        const iter = iterations;
        const request: LLMRequest = {
          systemPrompt,
          messages,
          model: this.#llmCfg.model,
          temperature: this.#llmCfg.temperature,
          maxTokens: this.#llmCfg.maxTokens,
          ...(this.#llmCfg.reasoningEffort !== undefined && {
            reasoningEffort: this.#llmCfg.reasoningEffort,
          }),
          ...(descriptors.length > 0 && { tools: descriptors }),
          ...(options?.responseFormat !== undefined && {
            responseFormat: options.responseFormat,
          }),
          ...(options?.fileHandling !== undefined && { fileHandling: options.fileHandling }),
          ...(options?.providerOptions !== undefined && {
            providerOptions: options.providerOptions,
          }),
          // Token streaming: forward each text delta as a `llm.token` event.
          // Tool-decision iterations emit no text content, so only the final
          // answer streams. The provider still returns the full LLMResponse.
          ...(options?.stream === true && {
            onToken: (delta: string) =>
              this.#emit('llm.token', { delta, iteration: iter }, options?.onEvent),
          }),
          ...(options?.signal !== undefined && { signal: options.signal }),
        };
        const decision = await this.#tokens.checkLimits(
          context.tenantId,
          context.userId,
          estimateLLMRequestTokens(request),
        );
        if (decision.exceeded) {
          this.#emit(
            'tokens.limit.observed',
            {
              mode: decision.mode,
              estimatedTokens: decision.estimatedTokens,
              violation: decision.violation,
            },
            options?.onEvent,
          );
        }
        if (!decision.allowed && decision.violation !== undefined) {
          throw new TokenLimitError(
            context.tenantId,
            decision.violation,
            decision.violation.scope === 'user' ? context.userId : undefined,
          );
        }
        response = await this.#llm.call(request);
      } catch (err) {
        this.#emit(
          'llm.call.error',
          { error: err, provider: this.#llmCfg.provider },
          options?.onEvent,
        );
        throw err;
      }

      // 6c. Record tokens. Fill in the cost from the configured price list when
      // the provider didn't report one, so AgentResponse.usage and the stored
      // records share a single, consistent cost.
      if (response.usage.cost === undefined) {
        response.usage.cost = this.#tokens.estimateCost(
          response.model,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
      }
      await this.#tokens.record(context, {
        ...response.usage,
        provider: response.provider,
        model: response.model,
      });
      usageByIteration.push(response.usage);
      if (response.uploadedFiles !== undefined) uploadedFiles.push(...response.uploadedFiles);

      // 6d. Emit LLM call end + tokens recorded
      this.#emit(
        'llm.call.end',
        {
          usage: response.usage,
          latencyMs: response.latencyMs,
          performance: response.performance,
          model: response.model,
          provider: response.provider,
        },
        options?.onEvent,
      );
      if (this.#tokens.limitMode !== 'disabled') {
        this.#emit(
          'tokens.recorded',
          {
            tenantId: context.tenantId,
            userId: context.userId,
            tokens: response.usage.totalTokens,
          },
          options?.onEvent,
        );
      }

      // 6e. Tool calls — continue the loop
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Push the assistant turn that requested the tools.
        messages.push({
          role: 'assistant',
          content: response.contentBlocks ?? response.content,
        });

        // Tracks whether a HITL suspension was triggered inside the for loop.
        let suspended = false;

        for (const call of response.toolCalls) {
          // ── Pre tool_call: ACL check ──────────────────────────────────
          if (this.#securityChain !== undefined) {
            const toolCheck = await this.#securityChain.executePre(context, {
              type: 'tool_call',
              toolName: call.toolName,
              input: call.input,
            });

            if (toolCheck.action === 'block') {
              this.#emit(
                'security.tool.blocked',
                { toolName: call.toolName, reason: toolCheck.reason },
                options?.onEvent,
              );
              messages.push({
                role: 'tool',
                content: JSON.stringify({
                  error: 'ACCESS_DENIED',
                  message: toolCheck.reason,
                }),
                toolCallId: call.id,
                name: call.toolName,
              });
              continue;
            }
          }

          // ── HITL: approval check ──────────────────────────────────
          if (this.#approvalService !== undefined) {
            const req = this.#approvalService.requiresApproval(call.toolName, call.input, context);
            if (req !== null) {
              const trigger = this.#approvalService.getTriggerById(req.triggerId);
              if (trigger !== undefined) {
                // Calls after this one in the same LLM turn that will be skipped.
                // Saved so Orchestrator.approve() can inject DEFERRED placeholders,
                // letting the LLM API receive a result for every call in the turn.
                const callIndex = response.toolCalls.indexOf(call);
                const siblingCalls = response.toolCalls
                  .slice(callIndex + 1)
                  .map((c) => ({ id: c.id, toolName: c.toolName }));

                const pending = await this.#approvalService.createPendingAction(
                  call.toolName,
                  call.input,
                  context,
                  trigger,
                  options?.approvalCallback,
                  {
                    // Snapshot taken before pushing the PENDING_APPROVAL result.
                    // At this point messages = [...history, user_msg, assistant_turn].
                    // Binaries never reach the pending-action store: the
                    // snapshot keeps an explicit placeholder (and any provider
                    // file reference) so a resumed run is not silently poorer.
                    messagesSnapshot: applyMediaPersistence(messages).messages,
                    toolCallId: call.id,
                    siblingCalls,
                  },
                );
                pendingActionSummaries.push({
                  actionId: pending.id,
                  toolName: pending.toolName,
                  description: pending.description,
                  risk: pending.risk,
                  status: pending.status,
                  expiresAt: pending.expiresAt,
                });
                messages.push({
                  role: 'tool',
                  content: JSON.stringify({
                    status: 'PENDING_APPROVAL',
                    actionId: pending.id,
                    reason: req.reason,
                    message: this.#messages.pendingToolResult,
                  }),
                  toolCallId: call.id,
                  name: call.toolName,
                });
                suspended = true;
                break; // Do NOT process further calls until this one is resolved.
              }
            }
          }

          this.#emit(
            'tool.call.start',
            { toolName: call.toolName, input: call.input },
            options?.onEvent,
          );

          const result = await this.#toolExecutor.execute(call.toolName, call.input, context);
          toolsUsed.push(call.toolName);

          if (result.success) {
            this.#emit(
              'tool.call.end',
              {
                toolName: call.toolName,
                success: true,
                toolResult: result,
                durationMs: result.metadata?.durationMs,
              },
              options?.onEvent,
            );
          } else {
            this.#emit(
              'tool.call.error',
              { toolName: call.toolName, error: result.error },
              options?.onEvent,
            );
            this.#emit(
              'tool.call.end',
              {
                toolName: call.toolName,
                success: false,
                toolResult: result,
                durationMs: result.metadata?.durationMs,
              },
              options?.onEvent,
            );
          }

          // ── Post tool_result: filter + mask ───────────────────────────
          let toolOutput: unknown = result.data;
          if (this.#securityChain !== undefined && result.success) {
            const postResult = await this.#securityChain.executePost(context, {
              type: 'tool_result',
              toolName: call.toolName,
              output: toolOutput,
            });
            if (postResult.action === 'modify') {
              const modified = postResult.modifiedPayload as MiddlewarePayload;
              toolOutput = modified.output;
            }
          }

          messages.push({
            role: 'tool',
            content: JSON.stringify(toolOutput ?? null),
            toolCallId: call.id,
            name: call.toolName,
          });
        }

        // ── Suspended: return without continuing the while loop ───────
        if (suspended) {
          const suspendedContent =
            pendingActionSummaries.length === 1
              ? formatApprovalMessage(this.#messages.suspendedSingle, {
                  toolName: pendingActionSummaries[0]!.toolName,
                })
              : formatApprovalMessage(this.#messages.suspendedMultiple, {
                  count: pendingActionSummaries.length,
                });

          // Persist the suspended agent turn so the conversation history
          // reflects the pending state if the user sends a follow-up message.
          messages.push({ role: 'assistant', content: suspendedContent });

          if (!isResume && !options?.externalContext) {
            await this.#memory.save(context.sessionId, messages);
          }

          this.#emit('agent.loop.end', { iterations, suspended: true }, options?.onEvent);

          return {
            content: suspendedContent,
            toolsUsed,
            iterations,
            suspended: true,
            hasPendingApprovals: true,
            pendingActions: pendingActionSummaries,
            usage: {
              totalInputTokens: usageByIteration.reduce((s, u) => s + u.inputTokens, 0),
              totalOutputTokens: usageByIteration.reduce((s, u) => s + u.outputTokens, 0),
              totalCostUsd: usageByIteration.reduce((s, u) => s + (u.cost ?? 0), 0),
              byIteration: usageByIteration,
            },
            durationMs: Date.now() - startMs,
          };
        }

        continue;
      }

      // 6f. Final response — no tool calls
      messages.push({ role: 'assistant', content: response.content });

      // 7. Save memory (skip in stateless mode)
      if (!options?.externalContext) {
        await this.#memory.save(context.sessionId, messages);
      }

      this.#emit('agent.loop.end', { iterations, content: response.content }, options?.onEvent);

      const completedPlan =
        plan !== undefined ? { ...plan, status: 'completed' as const } : undefined;

      return {
        content: response.content,
        toolsUsed,
        iterations,
        ...(completedPlan !== undefined && { plan: completedPlan }),
        usage: {
          totalInputTokens: usageByIteration.reduce((s, u) => s + u.inputTokens, 0),
          totalOutputTokens: usageByIteration.reduce((s, u) => s + u.outputTokens, 0),
          totalCostUsd: usageByIteration.reduce((s, u) => s + (u.cost ?? 0), 0),
          byIteration: usageByIteration,
        },
        durationMs: Date.now() - startMs,
        ...(response.structured !== undefined && { structured: response.structured }),
        ...(uploadedFiles.length > 0 && { uploadedFiles }),
        hasPendingApprovals: pendingActionSummaries.length > 0,
        ...(pendingActionSummaries.length > 0 && { pendingActions: pendingActionSummaries }),
      };
    }

    // 8. Loop limit reached
    throw new MaxIterationsError(maxIterations);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds the composite system prompt from the agent's base prompt, any
   * skill additions, and an optional injected user context summary.
   */
  /** Texts for approval flows, as configured on the approval service. */
  get #messages(): Readonly<ApprovalMessages> {
    return this.#approvalService?.messages ?? DEFAULT_APPROVAL_MESSAGES;
  }

  #buildSystemPrompt(base: string, skillAdditions: string, userContext?: UserContext): string {
    const parts: string[] = [base];

    if (skillAdditions.length > 0) {
      parts.push(skillAdditions);
    }

    if (userContext !== undefined) {
      const lines: string[] = [
        `User ID: ${userContext.userId}`,
        `Roles: ${userContext.roles.join(', ')}`,
      ];
      if (userContext.longTermFacts && userContext.longTermFacts.length > 0) {
        const facts = userContext.longTermFacts.map((f) => `- ${f}`).join('\n');
        lines.push(`Known facts about user:\n${facts}`);
      }
      parts.push(lines.join('\n'));
    }

    return parts.join('\n\n');
  }

  /**
   * Emits an event on the EventBus and forwards it to the caller's `onEvent`
   * callback (if provided).
   */
  #emit(
    type: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>,
    onEvent?: (event: AgentEvent) => void,
  ): void {
    const enriched =
      this.#currentContext !== undefined
        ? {
            ...data,
            _context: {
              tenantId: this.#currentContext.tenantId,
              userId: this.#currentContext.userId,
              agentId: this.#currentContext.agentId,
              sessionId: this.#currentContext.sessionId,
              requestId: this.#currentContext.requestId,
            },
          }
        : data;
    const event: AgentEvent = { type, data: enriched, timestamp: new Date() };
    this.#bus.emit(type, enriched);
    onEvent?.(event);
  }
}
