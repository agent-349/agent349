import { describe, it, expect } from 'vitest';
import { LLMRouter } from '../../../src/llm/LLMRouter.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MockLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: 'ok',
    stopReason: 'end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test-model',
    provider: 'mock',
    latencyMs: 10,
    ...overrides,
  };
}

class MockLLMProvider extends LLMProvider {
  readonly name: string;
  readonly providerType = 'mock';
  callCount = 0;

  private readonly responses: Array<LLMResponse | Error>;
  private index = 0;

  constructor(name: string, responses: Array<LLMResponse | Error> = [makeResponse()]) {
    super();
    this.name = name;
    this.responses = responses;
  }

  override async call(_req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    const entry = this.responses[this.index % this.responses.length]!;
    this.index++;
    if (entry instanceof Error) throw entry;
    return entry;
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

const baseRequest: LLMRequest = {
  model: 'test-model',
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user', content: 'hello' }],
};

function makeError(provider = 'mock', msg = 'API error') {
  return new ProviderError(provider, msg, 'test-model');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('basic routing', () => {
  it('calls the primary provider and returns its response', async () => {
    const primary = new MockLLMProvider('primary', [makeResponse({ content: 'from primary' })]);
    const router = new LLMRouter(new Map([['primary', primary]]));

    const response = await router.call(baseRequest, 'primary');

    expect(response.content).toBe('from primary');
    expect(primary.callCount).toBe(1);
  });

  it('throws when the requested primary provider is not registered', async () => {
    const router = new LLMRouter();

    await expect(router.call(baseRequest, 'unknown')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError mentioning the unregistered provider name', async () => {
    const router = new LLMRouter();

    const err = await router.call(baseRequest, 'ghost').catch((e: unknown) => e);
    expect((err as ProviderError).provider).toBe('ghost');
  });
});

describe('registerProvider()', () => {
  it('makes a newly registered provider callable', async () => {
    const router = new LLMRouter();
    const provider = new MockLLMProvider('new');
    router.registerProvider(provider);

    const response = await router.call(baseRequest, 'new');

    expect(response).toBeDefined();
  });

  it('replaces an existing provider with the same name', async () => {
    const original = new MockLLMProvider('p', [makeResponse({ content: 'v1' })]);
    const replacement = new MockLLMProvider('p', [makeResponse({ content: 'v2' })]);
    const router = new LLMRouter(new Map([['p', original]]));

    router.registerProvider(replacement);
    const response = await router.call(baseRequest, 'p');

    expect(response.content).toBe('v2');
  });
});

describe('fallback on primary failure', () => {
  it('calls the fallback when primary throws', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    const fallback = new MockLLMProvider('fallback', [
      makeResponse({ content: 'fallback response' }),
    ]);
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    const response = await router.call(baseRequest, 'primary', 'fallback');

    expect(response.content).toBe('fallback response');
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(1);
  });

  it('uses fallbackModel when specified', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    const fallback = new MockLLMProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    await router.call(baseRequest, 'primary', 'fallback', 'gpt-4o-mini');

    // Inspect the request that reached the fallback by checking callCount
    expect(fallback.callCount).toBe(1);
  });

  it('passes the original model to fallback when fallbackModel is not specified', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    let capturedModel: string | undefined;
    const fallback = new (class extends MockLLMProvider {
      override async call(req: LLMRequest): Promise<LLMResponse> {
        capturedModel = req.model;
        return super.call(req);
      }
    })('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    await router.call({ ...baseRequest, model: 'original-model' }, 'primary', 'fallback');

    expect(capturedModel).toBe('original-model');
  });

  it('passes the overridden model to fallback when fallbackModel is specified', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    let capturedModel: string | undefined;
    const fallback = new (class extends MockLLMProvider {
      override async call(req: LLMRequest): Promise<LLMResponse> {
        capturedModel = req.model;
        return super.call(req);
      }
    })('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    await router.call(baseRequest, 'primary', 'fallback', 'overridden-model');

    expect(capturedModel).toBe('overridden-model');
  });

  it('rethrows the primary error when no fallback is configured', async () => {
    const primary = new MockLLMProvider('primary', [makeError('primary', 'boom')]);
    const router = new LLMRouter(new Map([['primary', primary]]));

    await expect(router.call(baseRequest, 'primary')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws (fallback error) when both primary and fallback fail', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    const fallback = new MockLLMProvider('fallback', [
      makeError('fallback', 'fallback also broken'),
    ]);
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    const err = await router.call(baseRequest, 'primary', 'fallback').catch((e: unknown) => e);
    expect((err as ProviderError).provider).toBe('fallback');
  });

  it('throws ProviderError when fallback provider is not registered', async () => {
    const primary = new MockLLMProvider('primary', [makeError()]);
    const router = new LLMRouter(new Map([['primary', primary]]));

    await expect(router.call(baseRequest, 'primary', 'missing-fallback')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('circuit breaker — opening', () => {
  it('circuit starts closed (isOpen: false)', () => {
    const router = new LLMRouter(new Map([['primary', new MockLLMProvider('primary')]]), {
      failureThreshold: 3,
    });

    expect(router.getCircuitState('primary').isOpen).toBe(false);
  });

  it('failure counter increments on each failure', async () => {
    const provider = new MockLLMProvider('p', [makeError(), makeError(), makeError()]);
    const router = new LLMRouter(new Map([['p', provider]]), { failureThreshold: 5 });

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'p').catch(() => undefined);
    }

    expect(router.getCircuitState('p').failures).toBe(3);
    expect(router.getCircuitState('p').isOpen).toBe(false);
  });

  it('opens the circuit after failureThreshold consecutive failures', async () => {
    const provider = new MockLLMProvider('p', [makeError(), makeError(), makeError()]);
    const router = new LLMRouter(new Map([['p', provider]]), { failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'p').catch(() => undefined);
    }

    expect(router.getCircuitState('p').isOpen).toBe(true);
  });

  it('uses default failureThreshold of 3', async () => {
    const provider = new MockLLMProvider('p', [makeError(), makeError(), makeError()]);
    const router = new LLMRouter(new Map([['p', provider]]));

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'p').catch(() => undefined);
    }

    expect(router.getCircuitState('p').isOpen).toBe(true);
  });

  it('does not open circuit before threshold is reached', async () => {
    const provider = new MockLLMProvider('p', [makeError(), makeError()]);
    const router = new LLMRouter(new Map([['p', provider]]), { failureThreshold: 3 });

    await router.call(baseRequest, 'p').catch(() => undefined);
    await router.call(baseRequest, 'p').catch(() => undefined);

    expect(router.getCircuitState('p').isOpen).toBe(false);
  });
});

describe('circuit breaker — open behaviour', () => {
  it('skips primary (does not call it) when circuit is open', async () => {
    const primary = new MockLLMProvider('primary', [makeError(), makeError(), makeError()]);
    const fallback = new MockLLMProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      { failureThreshold: 3 },
    );

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary', 'fallback').catch(() => undefined);
    }

    const callsBeforeFastFail = primary.callCount;

    // Next call: circuit is open, should skip primary entirely
    await router.call(baseRequest, 'primary', 'fallback');

    expect(primary.callCount).toBe(callsBeforeFastFail); // not called again
    expect(fallback.callCount).toBeGreaterThan(0);
  });

  it('throws ProviderError immediately when circuit open and no fallback', async () => {
    const primary = new MockLLMProvider('primary', [makeError(), makeError(), makeError()]);
    const router = new LLMRouter(new Map([['primary', primary]]), { failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary').catch(() => undefined);
    }

    const err = await router.call(baseRequest, 'primary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain('Circuit breaker is open');
  });
});

describe('circuit breaker — recovery', () => {
  it('allows a trial call after recoveryTimeMs elapses', async () => {
    let now = 1_000_000;
    const mockNow = () => now;

    const primary = new MockLLMProvider('primary', [
      makeError(),
      makeError(),
      makeError(),
      makeResponse({ content: 'recovered' }), // 4th call succeeds
    ]);
    const router = new LLMRouter(
      new Map([['primary', primary]]),
      { failureThreshold: 3, recoveryTimeMs: 60_000 },
      mockNow,
    );

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary').catch(() => undefined);
    }
    expect(router.getCircuitState('primary').isOpen).toBe(true);

    // Advance time past recovery window
    now += 60_001;

    // Circuit should now be half-open → allow the trial call
    const response = await router.call(baseRequest, 'primary');
    expect(response.content).toBe('recovered');
  });

  it('closes the circuit after a successful trial call', async () => {
    let now = 0;
    const mockNow = () => now;

    const primary = new MockLLMProvider('primary', [
      makeError(),
      makeError(),
      makeError(),
      makeResponse(),
    ]);
    const router = new LLMRouter(
      new Map([['primary', primary]]),
      { failureThreshold: 3, recoveryTimeMs: 10_000 },
      mockNow,
    );

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary').catch(() => undefined);
    }

    now += 10_001;
    await router.call(baseRequest, 'primary'); // trial succeeds

    expect(router.getCircuitState('primary').isOpen).toBe(false);
    expect(router.getCircuitState('primary').failures).toBe(0);
  });

  it('re-opens the circuit if the trial call also fails', async () => {
    let now = 0;
    const mockNow = () => now;

    const primary = new MockLLMProvider('primary', [
      makeError(),
      makeError(),
      makeError(),
      makeError(), // trial also fails
    ]);
    const router = new LLMRouter(
      new Map([['primary', primary]]),
      { failureThreshold: 3, recoveryTimeMs: 10_000 },
      mockNow,
    );

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary').catch(() => undefined);
    }

    now += 10_001;
    await router.call(baseRequest, 'primary').catch(() => undefined); // trial fails

    expect(router.getCircuitState('primary').isOpen).toBe(true);
  });

