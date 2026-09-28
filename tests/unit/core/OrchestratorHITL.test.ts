/**
 * Comprehensive tests for the two-phase HITL suspend/resume flow.
 *
 * Covers:
 * - ApprovalService marking methods (markResuming / markResumeCompleted / markResumeFailed)
 * - ApprovalService.approve() status transitions (tool_completed vs completed)
 * - Concurrent double-approve guard (claimForExecution returns null → throws)
 * - Orchestrator.approve() full flow: suspend → approve → resume → AgentResponse
 * - SKIPPED placeholder wording (non-prescriptive, no "re-invoke" instruction)
 * - Tool executes, subsequent tool runs during resume (LLM re-invokes siblings)
 * - Resume triggers another suspension → suspended: true in returned response
 * - Rejection does not resume the loop
 * - Tool failure leaves status 'failed'
 * - Tool success + resume failure leaves status 'resume_failed'
 * - Orchestrator.retryResume() retries only the resume step (tool NOT re-executed)
 * - retryResume() throws for wrong statuses
 * - registerApprovalService() + approve() wiring
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { AccessDeniedError, ConfigError } from '../../../src/errors/index.js';
import { ApprovalService } from '../../../src/approval/ApprovalService.js';
import { InMemoryPendingStore } from '../../../src/approval/store/InMemoryPendingStore.js';
import { ApprovalNotifier } from '../../../src/approval/notification/ApprovalNotifier.js';
import { EventChannel } from '../../../src/approval/notification/EventChannel.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { ToolNotFoundError } from '../../../src/errors/index.js';
import type {
  AgentConfig,
  ApprovalTrigger,
  ExecutionContext,
  LLMRequest,
  LLMResponse,
  PendingAction,
  Tool,
  ToolResult,
  ProviderCapabilities,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLLMResponse(content = 'Done.', overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content,
    stopReason: 'end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 1,
    ...overrides,
  };
}

function makeToolCallResponse(
  toolName: string,
  input: Record<string, unknown> = {},
  toolCallId = 'tc-1',
): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: toolCallId, toolName, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 1,
  };
}

class MockLLMProvider extends LLMProvider {
  readonly name: string;
  readonly providerType = 'mock';
  private readonly responses: LLMResponse[];
  private index = 0;
  public callCount = 0;
  public requests: LLMRequest[] = [];

  constructor(name = 'mock', responses: LLMResponse[] = [makeLLMResponse()]) {
    super();
    this.name = name;
    this.responses = responses;
  }

  override async call(req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.requests.push(req);
    const response = this.responses[this.index % this.responses.length]!;
    this.index++;
    return response;
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

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    systemPrompt: 'You are a test agent.',
    skills: [],
    llmConfig: { provider: 'mock', model: 'mock-model' },
    memoryStrategy: { type: 'sliding_window', maxMessages: 20 },
    maxLoopIterations: 5,
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<ApprovalTrigger> = {}): ApprovalTrigger {
  return {
    id: 'trigger-1',
    name: 'Requires Approval',
    description: 'This action requires manager approval.',
    enabled: true,
    scope: { tools: ['transfer'] },
    conditions: [{ type: 'always' }],
    approvalConfig: {
      approverRoles: ['manager'],
      risk: 'high',
      timeoutMinutes: 60,
    },
    ...overrides,
  };
}

function makeTransferTool(execute?: () => Promise<ToolResult>): Tool {
  return {
    name: 'transfer',
    description: 'Transfers money',
    inputSchema: { type: 'object' },
    execute: execute ?? vi.fn().mockResolvedValue({ success: true, data: { txId: 'tx-1' } }),
  };
}

function makeNotifyTool(): Tool {
  return {
    name: 'notify',
    description: 'Sends a notification',
    inputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({ success: true, data: { sent: true } }),
  };
}

async function makeOrchestrator(): Promise<Orchestrator> {
  const config = ConfigLoader.from().get();
  return Orchestrator.fromConfig(config);
}

function makeApprovalService(
  store: InMemoryPendingStore,
  toolRegistry: ToolRegistry,
  bus: EventBus,
): ApprovalService {
  const notifier = new ApprovalNotifier([new EventChannel(bus)]);
  const toolExecutor = new ToolExecutor(toolRegistry, bus);
  return new ApprovalService(store, notifier, toolExecutor, bus, {});
}

function makeApproverIdentity() {
  return { tenantId: 'acme', userId: 'manager-1', roles: ['manager'] };
}

/** Full execution context of an authorized approver, for direct ApprovalService calls. */
function makeApproverContext(): ExecutionContext {
  return {
    ...makeApproverIdentity(),
    sessionId: 'sess-1',
    agentId: 'agent-1',
    requestId: 'req-approve',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalService marking methods
// ─────────────────────────────────────────────────────────────────────────────

describe('ApprovalService — marking methods', () => {
  let store: InMemoryPendingStore;
  let bus: EventBus;
  let svc: ApprovalService;

  function makeStoredAction(overrides: Partial<PendingAction> = {}): PendingAction {
    const now = new Date();
    return {
      id: 'action-1',
      requestId: 'req-1',
      sessionId: 'sess-1',
      tenantId: 'acme',
      requestedBy: 'user-1',
      agentId: 'agent-1',
      toolName: 'transfer',
      toolInput: {},
      description: 'Test action',
      reason: 'Test reason',
      risk: 'high',
      approverRoles: ['manager'],
      currentEscalationLevel: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      savedContext: { executionContext: {} as ExecutionContext, agentConfig: 'agent-1' },
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new InMemoryPendingStore();
    bus = new EventBus();
    const registry = new ToolRegistry();
    svc = makeApprovalService(store, registry, bus);
  });

  describe('markResuming()', () => {
    it('transitions tool_completed → resuming', async () => {
      await store.create(makeStoredAction({ status: 'tool_completed' }));
      await svc.markResuming('action-1');
      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('resuming');
    });

    it('transitions resume_failed → resuming', async () => {
      await store.create(makeStoredAction({ status: 'resume_failed' }));
      await svc.markResuming('action-1');
      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('resuming');
    });

    it('throws for status pending', async () => {
      await store.create(makeStoredAction({ status: 'pending' }));
      await expect(svc.markResuming('action-1')).rejects.toThrow(/cannot mark.*resuming/i);
    });

    it('throws for status executing', async () => {
      await store.create(makeStoredAction({ status: 'executing' }));
      await expect(svc.markResuming('action-1')).rejects.toThrow(/cannot mark.*resuming/i);
    });

    it('throws for non-existent action', async () => {
      await expect(svc.markResuming('no-such-id')).rejects.toThrow('not found');
    });
  });

  describe('markResumeCompleted()', () => {
    it('transitions resuming → completed', async () => {
      await store.create(makeStoredAction({ status: 'resuming' }));
      await svc.markResumeCompleted('action-1');
      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('completed');
    });

    it('emits approval.resume_completed event', async () => {
      await store.create(makeStoredAction({ status: 'resuming' }));
      const events: string[] = [];
      bus.on('approval.resume_completed', () => events.push('ok'));
      await svc.markResumeCompleted('action-1');
      expect(events).toHaveLength(1);
    });

    it('throws for status tool_completed', async () => {
      await store.create(makeStoredAction({ status: 'tool_completed' }));
      await expect(svc.markResumeCompleted('action-1')).rejects.toThrow(/cannot mark.*completed/i);
    });

    it('throws for non-existent action', async () => {
      await expect(svc.markResumeCompleted('ghost')).rejects.toThrow('not found');
    });
  });

  describe('markResumeFailed()', () => {
    it('transitions resuming → resume_failed', async () => {
      await store.create(makeStoredAction({ status: 'resuming' }));
      await svc.markResumeFailed('action-1', new Error('LLM down'));
      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('resume_failed');
    });

    it('emits approval.resume_failed event with error string', async () => {
      await store.create(makeStoredAction({ status: 'resuming' }));

      const events: any[] = [];
      bus.on('approval.resume_failed', (e) => events.push(e));
      await svc.markResumeFailed('action-1', new Error('provider failed'));
      expect(events).toHaveLength(1);
      expect(events[0]!.data.error).toContain('provider failed');
    });

    it('throws for status pending (not resuming)', async () => {
      await store.create(makeStoredAction({ status: 'pending' }));
      await expect(svc.markResumeFailed('action-1', 'err')).rejects.toThrow(
        /cannot mark.*resume_failed/i,
      );
    });

    it('throws for non-existent action', async () => {
      await expect(svc.markResumeFailed('ghost', 'err')).rejects.toThrow('not found');
    });
  });

  describe('approve() — status transitions', () => {
    it('sets status to tool_completed when savedContext has messagesSnapshot', async () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'transfer',
        description: 'transfers',
        inputSchema: { type: 'object' },
        execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
      });
      const service = makeApprovalService(store, registry, bus);

      const action = makeStoredAction({
        status: 'pending',
        savedContext: {
          executionContext: {} as ExecutionContext,
          agentConfig: 'agent-1',
          messagesSnapshot: [{ role: 'user', content: 'hello' }],
          toolCallId: 'tc-1',
          siblingCalls: [],
        },
      });
      await store.create(action);

      await service.approve('action-1', makeApproverContext());

      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('tool_completed');
    });

    it('sets status to completed when savedContext has no messagesSnapshot', async () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'transfer',
        description: 'transfers',
        inputSchema: { type: 'object' },
        execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
      });
      const service = makeApprovalService(store, registry, bus);

      await store.create(makeStoredAction({ status: 'pending' }));
      await service.approve('action-1', makeApproverContext());

      const updated = await store.getById('action-1');
      expect(updated!.status).toBe('completed');
    });

    it('throws when action is already executing (concurrent double-approve guard)', async () => {
      const registry = new ToolRegistry();
      svc = makeApprovalService(store, registry, bus);

      await store.create(makeStoredAction({ status: 'executing' }));

      await expect(svc.approve('action-1', makeApproverContext())).rejects.toThrow(
        /cannot be approved/,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator.approve() — full suspend/resume flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.approve() — suspend/resume', () => {
  let orch: Orchestrator;
  let store: InMemoryPendingStore;
  let bus: EventBus;
  let approvalSvc: ApprovalService;
  let transferTool: Tool;

  beforeEach(async () => {
    orch = await makeOrchestrator();
    store = new InMemoryPendingStore();
    bus = orch.events;

    transferTool = makeTransferTool();
    orch.registerTool(transferTool);

    const registry = new ToolRegistry();
    registry.register(transferTool);
    approvalSvc = makeApprovalService(store, registry, bus);
    approvalSvc.addTrigger(makeTrigger());
    orch.registerApprovalService(approvalSvc);
  });

  it('throws ConfigError when no ApprovalService is registered', async () => {
    const freshOrch = await makeOrchestrator();
    await expect(freshOrch.approve('any-id', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('throws ConfigError when action is not found', async () => {
    await expect(orch.approve('no-such-id', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('suspends the run when a tool requires approval', async () => {
    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', { amount: 5000 }, 'tc-1'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const response = await orch.chat('agent-1', 'Transfer 5000', {
      tenantId: 'acme',
      userId: 'user-1',
      roles: ['user'],
    });

    expect(response.suspended).toBe(true);
    expect(response.pendingActions).toHaveLength(1);
    expect(response.pendingActions![0]!.toolName).toBe('transfer');
  });

  it('executes the tool and resumes the loop on approve', async () => {
    const provider = new MockLLMProvider('mock', [
      // First call: tool call that gets suspended
      makeToolCallResponse('transfer', { amount: 5000 }, 'tc-1'),
      // Resume call: LLM sees the tool result and responds
      makeLLMResponse('Transfer completed successfully.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'Transfer 5000', {
      tenantId: 'acme',
      userId: 'user-1',
      roles: ['user'],
    });

    expect(suspended.suspended).toBe(true);
    const actionId = suspended.pendingActions![0]!.actionId;

    const resumed = await orch.approve(actionId, makeApproverIdentity());

    expect(resumed.suspended).not.toBe(true);
    expect(resumed.content).toBe('Transfer completed successfully.');
    expect(transferTool.execute).toHaveBeenCalledOnce();
  });

  it('action status is completed after successful approve + resume', async () => {
    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', {}, 'tc-1'),
      makeLLMResponse('Done.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    await orch.approve(actionId, makeApproverIdentity());

    const action = await store.getById(actionId);
    expect(action!.status).toBe('completed');
  });

  it('sibling calls get SKIPPED (not DEFERRED) placeholders on resume', async () => {
    const notifyTool = makeNotifyTool();
    orch.registerTool(notifyTool);

    // LLM requests both transfer AND notify in the same turn
    const provider = new MockLLMProvider('mock', [
      {
        content: '',
        toolCalls: [
          { id: 'tc-1', toolName: 'transfer', input: { amount: 1000 } },
          { id: 'tc-2', toolName: 'notify', input: { msg: 'hi' } },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'mock-model',
        provider: 'mock',
        latencyMs: 1,
      },
      makeLLMResponse('Both done.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'do both', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    await orch.approve(actionId, makeApproverIdentity());

    // The resume LLM call should have received a SKIPPED placeholder for 'notify'
    // (second call = the resume call)
    const resumeRequest = provider.requests[1]!;
    const notifyResult = resumeRequest.messages.find(
      (m) => m.role === 'tool' && m.toolCallId === 'tc-2',
    );
    expect(notifyResult).toBeDefined();
    const parsed = JSON.parse(notifyResult!.content as string);
    expect(parsed.status).toBe('SKIPPED');
    expect(parsed.reason).not.toMatch(/vuelve a invocar/i);
    expect(parsed.reason).not.toMatch(/por favor/i);
  });

  it('rejection does not resume the loop — returns minimal response', async () => {
    const provider = new MockLLMProvider('mock', [makeToolCallResponse('transfer', {}, 'tc-1')]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    const approverCtx: ExecutionContext = {
      tenantId: 'acme',
      userId: 'manager-1',
      roles: ['manager'],
      sessionId: 'sess',
      agentId: 'agent-1',
      requestId: 'r',
    };
    await approvalSvc.reject(actionId, approverCtx, { comment: 'Too risky' });

    // Tool should NOT have been executed
    expect(transferTool.execute).not.toHaveBeenCalled();

    const action = await store.getById(actionId);
    expect(action!.status).toBe('rejected');
    // Provider was only called once (the original suspension call)
    expect(provider.callCount).toBe(1);
  });

  it('tool NOT in approval registry throws ToolNotFoundError and leaves status failed', async () => {
    // The approval service is created with an EMPTY registry — 'transfer' is not in it.
    // When approve() is called, ToolExecutor throws ToolNotFoundError.
    const emptyRegistry = new ToolRegistry();
    const freshSvc = makeApprovalService(store, emptyRegistry, bus);
    freshSvc.addTrigger(makeTrigger());
    orch.registerApprovalService(freshSvc);

    const provider = new MockLLMProvider('mock', [makeToolCallResponse('transfer', {}, 'tc-1')]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    await expect(orch.approve(actionId, makeApproverIdentity())).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );

    const action = await store.getById(actionId);
    expect(action!.status).toBe('failed');
    // Only 1 LLM call (the original suspension) — no resume
    expect(provider.callCount).toBe(1);
  });

  it('tool returning success:false resumes the loop (LLM sees the failure result)', async () => {
    // ToolExecutor wraps all tool-level errors into { success: false }.
    // The loop DOES resume so the LLM can react to the failure.
    const failingTool: Tool = {
      name: 'transfer',
      description: 'transfers',
      inputSchema: { type: 'object' },
      execute: vi.fn().mockResolvedValue({ success: false, error: 'Insufficient funds' }),
    };
    orch.registerTool(failingTool);

    const registry = new ToolRegistry();
    registry.register(failingTool);
    const freshSvc = makeApprovalService(store, registry, bus);
    freshSvc.addTrigger(makeTrigger());
    orch.registerApprovalService(freshSvc);

    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', {}, 'tc-1'),
      makeLLMResponse('Transfer failed: insufficient funds.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    const resumed = await orch.approve(actionId, makeApproverIdentity());

    // Loop resumes, LLM responds with the failure context
    expect(resumed.content).toBe('Transfer failed: insufficient funds.');
    expect(resumed.suspended).not.toBe(true);
    // Final status is completed (resume succeeded, even if the tool reported failure)
    const action = await store.getById(actionId);
    expect(action!.status).toBe('completed');
  });

  it('resume failure leaves status resume_failed, action can be retried', async () => {
    // LLM throws on the second call (the resume)
    let callCount = 0;
    class FlakyProvider extends LLMProvider {
      override readonly name = 'mock';
      readonly providerType = 'mock';
      override async call(_req: LLMRequest): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) return makeToolCallResponse('transfer', {}, 'tc-1');
        throw new Error('LLM unavailable');
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

    orch.registerProvider(new FlakyProvider());
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    await expect(orch.approve(actionId, makeApproverIdentity())).rejects.toThrow('LLM unavailable');

    const action = await store.getById(actionId);
    expect(action!.status).toBe('resume_failed');
    // Tool WAS executed (Phase 1 succeeded)
    expect(transferTool.execute).toHaveBeenCalledOnce();
  });

  it('concurrent double-approve: second call throws', async () => {
    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', {}, 'tc-1'),
      makeLLMResponse('First approve done.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    // First approve succeeds; manually force status to 'executing' to simulate
    // a concurrent in-flight approve without introducing race conditions in unit tests.
    await store.update({ ...(await store.getById(actionId))!, status: 'executing' });

    await expect(orch.approve(actionId, makeApproverIdentity())).rejects.toThrow(
      /cannot be approved/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator.retryResume()
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.retryResume()', () => {
  let orch: Orchestrator;
  let store: InMemoryPendingStore;
  let bus: EventBus;
  let approvalSvc: ApprovalService;
  let transferTool: Tool;

  beforeEach(async () => {
    orch = await makeOrchestrator();
    store = new InMemoryPendingStore();
    bus = orch.events;

    transferTool = makeTransferTool();
    orch.registerTool(transferTool);

    const registry = new ToolRegistry();
    registry.register(transferTool);
    approvalSvc = makeApprovalService(store, registry, bus);
    approvalSvc.addTrigger(makeTrigger());
    orch.registerApprovalService(approvalSvc);
  });

  it('throws ConfigError when no ApprovalService registered', async () => {
    const fresh = await makeOrchestrator();
    await expect(fresh.retryResume('x', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('throws ConfigError when action not found', async () => {
    await expect(orch.retryResume('no-such-id', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('throws ConfigError for status pending (not retryable)', async () => {
    const provider = new MockLLMProvider('mock', [makeToolCallResponse('transfer', {})]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    await expect(orch.retryResume(actionId, makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('throws ConfigError for status completed (not retryable)', async () => {
    const now = new Date();
    const action: PendingAction = {
      id: 'action-done',
      requestId: 'r',
      sessionId: 's',
      tenantId: 'acme',
      requestedBy: 'u',
      agentId: 'agent-1',
      toolName: 'transfer',
      toolInput: {},
      description: 'done',
      reason: 'done',
      risk: 'high',
      approverRoles: ['manager'],
      currentEscalationLevel: 0,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      savedContext: { executionContext: {} as ExecutionContext, agentConfig: 'agent-1' },
    };
    await store.create(action);

    await expect(orch.retryResume('action-done', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('retries the resume without re-executing the tool (resume_failed path)', async () => {
    // Phase 1: Suspend the run
    let callCount = 0;
    class FlakyProvider extends LLMProvider {
      override readonly name = 'mock';
      readonly providerType = 'mock';
      override async call(_req: LLMRequest): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) return makeToolCallResponse('transfer', {}, 'tc-1');
        if (callCount === 2) throw new Error('LLM down temporarily');
        // Third call (retry): succeeds
        return makeLLMResponse('Retry succeeded.');
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

    orch.registerProvider(new FlakyProvider());
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    // A caller without an approver role cannot approve, and nothing runs.
    await expect(
      orch.approve(actionId, { tenantId: 'acme', userId: 'u', roles: [] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(transferTool.execute).not.toHaveBeenCalled();

    // First approve — LLM throws on resume → resume_failed
    await expect(orch.approve(actionId, makeApproverIdentity())).rejects.toThrow(
      'LLM down temporarily',
    );

    const afterFirstApprove = await store.getById(actionId);
    expect(afterFirstApprove!.status).toBe('resume_failed');
    expect(transferTool.execute).toHaveBeenCalledOnce(); // tool ran once in Phase 1

    // retryResume from another tenant is refused.
    await expect(
      orch.retryResume(actionId, { tenantId: 'other', userId: 'ops', roles: ['manager'] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // retryResume — tool must NOT run again
    const retryResponse = await orch.retryResume(actionId, makeApproverIdentity());

    expect(retryResponse.content).toBe('Retry succeeded.');
    expect(transferTool.execute).toHaveBeenCalledOnce(); // still only once

    const finalAction = await store.getById(actionId);
    expect(finalAction!.status).toBe('completed');
  });

  it('retries from tool_completed status', async () => {
    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', {}, 'tc-1'),
      makeLLMResponse('Retried successfully.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    const actionId = suspended.pendingActions![0]!.actionId;

    // Simulate Phase 1 having completed (tool ran, status = tool_completed)
    // by running approve and catching the resume (we'll force tool_completed manually)
    await store.update({ ...(await store.getById(actionId))!, status: 'tool_completed' });

    // Manually set resolution so retryResume can pass toolResult
    const action = await store.getById(actionId);
    await store.update({
      ...action!,
      resolution: {
        resolvedBy: 'manager',
        resolvedAt: new Date(),
        decision: 'approve',
        toolResult: { success: true, data: { txId: 'tx-123' } },
      },
    });

    const result = await orch.retryResume(actionId, makeApproverIdentity());
    expect(result.content).toBe('Retried successfully.');
    // Tool should NOT have been called again
    expect(transferTool.execute).not.toHaveBeenCalled();
  });

  it('throws ConfigError when action has no resume checkpoint', async () => {
    const now = new Date();
    const action: PendingAction = {
      id: 'no-checkpoint',
      requestId: 'r',
      sessionId: 's',
      tenantId: 'acme',
      requestedBy: 'u',
      agentId: 'agent-1',
      toolName: 'transfer',
      toolInput: {},
      description: 'no checkpoint',
      reason: 'test',
      risk: 'low',
      approverRoles: ['manager'],
      currentEscalationLevel: 0,
      status: 'resume_failed',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      // No messagesSnapshot
      savedContext: { executionContext: {} as ExecutionContext, agentConfig: 'agent-1' },
    };
    await store.create(action);

    await expect(orch.retryResume('no-checkpoint', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator.registerApprovalService() wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('registerApprovalService() wiring', () => {
  it('approve() throws ConfigError when registerApprovalService was not called', async () => {
    const orch = await makeOrchestrator();
    await expect(orch.approve('any-id', makeApproverIdentity())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('approve() works after registerApprovalService is called', async () => {
    const orch = await makeOrchestrator();

    const transferTool = makeTransferTool();
    orch.registerTool(transferTool);

    const registry = new ToolRegistry();
    registry.register(transferTool);
    const store = new InMemoryPendingStore();
    const svc = makeApprovalService(store, registry, orch.events);
    svc.addTrigger(makeTrigger());
    orch.registerApprovalService(svc);

    const provider = new MockLLMProvider('mock', [
      makeToolCallResponse('transfer', {}, 'tc-1'),
      makeLLMResponse('Wired up.'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const suspended = await orch.chat('agent-1', 'transfer', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    expect(suspended.suspended).toBe(true);

    const resumed = await orch.approve(
      suspended.pendingActions![0]!.actionId,
      makeApproverIdentity(),
    );
    expect(resumed.content).toBe('Wired up.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resume triggers another suspension
// ─────────────────────────────────────────────────────────────────────────────

describe('resume that triggers another suspension', () => {
  it('returns suspended: true when the resumed loop suspends again', async () => {
    const orch = await makeOrchestrator();

    const transferTool = makeTransferTool();
    const criticalTool: Tool = {
      name: 'criticalOp',
      description: 'Another critical operation',
      inputSchema: { type: 'object' },
      execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    orch.registerTool(transferTool);
    orch.registerTool(criticalTool);

    const registry = new ToolRegistry();
    registry.register(transferTool);
    registry.register(criticalTool);
    const store = new InMemoryPendingStore();
    const svc = makeApprovalService(store, registry, orch.events);
    // Both tools require approval
    svc.addTrigger(makeTrigger({ scope: { tools: ['transfer', 'criticalOp'] } }));
    orch.registerApprovalService(svc);

    const provider = new MockLLMProvider('mock', [
      // First call: request transfer → suspends
      makeToolCallResponse('transfer', { amount: 100 }, 'tc-1'),
      // Resume call: after transfer approved, LLM now requests criticalOp → suspends again
      makeToolCallResponse('criticalOp', {}, 'tc-2'),
    ]);
    orch.registerProvider(provider);
    orch.registerAgent(makeAgent());

    const firstSuspension = await orch.chat('agent-1', 'do transfer then criticalOp', {
      tenantId: 'acme',
      userId: 'u',
      roles: [],
    });
    expect(firstSuspension.suspended).toBe(true);

    const firstActionId = firstSuspension.pendingActions![0]!.actionId;
    const secondSuspension = await orch.approve(firstActionId, makeApproverIdentity());

    // The resumed loop hit another approval gate and suspended again
    expect(secondSuspension.suspended).toBe(true);
    expect(secondSuspension.pendingActions![0]!.toolName).toBe('criticalOp');
  });
});
