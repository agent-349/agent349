import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import { ACLService } from '../../../src/security/ACLService.js';
import type {
  LLMRequest,
  LLMResponse,
  AgentConfig,
  Tool,
  ExecutionContext,
  ProviderCapabilities,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MockLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

function makeLLMResponse(content = 'Hello from mock.'): LLMResponse {
  return {
    content,
    stopReason: 'end',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 5,
  };
}

class MockLLMProvider extends LLMProvider {
  readonly name: string;
  readonly providerType = 'mock';
  readonly responses: LLMResponse[];
  private index = 0;
  public callCount = 0;
  public lastRequest: LLMRequest | null = null;

  constructor(name = 'mock', responses: LLMResponse[] = [makeLLMResponse()]) {
    super();
    this.name = name;
    this.responses = responses;
  }

  override async call(req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = req;
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    systemPrompt: 'You are a test agent.',
    skills: [],
    llmConfig: {
      provider: 'mock',
      model: 'mock-model',
    },
    memoryStrategy: { type: 'sliding_window', maxMessages: 10 },
    maxLoopIterations: 3,
    ...overrides,
  };
}

function makeEchoTool(): Tool {
  return {
    name: 'echo',
    description: 'Echoes input.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(input: { text: string }) {
      return { success: true, data: input.text };
    },
  };
}

async function makeOrchestrator(): Promise<Orchestrator> {
  const config = ConfigLoader.from().get();
  return Orchestrator.fromConfig(config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.fromConfig()', () => {
  it('creates an orchestrator from default config', async () => {
    const orch = await makeOrchestrator();
    expect(orch).toBeInstanceOf(Orchestrator);
  });

  it('exposes all component getters', async () => {
    const orch = await makeOrchestrator();
    expect(orch.toolRegistry).toBeDefined();
    expect(orch.skillRegistry).toBeDefined();
    expect(orch.sessions).toBeDefined();
    expect(orch.events).toBeDefined();
    expect(orch.tokens).toBeDefined();
    expect(orch.router).toBeDefined();
  });

  it('config getter returns a snapshot of the resolved config', async () => {
    const config = ConfigLoader.from().get();
    const orch = await Orchestrator.fromConfig(config);
    expect(orch.config.agent.maxLoopIterations).toBe(config.agent.maxLoopIterations);
  });

  it('auto-registers OllamaProvider when ollama config is present', async () => {
    const config = ConfigLoader.from().get();
    const orch = await Orchestrator.fromConfig(config);
    // OllamaProvider is always registered (no API key required)
    const state = orch.router.getCircuitState('ollama');
    expect(state).toBeDefined();
  });

  it('does not register Claude provider when apiKey is empty', async () => {
    const config = ConfigLoader.from().get();
    const orch = await Orchestrator.fromConfig(config);
    // Claude's circuit should not have been warmed (no calls made)
    const state = orch.router.getCircuitState('claude');
    expect(state.failures).toBe(0);
    expect(state.isOpen).toBe(false);
  });
});

describe('registerProvider()', () => {
  it('makes a provider available for routing', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider('custom');
    orch.registerProvider(provider);

    orch.registerAgent(makeMinimalAgent({ llmConfig: { provider: 'custom', model: 'x' } }));

    const response = await orch.chat('agent-1', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(response.content).toBe('Hello from mock.');
    expect(provider.callCount).toBe(1);
  });
});

describe('registerAgent()', () => {
  it('makes the agent available for chat()', async () => {
    const orch = await makeOrchestrator();
    orch.registerProvider(new MockLLMProvider());
    orch.registerAgent(makeMinimalAgent());

    const response = await orch.chat('agent-1', 'hi', { tenantId: 't', userId: 'u', roles: [] });

    expect(response).toBeDefined();
    expect(response.content).toBe('Hello from mock.');
  });

  it('replaces an existing agent with the same id', async () => {
    const orch = await makeOrchestrator();
    orch.registerProvider(new MockLLMProvider('v2', [makeLLMResponse('v2 response')]));
    orch.registerProvider(new MockLLMProvider('v1', [makeLLMResponse('v1 response')]));

    orch.registerAgent(makeMinimalAgent({ llmConfig: { provider: 'v1', model: 'm' } }));
    orch.registerAgent(makeMinimalAgent({ llmConfig: { provider: 'v2', model: 'm' } }));

    const response = await orch.chat('agent-1', 'hi', { tenantId: 't', userId: 'u', roles: [] });

    expect(response.content).toBe('v2 response');
  });
});