  it('does not allow trial before recoveryTimeMs elapses', async () => {
    let now = 0;
    const mockNow = () => now;

    const primary = new MockLLMProvider('primary', [makeError(), makeError(), makeError()]);
    const fallback = new MockLLMProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      { failureThreshold: 3, recoveryTimeMs: 10_000 },
      mockNow,
    );

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary', 'fallback').catch(() => undefined);
    }

    const callsAfterOpen = primary.callCount;
    now += 5_000; // not enough

    await router.call(baseRequest, 'primary', 'fallback');

    // Primary should NOT have been called again
    expect(primary.callCount).toBe(callsAfterOpen);
  });
});

describe('circuit breaker — success resets counter', () => {
  it('resets failure count to 0 after a successful call', async () => {
    const provider = new MockLLMProvider('p', [makeError(), makeError(), makeResponse()]);
    const router = new LLMRouter(new Map([['p', provider]]), { failureThreshold: 5 });

    await router.call(baseRequest, 'p').catch(() => undefined);
    await router.call(baseRequest, 'p').catch(() => undefined);
    expect(router.getCircuitState('p').failures).toBe(2);

    await router.call(baseRequest, 'p'); // success

    expect(router.getCircuitState('p').failures).toBe(0);
    expect(router.getCircuitState('p').isOpen).toBe(false);
  });

  it('after reset, circuit requires failureThreshold new failures to open again', async () => {
    const provider = new MockLLMProvider('p', [
      makeError(),
      makeError(),
      makeResponse(),
      makeError(),
      makeError(),
    ]);
    const router = new LLMRouter(new Map([['p', provider]]), { failureThreshold: 3 });

    await router.call(baseRequest, 'p').catch(() => undefined); // fail
    await router.call(baseRequest, 'p').catch(() => undefined); // fail
    await router.call(baseRequest, 'p'); // success → reset
    await router.call(baseRequest, 'p').catch(() => undefined); // fail
    await router.call(baseRequest, 'p').catch(() => undefined); // fail

    // Only 2 failures since reset — circuit should still be closed
    expect(router.getCircuitState('p').isOpen).toBe(false);
    expect(router.getCircuitState('p').failures).toBe(2);
  });
});

describe('independent circuit state per provider', () => {
  it('opening primary circuit does not affect fallback circuit', async () => {
    let now = 0;
    const primary = new MockLLMProvider('primary', [makeError(), makeError(), makeError()]);
    const fallback = new MockLLMProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      { failureThreshold: 3 },
      () => now,
    );

    for (let i = 0; i < 3; i++) {
      await router.call(baseRequest, 'primary', 'fallback').catch(() => undefined);
    }

    expect(router.getCircuitState('primary').isOpen).toBe(true);
    expect(router.getCircuitState('fallback').isOpen).toBe(false);
  });
});

describe('getCircuitState()', () => {
  it('returns failures: 0 and isOpen: false for unknown provider', () => {
    const router = new LLMRouter();

    expect(router.getCircuitState('nonexistent')).toEqual({ isOpen: false, failures: 0 });
  });
});
