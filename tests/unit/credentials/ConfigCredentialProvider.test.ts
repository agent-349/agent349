import { describe, it, expect } from 'vitest';
import { ConfigCredentialProvider } from '../../../src/credentials/ConfigCredentialProvider.js';
import { CredentialError } from '../../../src/errors/index.js';
import type { ExecutionContext } from '../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

describe('ConfigCredentialProvider', () => {
  it('returns the declared credential', async () => {
    const provider = new ConfigCredentialProvider({
      db: { kind: 'basic', username: 'ro', password: 'pw' },
    });

    await expect(provider.get('db', CTX)).resolves.toEqual({
      kind: 'basic',
      username: 'ro',
      password: 'pw',
    });
  });

  it('lists the declared refs when one is missing', async () => {
    const provider = new ConfigCredentialProvider({ db: { kind: 'none' } });

    await expect(provider.get('nope', CTX)).rejects.toThrow(CredentialError);
    await expect(provider.get('nope', CTX)).rejects.toThrow(/Declared: db/);
  });

  it('reports an empty section rather than pretending it is fine', async () => {
    await expect(new ConfigCredentialProvider().get('x', CTX)).rejects.toThrow(/\(none\)/);
  });

  // An unresolved ${ENV_VAR} collapses to '' in the ConfigLoader. Handing that
  // to a driver surfaces as an authentication failure that hides the real
  // cause: a variable missing from the environment.
  it('rejects a field left empty by an unresolved env placeholder', async () => {
    const provider = new ConfigCredentialProvider({
      db: { kind: 'basic', username: 'ro', password: '' },
    });

    await expect(provider.get('db', CTX)).rejects.toThrow(/password/);
    await expect(provider.get('db', CTX)).rejects.toThrow(/ENV_VAR/);
  });

  it('rejects an empty bearer token', async () => {
    const provider = new ConfigCredentialProvider({ api: { kind: 'bearer', token: '' } });
    await expect(provider.get('api', CTX)).rejects.toThrow(/token/);
  });

  it('accepts kinds that carry no required fields', async () => {
    const provider = new ConfigCredentialProvider({
      open: { kind: 'none' },
      odd: { kind: 'custom', value: {} },
    });

    await expect(provider.get('open', CTX)).resolves.toEqual({ kind: 'none' });
    await expect(provider.get('odd', CTX)).resolves.toEqual({ kind: 'custom', value: {} });
  });

  it('never puts credential material in the error message', async () => {
    const provider = new ConfigCredentialProvider({
      db: { kind: 'basic', username: 'ro', password: '' },
    });

    await expect(provider.get('db', CTX)).rejects.toThrow(
      expect.not.stringContaining('ro') as unknown as string,
    );
  });
});
