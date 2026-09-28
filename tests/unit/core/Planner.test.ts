import { describe, it, expect, beforeEach } from 'vitest';
import { Planner } from '../../../src/core/Planner.js';
import { PlannerError } from '../../../src/errors/index.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type {
  LLMRequest,
  LLMResponse,
  ExecutionContext,
  ToolDescriptor,
  ProviderCapabilities,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM Provider
// ─────────────────────────────────────────────────────────────────────────────

class MockLLMProvider extends LLMProvider {
  readonly name = 'mock';
  readonly providerType = 'mock';
  public lastRequest: LLMRequest | null = null;
  private readonly responseContent: string;

  constructor(content: string) {
    super();
    this.responseContent = content;
  }

  override async call(req: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = req;
    return {
      content: this.responseContent,
      stopReason: 'end',
      usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 5,
    };
  }

  override async validate(): Promise<boolean> {
    return true;
  }
  override async listModels(): Promise<string[]> {
    return [];
  }

  override capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeContext(): ExecutionContext {
  return {
    tenantId: 'test-tenant',
    userId: 'user-1',
    roles: ['admin'],
    sessionId: 'session-1',
    agentId: 'agent-1',
    requestId: 'req-1',
  };
}

const FINANCE_TOOLS: ToolDescriptor[] = [
  {
    name: 'finance.getBalance',
    description: 'Retrieves the current balance of an account.',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string' } },
      required: ['accountId'],
    },
  },
  {
    name: 'finance.transfer',
    description: 'Transfers funds between two accounts. Irreversible operation.',
    inputSchema: {
      type: 'object',
      properties: {
        fromAccount: { type: 'string' },
        toAccount: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['fromAccount', 'toAccount', 'amount'],
    },
  },
];

function makeValidPlanJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: 'Check balance and transfer funds',
    steps: [
      {
        stepId: 'step-1',
        toolName: 'finance.getBalance',
        inputTemplate: { accountId: '1001' },
        dependsOn: [],
        description: 'Retrieve the current balance of account 1001',
      },
      {
        stepId: 'step-2',
        toolName: 'finance.transfer',
        inputTemplate: { fromAccount: '1001', toAccount: '9002', amount: 5000 },
        dependsOn: ['step-1'],
        description: 'Transfer $5000 from account 1001 to 9002',
      },
    ],
    estimatedTokens: 300,
    requiresApproval: false,
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Planner.generatePlan — success paths
// ─────────────────────────────────────────────────────────────────────────────

describe('Planner.generatePlan — success', () => {
  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it('parses a valid JSON plan and returns correct structure', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    expect(plan.planId).toBeTypeOf('string');
    expect(plan.planId).toHaveLength(36); // UUID v4
    expect(plan.status).toBe('draft');
    expect(plan.createdAt).toBeInstanceOf(Date);
    expect(plan.goal).toBe('Check balance and transfer funds');
    expect(plan.steps).toHaveLength(2);
    expect(plan.requiresApproval).toBe(false);
    expect(plan.estimatedTokens).toBe(300);
  });

  it('maps step fields correctly', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    const step1 = plan.steps[0]!;
    expect(step1.stepId).toBe('step-1');
    expect(step1.toolName).toBe('finance.getBalance');
    expect(step1.inputTemplate).toEqual({ accountId: '1001' });
    expect(step1.description).toBe('Retrieve the current balance of account 1001');

    const step2 = plan.steps[1]!;
    expect(step2.dependsOn).toEqual(['step-1']);
  });

