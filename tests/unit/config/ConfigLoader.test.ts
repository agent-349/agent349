import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TMP_DIR = join(tmpdir(), 'agent349-config-tests');

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(TMP_DIR, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  // Best-effort cleanup — ignore errors if files were already removed
  const files = ['user.json', 'envvars.json', 'bad.json', 'malformed.json'];
  await Promise.allSettled(files.map((f) => unlink(join(TMP_DIR, f))));
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfigLoader.from() — synchronous, no file I/O
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigLoader.from()', () => {
  it('returns defaults when called with no arguments', () => {
    const cfg = ConfigLoader.from();
    const result = cfg.get();

    expect(result.agent.maxLoopIterations).toBe(10);
    expect(result.agent.defaultTemperature).toBe(0.1);
    expect(result.agent.defaultMaxTokens).toBe(4096);
    expect(result.tools.defaultTimeoutMs).toBe(10000);
    expect(result.tools.maxRetries).toBe(2);
    expect(result.logging.level).toBe('info');
    expect(result.tokens.limitMode).toBe('observe');
  });

  it('applies a shallow-nested override, preserving sibling defaults', () => {
    const cfg = ConfigLoader.from({ agent: { maxLoopIterations: 5 } });
    const result = cfg.get();

    expect(result.agent.maxLoopIterations).toBe(5);
    // Siblings preserved from defaults
    expect(result.agent.defaultTemperature).toBe(0.1);
    expect(result.agent.defaultMaxTokens).toBe(4096);
  });

  it('applies a deeply-nested override', () => {
    const cfg = ConfigLoader.from({
      llm: { circuitBreaker: { failureThreshold: 5 } },
    });
    expect(cfg.get().llm.circuitBreaker.failureThreshold).toBe(5);
    // Sibling preserved
    expect(cfg.get().llm.circuitBreaker.recoveryTimeMs).toBe(60000);
  });

  it('overrides in multiple sections independently', () => {
    const cfg = ConfigLoader.from({
      tools: { maxRetries: 5 },
      logging: { level: 'debug' },
    });
    const result = cfg.get();
    expect(result.tools.maxRetries).toBe(5);
    expect(result.logging.level).toBe('debug');
    // Unrelated section unaffected
    expect(result.agent.maxLoopIterations).toBe(10);
  });

  it('merges provider configs without wiping unmentioned providers', () => {
    const cfg = ConfigLoader.from({
      llm: { providers: { claude: { defaultModel: 'claude-opus-4-20250514' } } },
    });
    const providers = cfg.get().llm.providers;
    expect(providers.claude?.defaultModel).toBe('claude-opus-4-20250514');
    // Sibling providers remain
    expect(providers.openai?.defaultModel).toBe('gpt-6-sol');
  });

  it('resolves environment placeholders in programmatic overrides', () => {
    const previous = process.env['AGENT349_TEST_OPENAI_KEY'];
    process.env['AGENT349_TEST_OPENAI_KEY'] = 'test-secret';
    try {
      const result = ConfigLoader.from({
        llm: { providers: { openai: { apiKey: '${AGENT349_TEST_OPENAI_KEY}' } } },
      }).get();
      expect(result.llm.providers.openai?.apiKey).toBe('test-secret');
    } finally {
      if (previous === undefined) delete process.env['AGENT349_TEST_OPENAI_KEY'];
      else process.env['AGENT349_TEST_OPENAI_KEY'] = previous;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get() / getSection()
// ─────────────────────────────────────────────────────────────────────────────

describe('get() / getSection()', () => {
  it('get() returns a deep clone — mutations do not affect internal state', () => {
    const cfg = ConfigLoader.from();
    const a = cfg.get();
    a.agent.maxLoopIterations = 999;
    const b = cfg.get();
    expect(b.agent.maxLoopIterations).toBe(10);
  });

  it('getSection() returns only the requested section', () => {
    const cfg = ConfigLoader.from({ tools: { maxRetries: 7 } });
    const tools = cfg.getSection('tools');
    expect(tools.maxRetries).toBe(7);
    expect(tools.defaultTimeoutMs).toBe(10000);
  });

  it('getSection() returns a deep clone', () => {
    const cfg = ConfigLoader.from();
    const section = cfg.getSection('agent');
    section.maxLoopIterations = 42;
    expect(cfg.getSection('agent').maxLoopIterations).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation — ConfigLoader.from() with invalid values
// ─────────────────────────────────────────────────────────────────────────────

describe('validation', () => {
  it('throws ConfigError for agent.maxLoopIterations <= 0', () => {
    expect(() => ConfigLoader.from({ agent: { maxLoopIterations: 0 } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ agent: { maxLoopIterations: -1 } });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).field).toBe('agent.maxLoopIterations');
      expect((err as ConfigError).code).toBe('CONFIG_ERROR');
    }
  });

  it('throws ConfigError for agent.defaultTemperature out of [0,1]', () => {
    expect(() => ConfigLoader.from({ agent: { defaultTemperature: 1.5 } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ agent: { defaultTemperature: -0.1 } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('agent.defaultTemperature');
    }
  });

  it('throws ConfigError for agent.defaultMaxTokens <= 0', () => {
    expect(() => ConfigLoader.from({ agent: { defaultMaxTokens: 0 } })).toThrow(ConfigError);
  });

  it("defaults rag.retrieval.rerankPolicy to 'require'", () => {
    const cfg = ConfigLoader.from();
    expect(cfg.getSection('rag').retrieval.rerankPolicy).toBe('require');
  });

  it('accepts an explicit rag.retrieval.rerankPolicy', () => {
    const cfg = ConfigLoader.from({ rag: { retrieval: { rerankPolicy: 'degrade' } } });
    expect(cfg.getSection('rag').retrieval.rerankPolicy).toBe('degrade');
  });

  it('throws ConfigError for an unknown rag.retrieval.rerankPolicy', () => {
    expect(() =>
      ConfigLoader.from({
        rag: { retrieval: { rerankPolicy: 'ignore' as 'require' | 'degrade' } },
      }),
    ).toThrow(ConfigError);
    try {
      ConfigLoader.from({
        rag: { retrieval: { rerankPolicy: 'ignore' as 'require' | 'degrade' } },
      });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.rerankPolicy');
    }
  });

  it('throws ConfigError for tools.defaultTimeoutMs <= 0', () => {
    expect(() => ConfigLoader.from({ tools: { defaultTimeoutMs: -500 } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ tools: { defaultTimeoutMs: 0 } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('tools.defaultTimeoutMs');
    }
  });

  it('throws ConfigError for tools.maxRetries < 0', () => {
    expect(() => ConfigLoader.from({ tools: { maxRetries: -1 } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ tools: { maxRetries: -1 } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('tools.maxRetries');
    }
  });

  it('allows tools.maxRetries = 0 (no retries is valid)', () => {
    expect(() => ConfigLoader.from({ tools: { maxRetries: 0 } })).not.toThrow();
  });

  it('throws ConfigError for tools.retryBackoffMs <= 0', () => {
    expect(() => ConfigLoader.from({ tools: { retryBackoffMs: 0 } })).toThrow(ConfigError);
  });

  it('throws ConfigError for memory.session.ttlSeconds <= 0', () => {
    expect(() => ConfigLoader.from({ memory: { session: { ttlSeconds: 0 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ memory: { session: { ttlSeconds: -1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('memory.session.ttlSeconds');
    }
  });

  it('throws ConfigError for memory.session.maxMessagesBeforeCompress <= 0', () => {
    expect(() =>
      ConfigLoader.from({ memory: { session: { maxMessagesBeforeCompress: 0 } } }),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError for memory.longTerm.maxFactsPerUser <= 0', () => {
    expect(() => ConfigLoader.from({ memory: { longTerm: { maxFactsPerUser: -5 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ memory: { longTerm: { maxFactsPerUser: 0 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('memory.longTerm.maxFactsPerUser');
    }
  });

  it('throws ConfigError for invalid logging.level', () => {
    expect(() => ConfigLoader.from({ logging: { level: 'verbose' as any } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ logging: { level: 'trace' as any } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('logging.level');
    }
  });

  it('throws ConfigError for llm.circuitBreaker.failureThreshold <= 0', () => {
    expect(() => ConfigLoader.from({ llm: { circuitBreaker: { failureThreshold: 0 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ llm: { circuitBreaker: { failureThreshold: -1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('llm.circuitBreaker.failureThreshold');
    }
  });

  it('accepts all token limit modes and rejects unknown values', () => {
    for (const limitMode of ['enforce', 'observe', 'disabled'] as const) {
      expect(ConfigLoader.from({ tokens: { limitMode } }).get().tokens.limitMode).toBe(limitMode);
    }
    expect(() =>
      ConfigLoader.from({
        tokens: { limitMode: 'invalid' as any },
      }),
    ).toThrow(ConfigError);
  });

  it('rejects non-positive token limits', () => {
    expect(() => ConfigLoader.from({ tokens: { limits: { perUser: { daily: 0 } } } })).toThrow(
      ConfigError,
    );
  });

  it('throws ConfigError for llm.circuitBreaker.recoveryTimeMs <= 0', () => {
    expect(() => ConfigLoader.from({ llm: { circuitBreaker: { recoveryTimeMs: 0 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ llm: { circuitBreaker: { recoveryTimeMs: -100 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('llm.circuitBreaker.recoveryTimeMs');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfigLoader.load() — async, reads file
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigLoader.load()', () => {
  it('resolves to defaults when called with no arguments', async () => {
    const cfg = await ConfigLoader.load();
    expect(cfg.get().agent.maxLoopIterations).toBe(10);
    expect(cfg.get().logging.level).toBe('info');
  });

  it('reads a user JSON file and merges it over defaults', async () => {
    const filePath = await writeTmp(
      'user.json',
      JSON.stringify({ agent: { maxLoopIterations: 7 }, logging: { level: 'debug' } }),
    );

    const cfg = await ConfigLoader.load(filePath);
    expect(cfg.get().agent.maxLoopIterations).toBe(7);
    expect(cfg.get().logging.level).toBe('debug');
    // Unrelated defaults preserved
    expect(cfg.get().tools.defaultTimeoutMs).toBe(10000);
  });

  it('resolves ${ENV_VAR} placeholders from process.env', async () => {
    process.env['TEST_API_KEY'] = 'sk-test-1234';
    process.env['TEST_MODEL'] = 'claude-opus-4-20250514';

    const filePath = await writeTmp(
      'envvars.json',
      JSON.stringify({
        llm: {
          providers: {
            claude: { apiKey: '${TEST_API_KEY}', defaultModel: '${TEST_MODEL}' },
          },
        },
      }),
    );

    const cfg = await ConfigLoader.load(filePath);
    const claude = cfg.get().llm.providers.claude;

    expect(claude?.apiKey).toBe('sk-test-1234');
    expect(claude?.defaultModel).toBe('claude-opus-4-20250514');

    delete process.env['TEST_API_KEY'];
    delete process.env['TEST_MODEL'];
  });

  it('replaces unresolved ${ENV_VAR} with empty string', async () => {
    delete process.env['DEFINITELY_NOT_SET_VAR'];

    const filePath = await writeTmp(
      'bad.json',
      JSON.stringify({ llm: { providers: { claude: { apiKey: '${DEFINITELY_NOT_SET_VAR}' } } } }),
    );

    const cfg = await ConfigLoader.load(filePath);
    expect(cfg.get().llm.providers.claude?.apiKey).toBe('');
  });

  it('applies programmatic overrides after file merge (highest priority)', async () => {
    const filePath = await writeTmp(
      'user.json',
      JSON.stringify({ agent: { maxLoopIterations: 7 } }),
    );

    const cfg = await ConfigLoader.load(filePath, { agent: { maxLoopIterations: 3 } });
    expect(cfg.get().agent.maxLoopIterations).toBe(3);
  });

  it('throws ConfigError when the file does not exist', async () => {
    await expect(ConfigLoader.load('/nonexistent/path/config.json')).rejects.toThrow(ConfigError);
    await expect(ConfigLoader.load('/nonexistent/path/config.json')).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      field: 'filePath',
    });
  });

  it('throws ConfigError when the file contains malformed JSON', async () => {
    const filePath = await writeTmp('malformed.json', '{ "agent": { broken json');

    await expect(ConfigLoader.load(filePath)).rejects.toThrow(ConfigError);
    await expect(ConfigLoader.load(filePath)).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      field: 'filePath',
    });
  });

  it('throws ConfigError when file overrides produce invalid config', async () => {
    const filePath = await writeTmp(
      'user.json',
      JSON.stringify({ agent: { maxLoopIterations: 0 } }),
    );

    await expect(ConfigLoader.load(filePath)).rejects.toThrow(ConfigError);
    await expect(ConfigLoader.load(filePath)).rejects.toMatchObject({
      field: 'agent.maxLoopIterations',
    });
  });

  it('chains the original I/O error as cause', async () => {
    try {
      await ConfigLoader.load('/no/such/file.json');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).cause).toBeInstanceOf(Error);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RAG config validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validation — rag section', () => {
  it('returns correct rag defaults', () => {
    const cfg = ConfigLoader.from();
    const rag = cfg.getSection('rag');
    expect(rag.retrieval.topK).toBe(10);
    expect(rag.retrieval.finalTopK).toBe(5);
    expect(rag.retrieval.hybridAlpha).toBe(0.7);
    expect(rag.retrieval.searchMode).toBe('hybrid');
    expect(rag.retrieval.minScore).toBe(0);
    expect(rag.retrieval.rerank).toBe(false);
    expect(rag.retrieval.rrfK).toBe(60);
    expect(rag.vectorStore.adapter).toBe('in-memory');
    expect(rag.embedding.defaultProvider).toBe('openai');
  });

  it('throws ConfigError for rag.retrieval.topK <= 0', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { topK: 0 } } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ rag: { retrieval: { topK: -1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.topK');
    }
  });

  it('throws ConfigError for rag.retrieval.finalTopK <= 0', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { finalTopK: 0 } } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ rag: { retrieval: { finalTopK: 0 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.finalTopK');
    }
  });

  it('throws ConfigError when finalTopK > topK', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { topK: 5, finalTopK: 10 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ rag: { retrieval: { topK: 5, finalTopK: 10 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.finalTopK');
    }
  });

  it('throws ConfigError for hybridAlpha out of [0,1]', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { hybridAlpha: 1.5 } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ rag: { retrieval: { hybridAlpha: -0.1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.hybridAlpha');
    }
  });

  it('throws ConfigError for minScore out of [0,1]', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { minScore: 1.5 } } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ rag: { retrieval: { minScore: -0.1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.minScore');
    }
  });

  it('throws ConfigError for rrfK <= 0', () => {
    expect(() => ConfigLoader.from({ rag: { retrieval: { rrfK: 0 } } })).toThrow(ConfigError);
    try {
      ConfigLoader.from({ rag: { retrieval: { rrfK: -1 } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.retrieval.rrfK');
    }
  });

  it('does not throw for meilisearch adapter when meilisearch config is provided', () => {
    expect(() =>
      ConfigLoader.from({
        rag: {
          vectorStore: {
            adapter: 'meilisearch',
            meilisearch: { url: 'http://localhost:7700', requestTimeout: 5000 },
          },
        },
      }),
    ).not.toThrow();
  });

  it('throws ConfigError when cohere reranker has no apiKey', () => {
    expect(() => ConfigLoader.from({ rag: { reranker: { provider: 'cohere' } } })).toThrow(
      ConfigError,
    );
    try {
      ConfigLoader.from({ rag: { reranker: { provider: 'cohere' } } });
    } catch (err) {
      expect((err as ConfigError).field).toBe('rag.reranker.apiKey');
    }
  });

  it('does not throw for cohere reranker when apiKey is provided', () => {
    expect(() =>
      ConfigLoader.from({ rag: { reranker: { provider: 'cohere', apiKey: 'key-123' } } }),
    ).not.toThrow();
  });

  it('does not throw for llm reranker without apiKey', () => {
    expect(() =>
      ConfigLoader.from({ rag: { reranker: { provider: 'llm', model: 'mock' } } }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Env-var resolution edge cases (standalone, no file)
// ─────────────────────────────────────────────────────────────────────────────

describe('env-var resolution (load without file)', () => {
  it('does not touch non-placeholder strings in overrides', () => {
    // overrides applied after env resolution — they bypass resolveEnvVars
    const cfg = ConfigLoader.from({ memory: { session: { adapter: 'memory' } } });
    expect(cfg.get().memory.session.adapter).toBe('memory');
  });
});
