import { describe, it, expect } from 'vitest';
import {
  buildInputSchema,
  readContextPath,
  resolveBindings,
  validateBindings,
} from '../../../src/tools/builtin/binding.js';
import type { BindingMap } from '../../../src/tools/builtin/binding.js';
import { ValidationError } from '../../../src/errors/index.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
  metadata: { employeeId: 4821, department: 'finance', blank: '' },
};

const BINDINGS: BindingMap = {
  employeeId: { from: 'context', path: 'metadata.employeeId', required: true },
  source: { from: 'literal', value: 'agent' },
  from: { from: 'model', schema: { type: 'string' }, description: 'Start date', required: true },
  to: { from: 'model', schema: { type: 'string' } },
};

// ─────────────────────────────────────────────────────────────────────────────
// buildInputSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInputSchema', () => {
  it('publishes only model bindings', () => {
    const schema = buildInputSchema(BINDINGS);
    const properties = schema['properties'] as Record<string, unknown>;

    expect(Object.keys(properties).sort()).toEqual(['from', 'to']);
  });

  // The whole security argument for the binding vocabulary rests on this: a
  // context-bound parameter must be absent from what the model is shown, not
  // merely stripped from its answer afterwards.
  it('never exposes context or literal bindings to the model', () => {
    const schema = buildInputSchema(BINDINGS);
    const serialised = JSON.stringify(schema);

    expect(serialised).not.toContain('employeeId');
    expect(serialised).not.toContain('source');
  });

  it('marks required model bindings and leaves optional ones out', () => {
    const schema = buildInputSchema(BINDINGS);
    expect(schema['required']).toEqual(['from']);
  });

  it('closes the schema so invented fields are rejected downstream', () => {
    expect(buildInputSchema(BINDINGS)['additionalProperties']).toBe(false);
  });

  it('folds the description into the published property schema', () => {
    const properties = buildInputSchema(BINDINGS)['properties'] as Record<string, unknown>;
    expect(properties['from']).toEqual({ type: 'string', description: 'Start date' });
  });

  it('omits `required` entirely when nothing is mandatory', () => {
    const schema = buildInputSchema({ a: { from: 'model', schema: { type: 'string' } } });
    expect(schema['required']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveBindings
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBindings', () => {
  it('resolves each origin from its own source', () => {
    const values = resolveBindings(BINDINGS, { from: '2026-01-01', to: '2026-02-01' }, CTX);

    expect(values).toEqual({
      employeeId: 4821,
      source: 'agent',
      from: '2026-01-01',
      to: '2026-02-01',
    });
  });

  // The attack this exists to stop: the model naming a context-bound parameter
  // in its own input and having that value win.
  it('ignores a model-supplied value for a context-bound parameter', () => {
    const values = resolveBindings(BINDINGS, { from: 'x', employeeId: 9999 }, CTX);
    expect(values['employeeId']).toBe(4821);
  });

  it('ignores a model-supplied value for a literal parameter', () => {
    const values = resolveBindings(BINDINGS, { from: 'x', source: 'spoofed' }, CTX);
    expect(values['source']).toBe('agent');
  });

  it('reads plain context fields as well as metadata', () => {
    const values = resolveBindings(
      { who: { from: 'context', path: 'userId' }, roles: { from: 'context', path: 'roles' } },
      {},
      CTX,
    );
    expect(values).toEqual({ who: 'u1', roles: ['viewer'] });
  });

  it('throws when a required context binding has no value', () => {
    expect(() =>
      resolveBindings(
        { x: { from: 'context', path: 'metadata.missing', required: true } },
        {},
        CTX,
      ),
    ).toThrow(ValidationError);
  });

  // An empty string is what an unset value collapses to in practice; treating
  // it as present would run the query unscoped, which is the failure mode the
  // whole binding design exists to prevent.
  it('treats an empty context value as missing', () => {
    expect(() =>
      resolveBindings({ x: { from: 'context', path: 'metadata.blank', required: true } }, {}, CTX),
    ).toThrow(ValidationError);
  });

  it('throws when a required model binding was not supplied', () => {
    expect(() => resolveBindings(BINDINGS, {}, CTX)).toThrow(ValidationError);
  });

  it('omits optional bindings that produced nothing rather than binding undefined', () => {
    const values = resolveBindings(BINDINGS, { from: '2026-01-01' }, CTX);
    expect('to' in values).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readContextPath
// ─────────────────────────────────────────────────────────────────────────────

describe('readContextPath', () => {
  it('reads every documented context field', () => {
    expect(readContextPath(CTX, 'userId')).toBe('u1');
    expect(readContextPath(CTX, 'tenantId')).toBe('acme');
    expect(readContextPath(CTX, 'sessionId')).toBe('s1');
    expect(readContextPath(CTX, 'agentId')).toBe('agent-1');
    expect(readContextPath(CTX, 'roles')).toEqual(['viewer']);
    expect(readContextPath(CTX, 'metadata.department')).toBe('finance');
  });

  it('returns undefined for an absent metadata key', () => {
    expect(readContextPath(CTX, 'metadata.nope')).toBeUndefined();
  });

  it('returns undefined when the context carries no metadata at all', () => {
    const bare: ExecutionContext = { ...CTX };
    delete bare.metadata;
    expect(readContextPath(bare, 'metadata.employeeId')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateBindings
// ─────────────────────────────────────────────────────────────────────────────

describe('validateBindings', () => {
  it('accepts a well-formed map', () => {
    expect(() => validateBindings(BINDINGS, 'tool.params')).not.toThrow();
  });

  it('rejects a model binding with no schema', () => {
    expect(() => validateBindings({ a: { from: 'model' } as never }, 'tool.params')).toThrow(
      ValidationError,
    );
  });

  it('rejects an unreadable context path', () => {
    expect(() =>
      validateBindings({ a: { from: 'context', path: 'password' as never } }, 'tool.params'),
    ).toThrow(ValidationError);
  });

  it('rejects a bare `metadata.` prefix with no key', () => {
    expect(() =>
      validateBindings({ a: { from: 'context', path: 'metadata.' as never } }, 'tool.params'),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown origin', () => {
    expect(() => validateBindings({ a: { from: 'env' } as never }, 'tool.params')).toThrow(
      ValidationError,
    );
  });

  it('names the offending parameter in the error field', () => {
    try {
      validateBindings({ badOne: { from: 'model' } as never }, 'tool.params');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ValidationError).field).toBe('tool.params.badOne');
    }
  });
});