  it('sets requiresApproval to true when flagged in JSON', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson({ requiresApproval: true }));
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    expect(plan.requiresApproval).toBe(true);
  });

  it('handles a plan with no steps (text-only response)', async () => {
    const provider = new MockLLMProvider(
      JSON.stringify({
        goal: 'Answer a general question',
        steps: [],
        estimatedTokens: 50,
        requiresApproval: false,
      }),
    );
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('What is 2+2?', [], ctx);

    expect(plan.steps).toHaveLength(0);
    expect(plan.requiresApproval).toBe(false);
  });

  it('strips markdown code fences from LLM response', async () => {
    const raw = '```json\n' + makeValidPlanJson() + '\n```';
    const provider = new MockLLMProvider(raw);
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    expect(plan.goal).toBe('Check balance and transfer funds');
    expect(plan.steps).toHaveLength(2);
  });

  it('strips plain code fences (no language tag) from LLM response', async () => {
    const raw = '```\n' + makeValidPlanJson() + '\n```';
    const provider = new MockLLMProvider(raw);
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    expect(plan.steps).toHaveLength(2);
  });

  it('omits estimatedTokens when LLM does not include it', async () => {
    const json = JSON.stringify({
      goal: 'Simple query',
      steps: [],
      requiresApproval: false,
    });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    const plan = await planner.generatePlan('Query', [], ctx);

    expect(plan.estimatedTokens).toBeUndefined();
  });

  it('sends tool descriptors in the user message', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(provider, 'mock-model');

    await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    const req = provider.lastRequest!;
    const userMsg = req.messages[0]!.content as string;
    expect(userMsg).toContain('finance.getBalance');
    expect(userMsg).toContain('finance.transfer');
    expect(userMsg).toContain('Transfer funds');
  });

  it('sends "No tools available" message when tool list is empty', async () => {
    const json = JSON.stringify({ goal: 'General question', steps: [], requiresApproval: false });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await planner.generatePlan('What is the capital of France?', [], ctx);

    const req = provider.lastRequest!;
    const userMsg = req.messages[0]!.content as string;
    expect(userMsg).toContain('No tools available');
  });

  it('passes the configured model and temperature to the LLM', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(provider, 'claude-opus-4-6', 0.1, 2048);

    await planner.generatePlan('Transfer funds', FINANCE_TOOLS, ctx);

    const req = provider.lastRequest!;
    expect(req.model).toBe('claude-opus-4-6');
    expect(req.temperature).toBe(0.1);
    expect(req.maxTokens).toBe(2048);
  });

  it('each call generates a unique planId', async () => {
    const provider = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(provider, 'mock-model');

    const plan1 = await planner.generatePlan('Query', FINANCE_TOOLS, ctx);
    const plan2 = await planner.generatePlan('Query', FINANCE_TOOLS, ctx);

    expect(plan1.planId).not.toBe(plan2.planId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Planner.generatePlan — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('Planner.generatePlan — error paths', () => {
  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it('throws PlannerError when LLM returns invalid JSON', async () => {
    const provider = new MockLLMProvider('This is not JSON at all.');
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when response is a JSON array instead of object', async () => {
    const provider = new MockLLMProvider('[1, 2, 3]');
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when "goal" field is missing', async () => {
    const json = JSON.stringify({ steps: [], requiresApproval: false });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when "steps" field is missing', async () => {
    const json = JSON.stringify({ goal: 'Something', requiresApproval: false });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when a step is missing "stepId"', async () => {
    const json = JSON.stringify({
      goal: 'Query',
      steps: [{ toolName: 'finance.getBalance', description: 'Get balance' }],
      requiresApproval: false,
    });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when a step is missing "toolName"', async () => {
    const json = JSON.stringify({
      goal: 'Query',
      steps: [{ stepId: 'step-1', description: 'Do something' }],
      requiresApproval: false,
    });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('throws PlannerError when a step element is not an object', async () => {
    const json = JSON.stringify({
      goal: 'Query',
      steps: ['not-an-object'],
      requiresApproval: false,
    });
    const provider = new MockLLMProvider(json);
    const planner = new Planner(provider, 'mock-model');

    await expect(planner.generatePlan('Query', FINANCE_TOOLS, ctx)).rejects.toThrow(PlannerError);
  });

  it('PlannerError has code PLANNER_ERROR', async () => {
    const provider = new MockLLMProvider('not json');
    const planner = new Planner(provider, 'mock-model');

    let caught: unknown;
    try {
      await planner.generatePlan('Query', FINANCE_TOOLS, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlannerError);
    expect((caught as PlannerError).code).toBe('PLANNER_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AgentLoop integration with Planner
// ─────────────────────────────────────────────────────────────────────────────

import { AgentLoop } from '../../../src/core/AgentLoop.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { DefaultMemoryManager } from '../../../src/memory/DefaultMemoryManager.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { SlidingWindow } from '../../../src/memory/strategies/SlidingWindow.js';
import type { AgentConfig, AgentEvent } from '../../../src/types/index.js';

function makeAgentConfig(usePlanner = false): AgentConfig {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    systemPrompt: 'You are a helpful assistant.',
    skills: [],
    llmConfig: { provider: 'mock', model: 'mock-model', temperature: 0, maxTokens: 1024 },
    maxLoopIterations: 5,
    usePlanner,
  };
}

function makeInfra(agentLLMContent: string) {
  const bus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const tokens = new TokenTracker(new InMemoryAdapter());
  const memory = new DefaultMemoryManager(
    new InMemoryAdapter(),
    new InMemoryAdapter(),
    new SlidingWindow({ maxMessages: 20 }),
  );
  const agentLLM = new MockLLMProvider(agentLLMContent);
  return { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM };
}

describe('AgentLoop + Planner integration', () => {
  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it('generates a plan and attaches it to the response when usePlanner is true', async () => {
    const planJson = makeValidPlanJson({ requiresApproval: false });
    const plannerLLM = new MockLLMProvider(planJson);
    const planner = new Planner(plannerLLM, 'mock-model');

    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } =
      makeInfra('Task completed.');

    const loop = new AgentLoop(
      makeAgentConfig(true),
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
      undefined,
      undefined,
      undefined,
      planner,
    );

    const response = await loop.run('Transfer funds', ctx);

    expect(response.plan).toBeDefined();
    expect(response.plan!.status).toBe('completed');
    expect(response.plan!.goal).toBe('Check balance and transfer funds');
    expect(response.content).toBe('Task completed.');
    expect(response.hasPendingApprovals).toBe(false);
  });

  it('returns early with hasPendingApprovals when plan.requiresApproval is true', async () => {
    const planJson = makeValidPlanJson({ requiresApproval: true });
    const plannerLLM = new MockLLMProvider(planJson);
    const planner = new Planner(plannerLLM, 'mock-model');

    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } =
      makeInfra('Should not be called.');

    const events: AgentEvent[] = [];

    const loop = new AgentLoop(
      makeAgentConfig(true),
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
      undefined,
      undefined,
      undefined,
      planner,
    );

    const response = await loop.run('Transfer funds', ctx, {
      onEvent: (e) => events.push(e),
    });

    expect(response.hasPendingApprovals).toBe(true);
    expect(response.plan).toBeDefined();
    expect(response.plan!.status).toBe('draft');
    expect(response.plan!.requiresApproval).toBe(true);
    expect(response.toolsUsed).toHaveLength(0);
    expect(response.iterations).toBe(0);

    // Agent LLM should NOT have been called since we returned before the loop.
    expect(agentLLM.lastRequest).toBeNull();
  });

  it('emits agent.plan.generated event when plan is created', async () => {
    const planJson = makeValidPlanJson({ requiresApproval: false });
    const plannerLLM = new MockLLMProvider(planJson);
    const planner = new Planner(plannerLLM, 'mock-model');

    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } = makeInfra('Done.');

    const events: AgentEvent[] = [];

    const loop = new AgentLoop(
      makeAgentConfig(true),
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
      undefined,
      undefined,
      undefined,
      planner,
    );

    await loop.run('Transfer funds', ctx, { onEvent: (e) => events.push(e) });

    const planEvent = events.find((e) => e.type === 'agent.plan.generated');
    expect(planEvent).toBeDefined();
    expect(planEvent!.data['plan']).toBeDefined();
  });

  it('emits agent.plan.approval_required event when plan needs approval', async () => {
    const planJson = makeValidPlanJson({ requiresApproval: true });
    const plannerLLM = new MockLLMProvider(planJson);
    const planner = new Planner(plannerLLM, 'mock-model');

    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } = makeInfra('Done.');

    const events: AgentEvent[] = [];

    const loop = new AgentLoop(
      makeAgentConfig(true),
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
      undefined,
      undefined,
      undefined,
      planner,
    );

    await loop.run('Transfer funds', ctx, { onEvent: (e) => events.push(e) });

    const approvalEvent = events.find((e) => e.type === 'agent.plan.approval_required');
    expect(approvalEvent).toBeDefined();
  });

  it('skips planner when usePlanner is false even if planner is injected', async () => {
    const plannerLLM = new MockLLMProvider(makeValidPlanJson());
    const planner = new Planner(plannerLLM, 'mock-model');

    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } =
      makeInfra('No plan needed.');

    const loop = new AgentLoop(
      makeAgentConfig(false), // usePlanner: false
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
      undefined,
      undefined,
      undefined,
      planner,
    );

    const response = await loop.run('Simple query', ctx);

    expect(response.plan).toBeUndefined();
    // Planner LLM should NOT have been called.
    expect(plannerLLM.lastRequest).toBeNull();
  });

  it('runs normally without a planner when usePlanner is false', async () => {
    const { bus, toolRegistry, skillRegistry, tokens, memory, agentLLM } =
      makeInfra('Normal response.');

    const loop = new AgentLoop(
      makeAgentConfig(false),
      toolRegistry,
      skillRegistry,
      agentLLM,
      memory,
      bus,
      tokens,
    );

    const response = await loop.run('Hello', ctx);

    expect(response.content).toBe('Normal response.');
    expect(response.plan).toBeUndefined();
  });
});
