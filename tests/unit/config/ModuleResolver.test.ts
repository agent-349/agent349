import { describe, it, expect } from 'vitest';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModuleResolver } from '../../../src/config/ModuleResolver.js';
import { ModuleResolutionError } from '../../../src/errors/index.js';

describe('ModuleResolver', () => {
  it('returns bare specifiers unchanged (npm packages)', () => {
    const r = new ModuleResolver();
    expect(r.resolve('@acme/tools')).toBe('@acme/tools');
    expect(r.resolve('lodash')).toBe('lodash');
  });

  it('converts absolute paths to file:// URLs', () => {
    const r = new ModuleResolver();
    const abs = isAbsolute('/tmp/x.js') ? '/tmp/x.js' : 'C:\\tmp\\x.js';
    expect(r.resolve(abs)).toBe(pathToFileURL(abs).href);
  });

  it('resolves relative paths against appHome', () => {
    const r = new ModuleResolver({ appHome: '/srv/app' });
    expect(r.resolve('./tools/calc.js')).toBe(pathToFileURL('/srv/app/tools/calc.js').href);
  });

  it('resolves a relative appHome against configDir', () => {
    const r = new ModuleResolver({ appHome: 'dist', configDir: '/srv/app' });
    expect(r.resolve('./tools/calc.js')).toBe(pathToFileURL('/srv/app/dist/tools/calc.js').href);
  });

  it('falls back to configDir when appHome is absent', () => {
    const r = new ModuleResolver({ configDir: '/srv/cfg' });
    expect(r.resolve('./t.js')).toBe(pathToFileURL('/srv/cfg/t.js').href);
  });

  it('rejects unresolved env var placeholders', () => {
    const r = new ModuleResolver();
    expect(() => r.resolve('./${TOOL_PATH}/x.js')).toThrow(ModuleResolutionError);
  });

  it('rejects empty specifiers', () => {
    const r = new ModuleResolver();
    expect(() => r.resolve('')).toThrow(ModuleResolutionError);
  });

  it('allows paths inside moduleRoots', () => {
    const r = new ModuleResolver({ appHome: '/srv/app', moduleRoots: ['/srv/app'] });
    expect(r.resolve('./tools/calc.js')).toBe(pathToFileURL('/srv/app/tools/calc.js').href);
  });

  it('blocks paths that escape moduleRoots (path traversal)', () => {
    const r = new ModuleResolver({ appHome: '/srv/app', moduleRoots: ['/srv/app'] });
    expect(() => r.resolve('../../etc/passwd.js')).toThrow(ModuleResolutionError);
  });

  it('does not apply moduleRoots to bare specifiers', () => {
    const r = new ModuleResolver({ moduleRoots: ['/srv/app'] });
    expect(r.resolve('@acme/tools')).toBe('@acme/tools');
  });
});
