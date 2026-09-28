import { describe, it, expect } from 'vitest';
import { DefaultMemoryManager } from '../../../src/memory/DefaultMemoryManager.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { SlidingWindow } from '../../../src/memory/strategies/SlidingWindow.js';
import { IncrementalSummary } from '../../../src/memory/strategies/IncrementalSummary.js';
import { MemoryStrategy } from '../../../src/memory/strategies/MemoryStrategy.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

class MockLLMProvider extends LLMProvider {
  readonly name = 'mock';
  readonly providerType = 'mock';
  override async call(_req: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'Mocked summary.',
      stopReason: 'end',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
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

/** A strategy that never compresses (for testing manual compress calls). */
class NeverCompressStrategy extends MemoryStrategy {
  readonly type = 'sliding_window' as const;
  shouldCompress(_messages: LLMMessage[]): boolean {
    return false;
  }
  async compress(messages: LLMMessage[]): Promise<LLMMessage[]> {
    return messages;
  }
}

function makeMessages(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as LLMMessage['role'],
    content: `msg ${i}`,
  }));
}

function makeManager(strategy = new NeverCompressStrategy()) {
  return new DefaultMemoryManager(new InMemoryAdapter(), new InMemoryAdapter(), strategy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DefaultMemoryManager — load / save', () => {
  it('load returns empty array for unknown session', async () => {
    const mgr = makeManager();
    expect(await mgr.load('s1')).toEqual([]);
  });

  it('save then load round-trips the messages', async () => {
    const mgr = makeManager();
    const messages = makeMessages(3);
    await mgr.save('s1', messages);
    expect(await mgr.load('s1')).toEqual(messages);
  });

  it('different sessions are isolated', async () => {
    const mgr = makeManager();
    const m1 = makeMessages(2);
    const m2 = makeMessages(4);
    await mgr.save('s1', m1);
    await mgr.save('s2', m2);
    expect(await mgr.load('s1')).toEqual(m1);
    expect(await mgr.load('s2')).toEqual(m2);
  });
});

describe('DefaultMemoryManager — automatic compression on save', () => {
  it('does not compress when strategy.shouldCompress returns false', async () => {
    const strategy = new SlidingWindow({ maxMessages: 10 });
    const mgr = new DefaultMemoryManager(new InMemoryAdapter(), new InMemoryAdapter(), strategy);
    const messages = makeMessages(5);

    await mgr.save('s1', messages);

    expect(await mgr.load('s1')).toEqual(messages);
  });

  it('compresses automatically when strategy.shouldCompress returns true', async () => {
    const strategy = new SlidingWindow({ maxMessages: 3 });
    const mgr = new DefaultMemoryManager(new InMemoryAdapter(), new InMemoryAdapter(), strategy);
    const messages = makeMessages(5);

    await mgr.save('s1', messages);

    const loaded = await mgr.load('s1');
    expect(loaded).toHaveLength(3);
    expect(loaded).toEqual(messages.slice(-3));
  });

  it('saves the compressed version (not the original) when threshold is exceeded', async () => {
    const strategy = new SlidingWindow({ maxMessages: 2 });
    const mgr = new DefaultMemoryManager(new InMemoryAdapter(), new InMemoryAdapter(), strategy);

    await mgr.save('s1', makeMessages(10));

    const loaded = await mgr.load('s1');
    expect(loaded).toHaveLength(2);
  });
});

describe('DefaultMemoryManager — compress()', () => {
  it('manual compress trims the stored history', async () => {
    const strategy = new SlidingWindow({ maxMessages: 2 });
    const mgr = makeManager(strategy);

    // save without triggering auto-compress (messages.length <= maxMessages)
    await mgr.save('s1', makeMessages(2));
    // manually push 2 more by re-saving with more messages without triggering
    // auto-compress (still only 2), then force compress by calling it directly
    const session = makeMessages(5);
    // Set up directly: save 5 messages — this will trigger auto-compress
    const _neverMgr = makeManager();
    const neverSessionStore = new InMemoryAdapter();
    await neverSessionStore.set('session:messages:s2', session);
    // Use a manager that won't auto-compress to seed the data
    const store2 = new InMemoryAdapter();
    await store2.set('session:messages:s2', session);
    const mgr2 = new DefaultMemoryManager(store2, new InMemoryAdapter(), strategy);

    await mgr2.compress('s2');

    expect(await mgr2.load('s2')).toHaveLength(2);
  });

  it('compress is a no-op when session has no history', async () => {
    const mgr = makeManager();
    await expect(mgr.compress('empty')).resolves.toBeUndefined();
    expect(await mgr.load('empty')).toEqual([]);
  });
});

