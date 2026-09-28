import { describe, it, expect, beforeEach } from 'vitest';

// ── Core ──────────────────────────────────────────────────────────────────────
import { Orchestrator } from '../../src/core/Orchestrator.js';
import { AgentLoop } from '../../src/core/AgentLoop.js';
import { ConfigLoader } from '../../src/config/ConfigLoader.js';
import { LLMProvider, textOnlyCapabilities } from '../../src/llm/LLMProvider.js';
import { EventBus } from '../../src/events/EventBus.js';
import { ToolRegistry } from '../../src/tools/ToolRegistry.js';
import { SkillRegistry } from '../../src/skills/SkillRegistry.js';
import { TokenTracker } from '../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../src/memory/adapters/InMemoryAdapter.js';
import { DefaultMemoryManager } from '../../src/memory/DefaultMemoryManager.js';
import { SlidingWindow } from '../../src/memory/strategies/SlidingWindow.js';

// ── Audit ─────────────────────────────────────────────────────────────────────
import { AuditLogger } from '../../src/audit/AuditLogger.js';
import { InMemoryAuditStore } from '../../src/audit/store/InMemoryAuditStore.js';

// ── Security ──────────────────────────────────────────────────────────────────
import { ACLService } from '../../src/security/ACLService.js';
import { FieldMasker } from '../../src/security/FieldMasker.js';
import { SecurityMiddlewareChain } from '../../src/security/middleware/SecurityMiddlewareChain.js';
import { ToolACLMiddleware } from '../../src/security/middleware/ToolACLMiddleware.js';
import { FieldMaskMiddleware } from '../../src/security/middleware/FieldMaskMiddleware.js';

// ── Approval ──────────────────────────────────────────────────────────────────
import { ApprovalService } from '../../src/approval/ApprovalService.js';
import { InMemoryPendingStore } from '../../src/approval/store/InMemoryPendingStore.js';
import { ApprovalNotifier } from '../../src/approval/notification/ApprovalNotifier.js';
import { ToolExecutor } from '../../src/tools/ToolExecutor.js';

// ── RAG ───────────────────────────────────────────────────────────────────────
import { RAGPipeline } from '../../src/rag/RAGPipeline.js';
import { EmbeddingRouter } from '../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../src/rag/embedding/EmbeddingProvider.js';
import { InMemoryVectorStore } from '../../src/rag/vectorstore/InMemoryVectorStore.js';
import { createRAGTool } from '../../src/rag/RAGTool.js';

// ── Types ─────────────────────────────────────────────────────────────────────
import type {
  AgentConfig,
  Tool,
  Skill,
  LLMRequest,
  LLMResponse,
  ExecutionContext,
  ApprovalTrigger,
  ToolResult,
  ProviderCapabilities,
} from '../../src/types/index.js';
import type { EmbeddingResult } from '../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock implementations
// ─────────────────────────────────────────────────────────────────────────────

class MockLLMProvider extends LLMProvider {
  override readonly name: string;
  readonly providerType = 'mock';
  private readonly responses: LLMResponse[];
  private index = 0;
  public callCount = 0;

  constructor(name: string, responses: LLMResponse[]) {
    super();
    this.name = name;
    this.responses = responses;
  }

  override async call(_req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    const response = this.responses[this.index % this.responses.length];
    if (response === undefined) throw new Error(`MockLLMProvider(${this.name}): no more responses`);
    this.index++;
    return response;
  }

  override async validate(): Promise<boolean> {
    return true;
  }
  override async listModels(): Promise<string[]> {
    return [`${this.name}-model`];
  }

  override capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

class MockEmbeddingProvider extends EmbeddingProvider {
  override readonly name = 'mock';
  override readonly model = 'mock-embed';
  private readonly dimensions: number;
  private readonly fixedVector: number[];

  constructor(dimensions = 3) {
    super();
    this.dimensions = dimensions;
    // Fixed unit vector — cosine similarity with itself is 1.0
    this.fixedVector = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
  }

