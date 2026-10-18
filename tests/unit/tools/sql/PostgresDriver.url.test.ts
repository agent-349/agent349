import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { PostgresDriver } from '../../../../src/tools/builtin/sql/PostgresDriver.js';

/** Opens the driver against a stand-in `pg` and returns the options its Pool received. */
async function poolOptions(
  config: Record<string, unknown>,
  credential: unknown,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  vi.doMock('pg', () => ({
    Pool: class {
      constructor(options: Record<string, unknown>) {
        captured = options;
      }
    },
  }));
  onTestFinished(() => {
    vi.doUnmock('pg');
  });
  await new PostgresDriver().open(
    { type: 'sql', driver: 'postgres', ...config } as never,
    credential as never,
  );
  return captured;
}

// `pg` lays what it parses from `connectionString` over the explicit options,
// so a URL without a password used to erase the credential's.
describe('PostgresDriver — url with a basic credential', () => {
  it('puts the credential into a URL that has none', async () => {
    const options = await poolOptions(
      { url: 'postgres://db.internal:5432/erp?sslmode=require' },
      { kind: 'basic', username: 'agent ro', password: 'p@ss:w/rd' },
    );
    const url = new URL(String(options['connectionString']));
    expect(decodeURIComponent(url.username)).toBe('agent ro');
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd');
    expect(url.host).toBe('db.internal:5432');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });

  it('keeps the credentials a URL already carries', async () => {
    const options = await poolOptions(
      { url: 'postgres://own:secret@db/erp' },
      { kind: 'basic', username: 'other', password: 'x' },
    );
    expect(options['connectionString']).toBe('postgres://own:secret@db/erp');
  });

  it('leaves a keyword/value connection string alone', async () => {
    const options = await poolOptions(
      { url: 'host=db dbname=erp' },
      { kind: 'basic', username: 'u', password: 'p' },
    );
    expect(options['connectionString']).toBe('host=db dbname=erp');
    expect(options['password']).toBe('p');
  });
});