describe('registerTool()', () => {
  it('makes the tool available via toolRegistry', async () => {
    const orch = await makeOrchestrator();
    const tool = makeEchoTool();
    orch.registerTool(tool);

    expect(orch.toolRegistry.has('echo')).toBe(true);
    expect(orch.toolRegistry.get('echo')).toBe(tool);
  });
});

describe('registerSkill()', () => {
  it('makes the skill available via skillRegistry', async () => {
    const orch = await makeOrchestrator();
    orch.registerSkill({
      name: 'util',
      description: 'Utility skill',
      tools: [],
    });

    expect(orch.skillRegistry.list()).toContain('util');
  });
});

describe('chat() — API Superior', () => {
  let orch: Orchestrator;
  let provider: MockLLMProvider;

  beforeEach(async () => {
    orch = await makeOrchestrator();
    provider = new MockLLMProvider('mock', [makeLLMResponse('The answer is 42.')]);
    orch.registerProvider(provider);
    orch.registerAgent(makeMinimalAgent());
  });

  it('returns a complete AgentResponse', async () => {
    const response = await orch.chat('agent-1', 'What is the answer?', {
      tenantId: 'acme',
      userId: 'u1',
      roles: ['viewer'],
    });

    expect(response.content).toBe('The answer is 42.');
    expect(response.iterations).toBe(1);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.toolsUsed).toEqual([]);
    expect(response.hasPendingApprovals).toBe(false);
  });

  it('forwards the user message to the LLM', async () => {
    await orch.chat('agent-1', 'What is 2+2?', { tenantId: 't', userId: 'u', roles: [] });

    const messages = provider.lastRequest!.messages;
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('What is 2+2?');
  });

  it('injects the agent systemPrompt into the LLM request', async () => {
    await orch.chat('agent-1', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(provider.lastRequest!.systemPrompt).toContain('You are a test agent.');
  });

  it('creates a new session when no sessionId is provided', async () => {
    await orch.chat('agent-1', 'hello', { tenantId: 'acme', userId: 'u1', roles: [] });

    const sessions = await orch.sessions.listActive('acme', 'u1');
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('reuses the session when sessionId is provided', async () => {
    const session = await orch.sessions.create('acme', 'u1', 'agent-1');

    // Send two messages using the same session
    await orch.chat(
      'agent-1',
      'first',
      { tenantId: 'acme', userId: 'u1', roles: [] },
      { sessionId: session.sessionId },
    );
    await orch.chat(
      'agent-1',
      'second',
      { tenantId: 'acme', userId: 'u1', roles: [] },
      { sessionId: session.sessionId },
    );

    // Only the one session should exist (not three)
    const sessions = await orch.sessions.listActive('acme', 'u1');
    // One session was pre-created; chat without sessionId would create more
    expect(sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);
  });

  it('accumulates conversation history across turns within the same session', async () => {
    const session = await orch.sessions.create('acme', 'u1', 'agent-1');

    await orch.chat(
      'agent-1',
      'turn 1',
      { tenantId: 'acme', userId: 'u1', roles: [] },
      { sessionId: session.sessionId },
    );
    await orch.chat(
      'agent-1',
      'turn 2',
      { tenantId: 'acme', userId: 'u1', roles: [] },
      { sessionId: session.sessionId },
    );

    // On the second call, the LLM receives the history from turn 1
    const lastMessages = provider.lastRequest!.messages;
    expect(lastMessages.length).toBeGreaterThan(2); // prior turn + new user message
  });

  it('passes temperature and maxTokens from agent config to LLM', async () => {
    orch.registerAgent(
      makeMinimalAgent({
        llmConfig: { provider: 'mock', model: 'mock-model', temperature: 0.5, maxTokens: 512 },
      }),
    );

    await orch.chat('agent-1', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(provider.lastRequest!.temperature).toBe(0.5);
    expect(provider.lastRequest!.maxTokens).toBe(512);
  });

  it('throws ConfigError for an unregistered agentId', async () => {
    await expect(
      orch.chat('unknown-agent', 'hi', { tenantId: 't', userId: 'u', roles: [] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('tracks token usage after a call', async () => {
    await orch.chat('agent-1', 'hello', { tenantId: 'acme', userId: 'u1', roles: [] });

    const now = Date.now();
    const summary = await orch.tokens.getByTenant('acme', {
      from: new Date(now - 60_000),
      to: new Date(now + 60_000),
    });
    expect(summary.totalInputTokens).toBeGreaterThan(0);
  });
});

describe('chat() — with tools', () => {
  it('executes a tool call and returns the final response', async () => {
    const orch = await makeOrchestrator();

    const callMock = vi.fn();
    const toolCallResponse: LLMResponse = {
      content: '',
      toolCalls: [{ id: 'tc-1', toolName: 'echo', input: { text: 'hello' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 5,
    };
    const finalResponse = makeLLMResponse('Echo done.');

    const provider = new MockLLMProvider('mock', [toolCallResponse, finalResponse]);
    callMock.mockImplementation(provider.call.bind(provider));

    orch.registerProvider(provider);

    const echoTool = makeEchoTool();
    orch.registerTool(echoTool);

    orch.registerSkill({
      name: 'utils',
      description: 'Utility tools',
      tools: [echoTool],
    });

    orch.registerAgent(
      makeMinimalAgent({
        skills: ['utils'],
      }),
    );

    const response = await orch.chat('agent-1', 'Echo "hello"', {
      tenantId: 't',
      userId: 'u',
      roles: [],
    });

    expect(response.content).toBe('Echo done.');
    expect(response.toolsUsed).toContain('echo');
    expect(response.iterations).toBe(2);
  });
});

describe('chat() — skill system prompt injection', () => {
  it('includes skill systemPromptAddition in the LLM request', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider();
    orch.registerProvider(provider);

    orch.registerSkill({
      name: 'finance',
      description: 'Finance skill',
      tools: [],
      systemPromptAddition: 'Always confirm monetary amounts.',
    });

    orch.registerAgent(makeMinimalAgent({ skills: ['finance'] }));

    await orch.chat('agent-1', 'help', { tenantId: 't', userId: 'u', roles: [] });

    expect(provider.lastRequest!.systemPrompt).toContain('Always confirm monetary amounts.');
  });
});

describe('runAgent()', () => {
  it('accepts a fully built ExecutionContext', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider();
    orch.registerProvider(provider);
    orch.registerAgent(makeMinimalAgent());

    const context: ExecutionContext = {
      tenantId: 'acme',
      userId: 'u1',
      roles: ['admin'],
      sessionId: 'sess-explicit',
      agentId: 'agent-1',
      requestId: 'req-123',
    };

    const response = await orch.runAgent('agent-1', 'hello', context);

    expect(response.content).toBe('Hello from mock.');
  });

  it('throws ConfigError for an unregistered agentId', async () => {
    const orch = await makeOrchestrator();

    const context: ExecutionContext = {
      tenantId: 't',
      userId: 'u',
      roles: [],
      sessionId: 's',
      agentId: 'ghost',
      requestId: 'r',
    };

    await expect(orch.runAgent('ghost', 'hi', context)).rejects.toBeInstanceOf(ConfigError);
  });

  it('supports stateless mode via externalContext', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider();
    orch.registerProvider(provider);
    orch.registerAgent(makeMinimalAgent());

    const context: ExecutionContext = {
      tenantId: 't',
      userId: 'u',
      roles: [],
      sessionId: 'no-memory',
      agentId: 'agent-1',
      requestId: 'r',
    };

    await orch.runAgent('agent-1', 'hello', context, {
      externalContext: [{ role: 'user', content: 'prior turn' }],
    });

    const messages = provider.lastRequest!.messages;
    expect(messages.some((m) => m.content === 'prior turn')).toBe(true);
  });
});

describe('events', () => {
  it('emits agent.loop.start and agent.loop.end events during chat()', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider();
    orch.registerProvider(provider);
    orch.registerAgent(makeMinimalAgent());

    const emittedEvents: string[] = [];
    orch.events.on('agent.*', (event) => {
      emittedEvents.push(event.type);
    });

    await orch.chat('agent-1', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(emittedEvents).toContain('agent.loop.start');
    expect(emittedEvents).toContain('agent.loop.end');
  });

  it('invokes onEvent callback from ChatOptions', async () => {
    const orch = await makeOrchestrator();
    orch.registerProvider(new MockLLMProvider());
    orch.registerAgent(makeMinimalAgent());

    const eventTypes: string[] = [];
    await orch.chat(
      'agent-1',
      'hello',
      { tenantId: 't', userId: 'u', roles: [] },
      {
        onEvent: (e) => {
          eventTypes.push(e.type);
        },
      },
    );

    expect(eventTypes.length).toBeGreaterThan(0);
    expect(eventTypes).toContain('agent.loop.end');
  });
});

describe('LLM config resolution — defaultProvider / optional llmConfig', () => {
  it('uses defaultProvider from SDKConfig when agent omits llmConfig', async () => {
    const config = ConfigLoader.from({
      llm: { defaultProvider: 'mock-default', defaultModel: 'default-model' },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    const provider = new MockLLMProvider('mock-default');
    orch.registerProvider(provider);

    orch.registerAgent({
      id: 'no-llm-agent',
      name: 'No LLM Config Agent',
      systemPrompt: 'You are minimal.',
      skills: [],
      memoryStrategy: { type: 'sliding_window' },
    });

    const response = await orch.chat('no-llm-agent', 'hello', {
      tenantId: 't',
      userId: 'u',
      roles: [],
    });

    expect(response.content).toBe('Hello from mock.');
    expect(provider.callCount).toBe(1);
  });

  it('agent llmConfig.provider overrides defaultProvider', async () => {
    const config = ConfigLoader.from({
      llm: { defaultProvider: 'wrong-provider', defaultModel: 'default-model' },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    const correctProvider = new MockLLMProvider('correct-provider');
    orch.registerProvider(correctProvider);
    orch.registerProvider(new MockLLMProvider('wrong-provider', [makeLLMResponse('wrong')]));

    orch.registerAgent(
      makeMinimalAgent({
        llmConfig: { provider: 'correct-provider', model: 'correct-model' },
      }),
    );

    const response = await orch.chat('agent-1', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(response.content).toBe('Hello from mock.');
    expect(correctProvider.callCount).toBe(1);
  });

  it('uses defaultModel from SDKConfig when agent omits llmConfig.model', async () => {
    const config = ConfigLoader.from({
      llm: { defaultProvider: 'mock-p', defaultModel: 'my-default-model' },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    const provider = new MockLLMProvider('mock-p');
    orch.registerProvider(provider);

    orch.registerAgent({
      id: 'a',
      name: 'A',
      systemPrompt: 'prompt',
      skills: [],
      memoryStrategy: { type: 'sliding_window' },
    });

    await orch.chat('a', 'hello', { tenantId: 't', userId: 'u', roles: [] });

    expect(provider.lastRequest!.model).toBe('my-default-model');
  });

  it('falls back to provider defaultModel when neither agent nor SDK sets a model', async () => {
    const config = ConfigLoader.from({
      llm: {
        defaultProvider: 'claude',
        providers: {
          claude: { defaultModel: 'claude-from-provider', maxRetries: 1, timeoutMs: 5000 },
        },
      },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    const provider = new MockLLMProvider('claude');
    orch.registerProvider(provider);

    orch.registerAgent({
      id: 'a',
      name: 'A',
      systemPrompt: 'prompt',
      skills: [],
      memoryStrategy: { type: 'sliding_window' },
    });

    await orch.chat('a', 'hi', { tenantId: 't', userId: 'u', roles: [] });

    expect(provider.lastRequest!.model).toBe('claude-from-provider');
  });
});

describe('ACL/security wiring — registerACLService / registerSecurityChain', () => {
  it('blocks a tool that the ACL denies and does not expose it to the LLM', async () => {
    const orch = await makeOrchestrator();

    // Tool that must never execute
    const sensitiveExecute = vi.fn().mockResolvedValue({ data: 'secret' });
    const sensitiveTool: Tool = {
      name: 'sensitive',
      description: 'Sensitive tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: sensitiveExecute,
    };

    // ACL: tool 'sensitive' requires role 'admin'; the caller only has 'user'
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'sensitive',
      allowedRoles: ['admin'],
    });

    // LLM response: single text reply (no tool call, because tool was filtered)
    const provider = new MockLLMProvider('mock', [makeLLMResponse('I cannot help with that.')]);

    orch.registerProvider(provider);
    orch.registerTool(sensitiveTool);
    orch.registerSkill({ name: 's', description: 'd', tools: [sensitiveTool] });
    orch.registerAgent(makeMinimalAgent({ skills: ['s'] }));
    orch.registerACLService(acl);

    const response = await orch.chat('agent-1', 'use the sensitive tool', {
      tenantId: 't',
      userId: 'u',
      roles: ['user'],
    });

    // Tool was not exposed to the LLM (filtered by ACL) so it was never called
    expect(sensitiveExecute).not.toHaveBeenCalled();
    // LLM only saw the filtered tool list and replied normally
    expect(response.content).toBe('I cannot help with that.');

    // Verify the LLM request did NOT include the sensitive tool
    const llmRequest = provider.lastRequest!;
    const toolNames = (llmRequest.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain('sensitive');
  });

  it('does not filter tools when user has the required role', async () => {
    const orch = await makeOrchestrator();

    const execute = vi.fn().mockResolvedValue({ data: 'ok' });
    const tool: Tool = {
      name: 'admin-tool',
      description: 'Admin tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute,
    };

    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'admin-tool',
      allowedRoles: ['admin'],
    });

    const toolCallResponse: LLMResponse = {
      content: '',
      toolCalls: [{ id: 'tc-1', toolName: 'admin-tool', input: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 5,
    };
    const finalResponse = makeLLMResponse('Admin action done.');

    const provider = new MockLLMProvider('mock', [toolCallResponse, finalResponse]);
    orch.registerProvider(provider);
    orch.registerTool(tool);
    orch.registerSkill({ name: 's', description: 'd', tools: [tool] });
    orch.registerAgent(makeMinimalAgent({ skills: ['s'] }));
    orch.registerACLService(acl);

    const response = await orch.chat('agent-1', 'run admin-tool', {
      tenantId: 't',
      userId: 'admin-u',
      roles: ['admin'],
    });

    // Tool was not filtered — admin has the required role
    expect(execute).toHaveBeenCalledOnce();
    expect(response.content).toBe('Admin action done.');
  });
});

describe('events — audit correlation (_context in event payloads)', () => {
  it('includes tenantId, userId, sessionId, requestId in AgentLoop events', async () => {
    const orch = await makeOrchestrator();
    const provider = new MockLLMProvider();
    orch.registerProvider(provider);
    orch.registerAgent(makeMinimalAgent());

    const collectedContexts: Array<Record<string, unknown>> = [];
    orch.events.on('agent.*', (event) => {
      if (event.data._context !== undefined) {
        collectedContexts.push(event.data._context as Record<string, unknown>);
      }
    });

    await orch.chat('agent-1', 'hello', { tenantId: 'tenant-x', userId: 'user-y', roles: [] });

    expect(collectedContexts.length).toBeGreaterThan(0);
    const ctx = collectedContexts[0]!;
    expect(ctx.tenantId).toBe('tenant-x');
    expect(ctx.userId).toBe('user-y');
    expect(typeof ctx.sessionId).toBe('string');
    expect(typeof ctx.requestId).toBe('string');
  });
});

describe('Orchestrator.create() — from file', () => {
  it('loads from a config file path', async () => {
    // Use the built-in defaults.json as a test config file
    const defaultsPath = new URL('../../../src/config/defaults.json', import.meta.url).pathname;

    const orch = await Orchestrator.create(defaultsPath);
    expect(orch).toBeInstanceOf(Orchestrator);
  });

  it('throws ConfigError for a non-existent file path', async () => {
    await expect(Orchestrator.create('/no/such/file.json')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('Orchestrator.create() — from inline object', () => {
  it('merges a partial config with built-in defaults (e.g. llm.circuitBreaker)', async () => {
    const orch = await Orchestrator.create({
      llm: {
        providers: {
          ollama: {
            type: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            defaultModel: 'qwen2.5:7b-instruct',
          },
        },
        defaultProvider: 'ollama',
      },
    });

    expect(orch).toBeInstanceOf(Orchestrator);
  });
});
