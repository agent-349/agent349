import { describe, it, expect } from 'vitest';
import {
  SDKError,
  AccessDeniedError,
  ToolNotFoundError,
  ToolTimeoutError,
  ToolExecutionError,
  MaxIterationsError,
  ConfigError,
  ProviderError,
  RateLimitError,
  ApprovalRequiredError,
  ValidationError,
} from '../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// SDKError (base)
// ─────────────────────────────────────────────────────────────────────────────

describe('SDKError', () => {
  it('is an instance of Error and SDKError', () => {
    const err = new SDKError('something went wrong', 'SDK_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SDKError);
  });

  it('sets message and code', () => {
    const err = new SDKError('msg', 'MY_CODE');
    expect(err.message).toBe('msg');
    expect(err.code).toBe('MY_CODE');
  });

  it('sets name to SDKError', () => {
    expect(new SDKError('x', 'X').name).toBe('SDKError');
  });

  it('forwards cause through ErrorOptions', () => {
    const cause = new Error('original');
    const err = new SDKError('wrapper', 'X', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AccessDeniedError
// ─────────────────────────────────────────────────────────────────────────────

describe('AccessDeniedError', () => {
  const err = new AccessDeniedError('tool', 'finance.getBalance', ['viewer', 'guest']);

  it('extends SDKError and Error', () => {
    expect(err).toBeInstanceOf(SDKError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('AccessDeniedError');
    expect(err.code).toBe('ACCESS_DENIED');
  });

  it('stores context fields', () => {
    expect(err.resourceType).toBe('tool');
    expect(err.resourceId).toBe('finance.getBalance');
    expect(err.userRoles).toEqual(['viewer', 'guest']);
  });

  it('message includes resource and roles', () => {
    expect(err.message).toContain('finance.getBalance');
    expect(err.message).toContain('viewer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolNotFoundError
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolNotFoundError', () => {
  const err = new ToolNotFoundError('hr.getEmployee');

  it('extends SDKError', () => {
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('ToolNotFoundError');
    expect(err.code).toBe('TOOL_NOT_FOUND');
  });

  it('stores toolName', () => {
    expect(err.toolName).toBe('hr.getEmployee');
  });

  it('message includes toolName', () => {
    expect(err.message).toContain('hr.getEmployee');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolTimeoutError
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolTimeoutError', () => {
  const err = new ToolTimeoutError('rag.search', 10_000);

  it('extends SDKError', () => {
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('ToolTimeoutError');
    expect(err.code).toBe('TOOL_TIMEOUT');
  });

  it('stores toolName and timeoutMs', () => {
    expect(err.toolName).toBe('rag.search');
    expect(err.timeoutMs).toBe(10_000);
  });

  it('message includes toolName and timeout value', () => {
    expect(err.message).toContain('rag.search');
    expect(err.message).toContain('10000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolExecutionError
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolExecutionError', () => {
  const upstream = new Error('connection refused');

  it('extends SDKError', () => {
    const err = new ToolExecutionError('finance.transfer', 1, upstream);
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    const err = new ToolExecutionError('finance.transfer', 1, upstream);
    expect(err.name).toBe('ToolExecutionError');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
  });

  it('stores toolName and attempt', () => {
    const err = new ToolExecutionError('finance.transfer', 3, upstream);
    expect(err.toolName).toBe('finance.transfer');
    expect(err.attempt).toBe(3);
  });

  it('chains the upstream error as cause', () => {
    const err = new ToolExecutionError('finance.transfer', 1, upstream);
    expect(err.cause).toBe(upstream);
  });

  it('message includes upstream message', () => {
    const err = new ToolExecutionError('finance.transfer', 1, upstream);
    expect(err.message).toContain('connection refused');
  });

  it('handles non-Error cause gracefully', () => {
    const err = new ToolExecutionError('some.tool', 1, 'string error');
    expect(err.cause).toBeUndefined();
    expect(err.message).toContain('some.tool');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MaxIterationsError
// ─────────────────────────────────────────────────────────────────────────────

describe('MaxIterationsError', () => {
  const err = new MaxIterationsError(10);

  it('extends SDKError', () => {
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('MaxIterationsError');
    expect(err.code).toBe('MAX_ITERATIONS');
  });

  it('stores maxIterations', () => {
    expect(err.maxIterations).toBe(10);
  });

  it('message includes the limit', () => {
    expect(err.message).toContain('10');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfigError
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigError', () => {
  it('extends SDKError', () => {
    expect(new ConfigError('bad config')).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    const err = new ConfigError('bad config');
    expect(err.name).toBe('ConfigError');
    expect(err.code).toBe('CONFIG_ERROR');
  });

  it('stores field when provided', () => {
    const err = new ConfigError('missing API key', 'llm.providers.claude.apiKey');
    expect(err.field).toBe('llm.providers.claude.apiKey');
  });

  it('field is undefined when not provided', () => {
    expect(new ConfigError('file not found').field).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ProviderError
// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderError', () => {
  const err = new ProviderError('claude', 'Overloaded', 'claude-sonnet-4-6', 529);

  it('extends SDKError', () => {
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('ProviderError');
    expect(err.code).toBe('PROVIDER_ERROR');
  });

  it('stores provider, model, and statusCode', () => {
    expect(err.provider).toBe('claude');
    expect(err.model).toBe('claude-sonnet-4-6');
    expect(err.statusCode).toBe(529);
  });

  it('message includes provider name', () => {
    expect(err.message).toContain('claude');
    expect(err.message).toContain('Overloaded');
  });

  it('model and statusCode are optional', () => {
    const minimal = new ProviderError('openai', 'unauthorized');
    expect(minimal.model).toBeUndefined();
    expect(minimal.statusCode).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RateLimitError
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimitError', () => {
  const resetAt = new Date('2026-01-01T12:01:00Z');

  it('extends SDKError', () => {
    expect(new RateLimitError('acme', resetAt, 100)).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    const err = new RateLimitError('acme', resetAt, 100);
    expect(err.name).toBe('RateLimitError');
    expect(err.code).toBe('RATE_LIMIT');
  });

  it('stores tenantId, resetAt, and limit', () => {
    const err = new RateLimitError('acme', resetAt, 100);
    expect(err.tenantId).toBe('acme');
    expect(err.resetAt).toBe(resetAt);
    expect(err.limit).toBe(100);
    expect(err.remaining).toBe(0);
  });

  it('stores userId when provided', () => {
    const err = new RateLimitError('acme', resetAt, 20, 'user-42');
    expect(err.userId).toBe('user-42');
  });

  it('userId is undefined for tenant-level limit', () => {
    expect(new RateLimitError('acme', resetAt, 100).userId).toBeUndefined();
  });

  it('message includes tenant and reset time', () => {
    const err = new RateLimitError('acme', resetAt, 100);
    expect(err.message).toContain('acme');
    expect(err.message).toContain('2026-01-01T12:01:00.000Z');
  });

  it('message mentions user when userId provided', () => {
    const err = new RateLimitError('acme', resetAt, 20, 'user-99');
    expect(err.message).toContain('user-99');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalRequiredError
// ─────────────────────────────────────────────────────────────────────────────

describe('ApprovalRequiredError', () => {
  const err = new ApprovalRequiredError('finance.transfer', 'act-uuid-123');

  it('extends SDKError', () => {
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    expect(err.name).toBe('ApprovalRequiredError');
    expect(err.code).toBe('APPROVAL_REQUIRED');
  });

  it('stores toolName and actionId', () => {
    expect(err.toolName).toBe('finance.transfer');
    expect(err.actionId).toBe('act-uuid-123');
  });

  it('message includes both toolName and actionId', () => {
    expect(err.message).toContain('finance.transfer');
    expect(err.message).toContain('act-uuid-123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ValidationError
// ─────────────────────────────────────────────────────────────────────────────

describe('ValidationError', () => {
  it('extends SDKError', () => {
    expect(new ValidationError('input.amount', 'must be positive')).toBeInstanceOf(SDKError);
  });

  it('has correct name and code', () => {
    const err = new ValidationError('input.amount', 'must be positive');
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('stores field and value', () => {
    const err = new ValidationError('input.amount', 'must be positive', -500);
    expect(err.field).toBe('input.amount');
    expect(err.value).toBe(-500);
  });

  it('value is undefined when not provided', () => {
    expect(new ValidationError('some.field', 'required').value).toBeUndefined();
  });

  it('message reflects provided description', () => {
    const err = new ValidationError('input.currency', 'unsupported currency');
    expect(err.message).toBe('unsupported currency');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// instanceof hierarchy across all classes
// ─────────────────────────────────────────────────────────────────────────────

describe('instanceof hierarchy', () => {
  const cases: [string, SDKError][] = [
    ['AccessDeniedError', new AccessDeniedError('tool', 'x', [])],
    ['ToolNotFoundError', new ToolNotFoundError('x')],
    ['ToolTimeoutError', new ToolTimeoutError('x', 1000)],
    ['ToolExecutionError', new ToolExecutionError('x', 1, new Error('e'))],
    ['MaxIterationsError', new MaxIterationsError(5)],
    ['ConfigError', new ConfigError('x')],
    ['ProviderError', new ProviderError('p', 'x')],
    ['RateLimitError', new RateLimitError('t', new Date(), 10)],
    ['ApprovalRequiredError', new ApprovalRequiredError('x', 'y')],
    ['ValidationError', new ValidationError('f', 'x')],
  ];

  for (const [label, err] of cases) {
    it(`${label} instanceof SDKError and Error`, () => {
      expect(err).toBeInstanceOf(SDKError);
      expect(err).toBeInstanceOf(Error);
    });
  }
});