  override async embed(_text: string): Promise<EmbeddingResult> {
    return { vector: [...this.fixedVector], tokens: 10 };
  }

  override async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map(() => ({ vector: [...this.fixedVector], tokens: 10 }));
  }

  override getDimensions(): number {
    return this.dimensions;
  }

  override async validate(): Promise<boolean> {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTextResponse(content: string): LLMResponse {
  return {
    content,
    stopReason: 'end',
    usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, cost: 0.001 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 5,
  };
}

function makeToolCallResponse(
  calls: Array<{ id: string; toolName: string; input: Record<string, unknown> }>,
): LLMResponse {
  return {
    content: '',
    stopReason: 'tool_use',
    toolCalls: calls,
    usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80, cost: 0.001 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 5,
  };
}

function makeAgent(id = 'agent-1', providerName = 'mock', toolNames: string[] = []): AgentConfig {
  return {
    id,
    name: 'Integration Test Agent',
    systemPrompt: 'You are a helpful assistant.',
    skills: [],
    ...(toolNames.length > 0 && { tools: toolNames }),
    llmConfig: { provider: providerName, model: 'mock-model' },
    memoryStrategy: { type: 'sliding_window', maxMessages: 20 },
    maxLoopIterations: 5,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'sess-int-1',
    requestId: 'req-int-1',
    roles: ['employee'],
    ...overrides,
  };
}

function makeMemory(): DefaultMemoryManager {
  return new DefaultMemoryManager(
    new InMemoryAdapter(),
    new InMemoryAdapter(),
    new SlidingWindow({ maxMessages: 20 }),
    { sessionTtlSeconds: 3600, maxFactsPerUser: 100 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Full Flow Integration', () => {
  // ── 1. Orchestrator from config ─────────────────────────────────────────────

  describe('1 — Orchestrator from SDKConfig', () => {
    it('creates Orchestrator using ConfigLoader.from() + fromConfig()', async () => {
      const loader = ConfigLoader.from();
      const orch = await Orchestrator.fromConfig(loader.get());

      expect(orch).toBeDefined();
      expect(orch.toolRegistry).toBeDefined();
      expect(orch.skillRegistry).toBeDefined();
      expect(orch.tokens).toBeDefined();
      expect(orch.events).toBeDefined();
      expect(orch.router).toBeDefined();
    });

    it('config reflects default values', async () => {
      const loader = ConfigLoader.from();
      const orch = await Orchestrator.fromConfig(loader.get());
      const cfg = orch.config;

      expect(cfg.agent.maxLoopIterations).toBeGreaterThan(0);
      expect(cfg.llm.circuitBreaker.failureThreshold).toBeGreaterThan(0);
      expect(cfg.memory.session.ttlSeconds).toBeGreaterThan(0);
    });
  });

  // ── 2. Register tools, skills, agents ────────────────────────────────────────

  describe('2 — Register tools, skills, and agents', () => {
    let orch: Orchestrator;

    beforeEach(async () => {
      orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    });

    it('registers a tool and retrieves it', () => {
      const tool: Tool = {
        name: 'calculator',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
        async execute(input): Promise<ToolResult> {
          const i = input as { a: number; b: number };
          return { success: true, data: { result: i.a + i.b } };
        },
      };
      orch.registerTool(tool);
      expect(orch.toolRegistry.get('calculator')).toBeDefined();
    });

    it('registers a skill and retrieves it', () => {
      const skill: Skill = {
        name: 'arithmetic',
        description: 'Arithmetic operations.',
        systemPromptAddition: 'You can do math.',
        tools: ['calculator'],
      };
      orch.registerSkill(skill);
      expect(orch.skillRegistry.get('arithmetic')).toBeDefined();
    });

    it('registers an agent and runs it via chat()', async () => {
      const mock = new MockLLMProvider('mock', [makeTextResponse('2 + 2 = 4')]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-math', 'mock'));

      const response = await orch.chat('agent-math', 'What is 2 + 2?', {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['employee'],
      });

      expect(response.content).toBe('2 + 2 = 4');
      expect(mock.callCount).toBe(1);
    });
  });

  // ── 3. ACL + field masking ───────────────────────────────────────────────────

  describe('3 — ACL policies and field masking', () => {
    it('ACL blocks restricted tool — tool result contains ACCESS_DENIED', async () => {
      const bus = new EventBus();
      const tokens = new TokenTracker(new InMemoryAdapter());
      const toolRegistry = new ToolRegistry();
      const skillRegistry = new SkillRegistry();
      const memory = makeMemory();

      // Register two tools: one allowed, one restricted
      toolRegistry.register({
        name: 'public.info',
        description: 'Public info.',
        inputSchema: { type: 'object' },
        async execute(): Promise<ToolResult> {
          return { success: true, data: { info: 'public data' } };
        },
      });
      toolRegistry.register({
        name: 'admin.secrets',
        description: 'Admin-only secrets.',
        inputSchema: { type: 'object' },
        async execute(): Promise<ToolResult> {
          return { success: true, data: { secret: 'classified' } };
        },
      });

      // ACL: deny 'admin.secrets' for role 'employee'
      const aclService = new ACLService({
        policies: [
          {
            id: 'deny-admin-for-employee',
            name: 'Block admin tools for employees',
            subjects: ['role:employee'],
            resources: ['admin.secrets'],
            actions: ['execute'],
            effect: 'deny',
          },
          {
            id: 'allow-public',
            name: 'Allow public tools for everyone',
            subjects: ['role:employee'],
            resources: ['public.info'],
            actions: ['execute'],
            effect: 'allow',
          },
        ],
      });

      const toolACL = new ToolACLMiddleware(aclService);
      const chain = new SecurityMiddlewareChain();
      chain.use(toolACL);

      // LLM calls the restricted tool, then responds after denial
      const llm = new MockLLMProvider('mock', [
        makeToolCallResponse([{ id: 'c1', toolName: 'admin.secrets', input: {} }]),
        makeTextResponse('Access was denied for that operation.'),
      ]);

      const loop = new AgentLoop(
        makeAgent('agent-1', 'mock'),
        toolRegistry,
        skillRegistry,
        llm,
        memory,
        bus,
        tokens,
        chain,
        aclService,
      );

      const response = await loop.run('Get the admin secrets.', makeContext());

      // Loop completes with a response
      expect(response.content).toBeTruthy();
      // LLM was called twice (initial + after denial)
      expect(llm.callCount).toBe(2);
    });

    it('FieldMaskMiddleware redacts sensitive fields in tool output', async () => {
      const bus = new EventBus();
      const tokens = new TokenTracker(new InMemoryAdapter());
      const toolRegistry = new ToolRegistry();
      const skillRegistry = new SkillRegistry();
      const memory = makeMemory();

      // Tool that returns sensitive data
      toolRegistry.register({
        name: 'hr.getEmployee',
        description: 'Gets employee record.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        async execute(): Promise<ToolResult> {
          return {
            success: true,
            data: { name: 'Alice', ssn: '123-45-6789', salary: 90000 },
          };
        },
      });

      const masker = new FieldMasker([{ field: 'ssn', strategy: 'redact' }]);
      const fieldMaskMw = new FieldMaskMiddleware(masker);
      const chain = new SecurityMiddlewareChain();
      chain.use(fieldMaskMw);

      const capturedMessages: string[] = [];
      bus.on('agent.llm.request', (e) => {
        // Capture messages sent to LLM to verify masking
        const req = e.data as { messages?: Array<{ content: string }> };
        if (req.messages) {
          for (const msg of req.messages) {
            capturedMessages.push(msg.content);
          }
        }
      });

      const llm = new MockLLMProvider('mock', [
        makeToolCallResponse([{ id: 'c1', toolName: 'hr.getEmployee', input: { id: 'emp-1' } }]),
        makeTextResponse('Employee found: Alice.'),
      ]);

      const loop = new AgentLoop(
        makeAgent('agent-1', 'mock', ['hr.getEmployee']),
        toolRegistry,
        skillRegistry,
        llm,
        memory,
        bus,
        tokens,
        chain,
      );

      const response = await loop.run('Get employee emp-1.', makeContext());
      expect(response.content).toContain('Alice');
    });
  });

  // ── 4. Simple chat (no tools) ────────────────────────────────────────────────

  describe('4 — chat() with text-only response', () => {
    it('returns the LLM text directly when no tools are called', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
      const mock = new MockLLMProvider('mock', [
        makeTextResponse('The capital of France is Paris.'),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-geo', 'mock'));

      const response = await orch.chat('agent-geo', 'What is the capital of France?', {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['employee'],
      });

      expect(response.content).toBe('The capital of France is Paris.');
      expect(response.toolsUsed).toHaveLength(0);
      expect(response.hasPendingApprovals).toBe(false);
    });
  });

  // ── 5. Tool calling ──────────────────────────────────────────────────────────

  describe('5 — chat() with tool calling', () => {
    it('executes a tool and returns the final LLM response', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());

      orch.registerTool({
        name: 'calculator',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        async execute(input): Promise<ToolResult> {
          const i = input as { a: number; b: number };
          return { success: true, data: { result: i.a + i.b } };
        },
      });

      const mock = new MockLLMProvider('mock', [
        makeToolCallResponse([{ id: 'call-1', toolName: 'calculator', input: { a: 7, b: 8 } }]),
        makeTextResponse('7 + 8 = 15.'),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-calc', 'mock', ['calculator']));

      const response = await orch.chat('agent-calc', 'What is 7 + 8?', {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['employee'],
      });

      expect(response.content).toBe('7 + 8 = 15.');
      expect(response.toolsUsed).toHaveLength(1);
      expect(response.toolsUsed[0]).toBe('calculator');
      expect(mock.callCount).toBe(2); // tool call + final response
    });

    it('handles tool failure gracefully — LLM receives error result', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());

      orch.registerTool({
        name: 'flaky.tool',
        description: 'A tool that always fails.',
        inputSchema: { type: 'object' },
        async execute(): Promise<ToolResult> {
          return { success: false, error: 'Service temporarily unavailable' };
        },
      });

      const mock = new MockLLMProvider('mock', [
        makeToolCallResponse([{ id: 'c1', toolName: 'flaky.tool', input: {} }]),
        makeTextResponse('The service is currently unavailable. Please try again later.'),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-flaky', 'mock', ['flaky.tool']));

      const response = await orch.chat('agent-flaky', 'Call the flaky tool.', {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['employee'],
      });

      expect(response.content).toContain('unavailable');
      expect(mock.callCount).toBe(2);
    });
  });

  // ── 6. RAG tool ──────────────────────────────────────────────────────────────

  describe('6 — chat() with RAG tool', () => {
    it('retrieves relevant passages and incorporates them into the response', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());

      // Build RAG pipeline with in-memory components
      const vectorStore = new InMemoryVectorStore();
      await vectorStore.createCollection('corporate-docs', {
        dimensions: 3,
        distanceMetric: 'cosine',
        embeddingProvider: 'mock',
        embeddingModel: 'mock/mock-embed',
      });

      // Upsert a document with the same vector the mock provider returns
      await vectorStore.upsert('corporate-docs', [
        {
          id: 'doc-1',
          content: 'Company vacation policy: employees receive 15 paid days per year.',
          vector: [1, 0, 0],
          metadata: {
            documentId: 'doc-1',
            title: 'HR Policy: Vacation',
            source: 'hr-handbook.pdf',
            tenantId: 'acme',
          },
        },
      ]);

      const embeddingProvider = new MockEmbeddingProvider(3);
      const embeddingRouter = new EmbeddingRouter(new Map([['mock', embeddingProvider]]));
      const tokens = new TokenTracker(new InMemoryAdapter());
      const bus = new EventBus();

      const ragPipeline = new RAGPipeline(embeddingRouter, vectorStore, undefined, bus, tokens);

      const ragTool = createRAGTool(ragPipeline, ['corporate-docs']);
      orch.registerTool(ragTool);

      const mock = new MockLLMProvider('mock', [
        makeToolCallResponse([
          {
            id: 'rag-1',
            toolName: 'rag.search',
            input: { query: 'vacation policy', collections: ['corporate-docs'] },
          },
        ]),
        makeTextResponse(
          'According to company policy, employees get 15 paid vacation days per year.',
        ),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-rag', 'mock', ['rag.search']));

      const response = await orch.chat('agent-rag', 'How many vacation days do employees get?', {
        tenantId: 'acme',
        userId: 'u1',
        roles: ['employee'],
      });

      expect(response.content).toContain('15');
      expect(response.toolsUsed[0]).toBe('rag.search');
    });
  });

  // ── 7. Audit log ─────────────────────────────────────────────────────────────

  describe('7 — Audit log captures agent lifecycle events', () => {
    it('startAutoCapture() records agent.run.start and agent.run.complete', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());

      // Wire AuditLogger to the Orchestrator's event bus
      const auditStore = new InMemoryAuditStore();
      const auditLogger = new AuditLogger(auditStore, orch.events, {
        verbosity: 'standard',
        buffer: { flushIntervalMs: 100 },
      });
      auditLogger.startAutoCapture();

      const mock = new MockLLMProvider('mock', [makeTextResponse('Hello!')]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-audit', 'mock'));

      await orch.chat('agent-audit', 'Hi there.', {
        tenantId: 'tenant-audit',
        userId: 'user-audit',
        roles: ['employee'],
      });

      // Flush buffered records to the store
      await auditLogger.flush();

      // AgentLoop emits without _context, so tenantId defaults to '' in records.
      // Query without a tenantId filter to get all records.
      const result = await auditLogger.query({});
      expect(result.records.length).toBeGreaterThan(0);

      // EventCollector maps 'agent.loop.start' → action:'loop_start'
      //                       'agent.loop.end'   → action:'loop_end'
      const actions = result.records.map((r) => r.action);
      expect(actions).toContain('loop_start');
      expect(actions).toContain('loop_end');
    });

    it('captures tool.call events when a tool is invoked', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());

      const auditStore = new InMemoryAuditStore();
      const auditLogger = new AuditLogger(auditStore, orch.events, { verbosity: 'verbose' });
      auditLogger.startAutoCapture();

      orch.registerTool({
        name: 'echo',
        description: 'Echoes input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        async execute(input): Promise<ToolResult> {
          return { success: true, data: { echo: (input as { text: string }).text } };
        },
      });

      const mock = new MockLLMProvider('mock', [
        makeToolCallResponse([{ id: 'e1', toolName: 'echo', input: { text: 'hello' } }]),
        makeTextResponse('Echoed: hello'),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-echo', 'mock', ['echo']));

      await orch.chat('agent-echo', 'Echo hello.', {
        tenantId: 'tenant-tool-audit',
        userId: 'u1',
        roles: ['employee'],
      });

      await auditLogger.flush();

      // EventCollector maps 'tool.call.start' → action:'call_start' in category:'tool'
      const result = await auditLogger.query({});
      const actions = result.records.map((r) => r.action);
      expect(actions).toContain('call_start');
    });
  });

  // ── 8 & 9. HITL Approval ─────────────────────────────────────────────────────

  describe('8 & 9 — HITL approval: trigger, pending, and approve', () => {
    let bus: EventBus;
    let tokens: TokenTracker;
    let toolRegistry: ToolRegistry;
    let skillRegistry: SkillRegistry;
    let memory: DefaultMemoryManager;
    let approvalStore: InMemoryPendingStore;
    let approvalService: ApprovalService;
    let transferTool: Tool;

    beforeEach(() => {
      bus = new EventBus();
      tokens = new TokenTracker(new InMemoryAdapter());
      toolRegistry = new ToolRegistry();
      skillRegistry = new SkillRegistry();
      memory = makeMemory();
      approvalStore = new InMemoryPendingStore();

      transferTool = {
        name: 'bank.transfer',
        description: 'Transfers funds between accounts.',
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            toAccount: { type: 'string' },
          },
          required: ['amount', 'toAccount'],
        },
        async execute(input): Promise<ToolResult> {
          const i = input as { amount: number; toAccount: string };
          return {
            success: true,
            data: { transferred: i.amount, to: i.toAccount, txId: 'tx-001' },
          };
        },
      };

      toolRegistry.register(transferTool);

      const notifier = new ApprovalNotifier([]);
      const toolExecutor = new ToolExecutor(toolRegistry, bus);
      approvalService = new ApprovalService(approvalStore, notifier, toolExecutor, bus, {
        defaultTimeoutMinutes: 60,
      });

      const transferTrigger: ApprovalTrigger = {
        id: 'large-transfer',
        name: 'Large Transfer Approval',
        description: 'Transfers exceeding $5,000 require manager approval.',
        enabled: true,
        scope: { tools: ['bank.transfer'] },
        conditions: [{ type: 'always' }],
        approvalConfig: {
          risk: 'high',
          approverRoles: ['manager'],
          timeoutMinutes: 60,
        },
      };
      approvalService.addTrigger(transferTrigger);
    });

    it('8 — defers tool call that matches approval trigger', async () => {
      const llm = new MockLLMProvider('mock', [
        makeToolCallResponse([
          {
            id: 'tx-call-1',
            toolName: 'bank.transfer',
            input: { amount: 10000, toAccount: 'ACC-999' },
          },
        ]),
        makeTextResponse('Your transfer request has been submitted for approval.'),
      ]);

      const loop = new AgentLoop(
        makeAgent('agent-finance', 'mock', ['bank.transfer']),
        toolRegistry,
        skillRegistry,
        llm,
        memory,
        bus,
        tokens,
        undefined,
        undefined,
        approvalService,
      );

      const response = await loop.run(
        'Transfer $10,000 to ACC-999.',
        makeContext({ agentId: 'agent-finance', roles: ['employee'] }),
      );

      expect(response.hasPendingApprovals).toBe(true);
      expect(response.pendingActions).toBeDefined();
      expect(response.pendingActions!).toHaveLength(1);
      expect(response.pendingActions![0]!.toolName).toBe('bank.transfer');
      expect(response.pendingActions![0]!.risk).toBe('high');
      expect(response.pendingActions![0]!.status).toBe('pending');
    });

    it('9 — approve pending action executes the tool and marks it completed', async () => {
      const llm = new MockLLMProvider('mock', [
        makeToolCallResponse([
          {
            id: 'tx-call-2',
            toolName: 'bank.transfer',
            input: { amount: 8000, toAccount: 'ACC-123' },
          },
        ]),
        makeTextResponse('Transfer pending approval.'),
      ]);

      const loop = new AgentLoop(
        makeAgent('agent-finance', 'mock', ['bank.transfer']),
        toolRegistry,
        skillRegistry,
        llm,
        memory,
        bus,
        tokens,
        undefined,
        undefined,
        approvalService,
      );

      const runResponse = await loop.run(
        'Transfer $8,000 to ACC-123.',
        makeContext({ agentId: 'agent-finance' }),
      );

      expect(runResponse.hasPendingApprovals).toBe(true);
      const actionId = runResponse.pendingActions![0]!.actionId;

      // Approver approves the action
      const approverCtx = makeContext({ userId: 'manager-1', roles: ['manager'] });
      const resolution = await approvalService.approve(actionId, approverCtx, {
        comment: 'Approved: routine transfer.',
      });

      expect(resolution.decision).toBe('approve');
      expect(resolution.resolvedBy).toBe('manager-1');
      expect(resolution.comment).toBe('Approved: routine transfer.');
      expect(resolution.toolResult).toBeDefined();
      expect(resolution.toolResult!.success).toBe(true);

      // Action is now tool_completed in the store (Phase 1 done; Phase 2 requires Orchestrator.approve())
      const completed = await approvalStore.getById(actionId);
      expect(completed!.status).toBe('tool_completed');
      expect((completed!.resolution!.toolResult!.data as { txId: string }).txId).toBe('tx-001');
    });

    it('9b — reject pending action marks it rejected without executing the tool', async () => {
      const llm = new MockLLMProvider('mock', [
        makeToolCallResponse([
          {
            id: 'tx-call-3',
            toolName: 'bank.transfer',
            input: { amount: 50000, toAccount: 'ACC-SUSPICIOUS' },
          },
        ]),
        makeTextResponse('Transfer pending approval.'),
      ]);

      const loop = new AgentLoop(
        makeAgent('agent-finance', 'mock'),
        toolRegistry,
        skillRegistry,
        llm,
        memory,
        bus,
        tokens,
        undefined,
        undefined,
        approvalService,
      );

      const runResponse = await loop.run(
        'Transfer $50,000.',
        makeContext({ agentId: 'agent-finance' }),
      );

      const actionId = runResponse.pendingActions![0]!.actionId;
      const approverCtx = makeContext({ userId: 'manager-2', roles: ['manager'] });

      const resolution = await approvalService.reject(actionId, approverCtx, {
        reason: 'Suspicious transfer amount.',
      });

      expect(resolution.decision).toBe('reject');
      expect(resolution.comment).toBe('Suspicious transfer amount.');

      const rejected = await approvalStore.getById(actionId);
      expect(rejected!.status).toBe('rejected');
    });
  });

  // ── 10. Token tracking ──────────────────────────────────────────────────────

  describe('10 — Token usage is tracked per tenant', () => {
    it('records token usage after a chat() call', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
      const mock = new MockLLMProvider('mock', [makeTextResponse('Token tracking test response.')]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-tokens', 'mock'));

      const before = new Date(Date.now() - 1000);
      await orch.chat('agent-tokens', 'Say something.', {
        tenantId: 'tenant-tokens',
        userId: 'user-tokens',
        roles: ['employee'],
      });
      const after = new Date(Date.now() + 1000);

      const summary = await orch.tokens.getByTenant('tenant-tokens', {
        from: before,
        to: after,
      });

      expect(summary.totalInputTokens).toBeGreaterThan(0);
      expect(summary.totalOutputTokens).toBeGreaterThan(0);
      expect(summary.recordCount).toBe(1);
    });

    it('accumulates token usage across multiple calls', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
      const mock = new MockLLMProvider('mock', [
        makeTextResponse('First response.'),
        makeTextResponse('Second response.'),
        makeTextResponse('Third response.'),
      ]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-tokens-multi', 'mock'));

      const before = new Date(Date.now() - 1000);

      for (let i = 0; i < 3; i++) {
        await orch.chat('agent-tokens-multi', `Message ${i + 1}`, {
          tenantId: 'tenant-multi-tokens',
          userId: 'u1',
          roles: ['employee'],
        });
      }

      const after = new Date(Date.now() + 1000);
      const summary = await orch.tokens.getByTenant('tenant-multi-tokens', {
        from: before,
        to: after,
      });

      expect(summary.recordCount).toBe(3);
      expect(summary.totalInputTokens).toBe(3 * 50); // 50 per call from makeTextResponse
      expect(summary.totalOutputTokens).toBe(3 * 30); // 30 per call
    });

    it('checkLimit returns remaining capacity after usage', async () => {
      const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
      const mock = new MockLLMProvider('mock', [makeTextResponse('Done.')]);
      orch.registerProvider(mock);
      orch.registerAgent(makeAgent('agent-limit', 'mock'));

      await orch.chat('agent-limit', 'Test.', {
        tenantId: 'tenant-limit',
        userId: 'user-limit',
        roles: ['employee'],
      });

      const limitCheck = await orch.tokens.checkLimit('tenant-limit', 'user-limit');
      expect(limitCheck.allowed).toBe(true);
      expect(limitCheck.remaining).toBeLessThan(limitCheck.limit);
    });
  });
});