describe('DefaultMemoryManager — LongTermMemory', () => {
  it('getLongTermContext returns empty array when no facts stored', async () => {
    const mgr = makeManager();
    expect(await mgr.getLongTermContext('t', 'u')).toEqual([]);
  });

  it('saveLongTermFact and getLongTermContext round-trip', async () => {
    const mgr = makeManager();
    await mgr.saveLongTermFact('t', 'u', 'Works in Finance.');
    await mgr.saveLongTermFact('t', 'u', 'Prefers short answers.');

    expect(await mgr.getLongTermContext('t', 'u')).toEqual([
      'Works in Finance.',
      'Prefers short answers.',
    ]);
  });

  it('long-term facts are isolated by tenant and user', async () => {
    const mgr = makeManager();
    await mgr.saveLongTermFact('t1', 'u1', 'fact for t1/u1');
    await mgr.saveLongTermFact('t1', 'u2', 'fact for t1/u2');

    expect(await mgr.getLongTermContext('t1', 'u1')).toEqual(['fact for t1/u1']);
    expect(await mgr.getLongTermContext('t1', 'u2')).toEqual(['fact for t1/u2']);
  });

  it('session and long-term stores are independent', async () => {
    const sessionStore = new InMemoryAdapter();
    const longTermStore = new InMemoryAdapter();
    const mgr = new DefaultMemoryManager(sessionStore, longTermStore, new NeverCompressStrategy());

    await mgr.save('s1', makeMessages(3));
    await mgr.saveLongTermFact('t', 'u', 'a fact');

    // Saving to session should not leak into long-term
    expect(await longTermStore.exists('session:messages:s1')).toBe(false);
    // Saving to long-term should not leak into session
    expect(await sessionStore.exists('ltm:facts:t:u')).toBe(false);
  });
});

describe('DefaultMemoryManager — with IncrementalSummary', () => {
  it('uses IncrementalSummary strategy for auto-compression', async () => {
    const provider = new MockLLMProvider();
    const strategy = new IncrementalSummary(provider, {
      summaryThreshold: 5,
      keepRecent: 2,
      summaryModel: 'fast-model',
    });
    const mgr = new DefaultMemoryManager(new InMemoryAdapter(), new InMemoryAdapter(), strategy);

    await mgr.save('s1', makeMessages(8));

    const loaded = await mgr.load('s1');
    // 1 summary block + 2 recent = 3
    expect(loaded).toHaveLength(3);
    expect(loaded[0]!.content).toContain('[Conversation Summary]');
  });
});

describe('DefaultMemoryManager — config', () => {
  it('passes sessionTtlSeconds to SessionMemory', async () => {
    const sessionStore = new InMemoryAdapter();
    const mgr = new DefaultMemoryManager(
      sessionStore,
      new InMemoryAdapter(),
      new NeverCompressStrategy(),
      { sessionTtlSeconds: 7200 },
    );

    await mgr.save('s1', makeMessages(2));
    // Key must exist in the session store
    expect(await sessionStore.exists('session:messages:s1')).toBe(true);
  });

  it('passes maxFactsPerUser to LongTermMemory', async () => {
    const mgr = new DefaultMemoryManager(
      new InMemoryAdapter(),
      new InMemoryAdapter(),
      new NeverCompressStrategy(),
      { maxFactsPerUser: 2 },
    );

    await mgr.saveLongTermFact('t', 'u', 'oldest');
    await mgr.saveLongTermFact('t', 'u', 'middle');
    await mgr.saveLongTermFact('t', 'u', 'newest');

    const facts = await mgr.getLongTermContext('t', 'u');
    expect(facts).toHaveLength(2);
    expect(facts).not.toContain('oldest');
  });
});
