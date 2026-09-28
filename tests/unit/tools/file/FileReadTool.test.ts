import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReadTool } from '../../../../src/tools/builtin/file/FileReadTool.js';
import { ValidationError } from '../../../../src/errors/index.js';
import type { InternalToolContext } from '../../../../src/tools/internalToolContext.js';
import type { ExecutionContext } from '../../../../src/types/index.js';

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

interface ReadData {
  text: string;
  fromOffset: number;
  nextOffset: number;
  bytesRead: number;
  size: number;
  fileId: string;
  headHash: string;
  headBytes: number;
  rotated: boolean;
  rotationReason?: string;
  eof: boolean;
  partialLine?: boolean;
  splitLine?: boolean;
}

let root: string;
let outside: string;
let ctx: InternalToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent349-file-'));
  outside = await mkdtemp(join(tmpdir(), 'agent349-file-out-'));
  await writeFile(join(outside, 'secret.log'), 'TOP SECRET\n');
  ctx = { emit: vi.fn() } as unknown as InternalToolContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function tool(overrides: Record<string, unknown> = {}) {
  return createFileReadTool(
    { name: 'file.read', roots: [{ name: 'logs', path: root }], ...overrides },
    ctx,
  );
}

async function read(input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const result = await tool(overrides).execute({ root: 'logs', ...input }, CTX);
  return { result, data: result.data as ReadData };
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental reading
// ─────────────────────────────────────────────────────────────────────────────

describe('file.read incremental', () => {
  it('reads a file from the start and reports where it stopped', async () => {
    await writeFile(join(root, 'app.log'), 'one\ntwo\n');
    const { result, data } = await read({ path: 'app.log' });

    expect(result.success).toBe(true);
    expect(data.text).toBe('one\ntwo\n');
    expect(data.fromOffset).toBe(0);
    expect(data.nextOffset).toBe(8);
    expect(data.eof).toBe(true);
    expect(data.rotated).toBe(false);
  });

  it('returns only what was appended since the previous offset', async () => {
    await writeFile(join(root, 'app.log'), 'one\ntwo\n');
    const first = await read({ path: 'app.log' });
    await appendFile(join(root, 'app.log'), 'three\n');

    const { data } = await read({ path: 'app.log', offset: first.data.nextOffset });

    expect(data.text).toBe('three\n');
    expect(data.fromOffset).toBe(8);
    expect(data.nextOffset).toBe(14);
  });

  it('leaves an unfinished last line for the next read', async () => {
    await writeFile(join(root, 'app.log'), 'one\ntw');
    const first = await read({ path: 'app.log' });

    expect(first.data.text).toBe('one\n');
    expect(first.data.partialLine).toBe(true);
    expect(first.data.nextOffset).toBe(4);

    await appendFile(join(root, 'app.log'), 'o\n');
    const second = await read({ path: 'app.log', offset: first.data.nextOffset });
    expect(second.data.text).toBe('two\n');
  });

  it('returns nothing yet when the only content is an unfinished line', async () => {
    await writeFile(join(root, 'app.log'), 'no newline yet');
    const { data } = await read({ path: 'app.log' });

    expect(data.text).toBe('');
    expect(data.nextOffset).toBe(0);
    expect(data.partialLine).toBe(true);
  });

  it('reads a whole file without a trailing newline when line alignment is off', async () => {
    await writeFile(join(root, 'config.json'), '{"a":1}');
    const { data } = await read({ path: 'config.json', lineAligned: false });

    expect(data.text).toBe('{"a":1}');
    expect(data.eof).toBe(true);
  });

  it('stops at the byte cap on a line boundary and continues from there', async () => {
    await writeFile(join(root, 'app.log'), 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n');
    const first = await read({ path: 'app.log', maxBytes: 25 });

    expect(first.data.text).toBe('aaaaaaaaaa\nbbbbbbbbbb\n');
    expect(first.data.eof).toBe(false);

    const second = await read({ path: 'app.log', offset: first.data.nextOffset, maxBytes: 25 });
    expect(second.data.text).toBe('cccccccccc\n');
  });

  // Otherwise a line longer than the read limit would stall the reader forever.
  it('delivers a single overlong line in parts', async () => {
    await writeFile(join(root, 'app.log'), `${'x'.repeat(40)}\n`);
    const { data } = await read({ path: 'app.log', maxBytes: 16 });

    expect(data.splitLine).toBe(true);
    expect(data.bytesRead).toBe(16);
    expect(data.nextOffset).toBe(16);
  });

  it('never cuts a multi-byte character in half', async () => {
    await writeFile(join(root, 'utf8.txt'), `${'a'.repeat(15)}ñandú`);
    const { data } = await read({ path: 'utf8.txt', maxBytes: 16, lineAligned: false });

    expect(data.text).toBe('a'.repeat(15));
    expect(data.text).not.toContain('�');
    expect(data.nextOffset).toBe(15);
  });

  it('cannot raise the configured byte cap from the input', async () => {
    await writeFile(join(root, 'app.log'), 'x'.repeat(100) + '\n');
    const { data } = await read({ path: 'app.log', maxBytes: 10_000 }, { maxBytes: 32 });

    expect(data.bytesRead).toBeLessThanOrEqual(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rotation
// ─────────────────────────────────────────────────────────────────────────────

describe('file.read rotation', () => {
  function expectation(data: ReadData) {
    return { fileId: data.fileId, headHash: data.headHash, headBytes: data.headBytes };
  }

  it('notices a file rotated by rename and reads the new one from the start', async () => {
    await writeFile(join(root, 'auth.log'), 'old line 1\nold line 2\n');
    const first = await read({ path: 'auth.log' });

    await rename(join(root, 'auth.log'), join(root, 'auth.log.1'));
    await writeFile(join(root, 'auth.log'), 'new line\n');

    const { data } = await read({
      path: 'auth.log',
      offset: first.data.nextOffset,
      expect: expectation(first.data),
    });

    expect(data.rotated).toBe(true);
    expect(data.rotationReason).toBe('file-id');
    expect(data.fromOffset).toBe(0);
    expect(data.text).toBe('new line\n');
  });

  it('reads the remainder of the rotated file by its new name', async () => {
    await writeFile(join(root, 'auth.log'), 'a\n');
    const first = await read({ path: 'auth.log' });
    await appendFile(join(root, 'auth.log'), 'b\n');
    await rename(join(root, 'auth.log'), join(root, 'auth.log.1'));

    const { data } = await read({
      path: 'auth.log.1',
      offset: first.data.nextOffset,
      expect: expectation(first.data),
    });

    expect(data.rotated).toBe(false);
    expect(data.text).toBe('b\n');
  });

  it('notices a file truncated in place', async () => {
    await writeFile(join(root, 'app.log'), 'x'.repeat(99) + '\n');
    const first = await read({ path: 'app.log' });
    await truncate(join(root, 'app.log'), 0);
    await writeFile(join(root, 'app.log'), 'fresh\n');

    const { data } = await read({ path: 'app.log', offset: first.data.nextOffset });

    expect(data.rotated).toBe(true);
    expect(data.rotationReason).toBe('shrunk');
    expect(data.text).toBe('fresh\n');
  });

  it('notices a file whose head was replaced without changing its size', async () => {
    await writeFile(join(root, 'app.log'), 'AAAA\nBBBB\n');
    const first = await read({ path: 'app.log' });
    await writeFile(join(root, 'app.log'), 'CCCC\nDDDD\n');

    // Rewritten in place: same file id and size, different head.
    const { data } = await read({
      path: 'app.log',
      offset: first.data.nextOffset,
      expect: expectation(first.data),
    });

    expect(data.rotated).toBe(true);
    expect(data.rotationReason).toBe('head');
    expect(data.text).toBe('CCCC\nDDDD\n');
  });

  // A small file's head grows as it is written to; that is not a rotation.
  it('does not mistake a small growing file for a rotated one', async () => {
    await writeFile(join(root, 'app.log'), 'ab\n');
    const first = await read({ path: 'app.log' });
    await appendFile(join(root, 'app.log'), 'cd\n'.repeat(200));

    const { data } = await read({
      path: 'app.log',
      offset: first.data.nextOffset,
      expect: expectation(first.data),
    });

    expect(data.rotated).toBe(false);
    expect(data.fromOffset).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The corral
// ─────────────────────────────────────────────────────────────────────────────

describe('file.read corral', () => {
  it('refuses a traversal attempt', async () => {
    const { result } = await read({ path: '../secret.log' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the configured source root/);
  });

  it('refuses an absolute path', async () => {
    const { result } = await read({ path: join(outside, 'secret.log') });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be relative/);
  });

  it('refuses a symlink pointing out of the root, without leaking its content', async () => {
    await symlink(join(outside, 'secret.log'), join(root, 'link.log'));
    const { result } = await read({ path: 'link.log' });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TOP SECRET');
  });

  it('refuses key and environment files by name, in any root', async () => {
    await writeFile(join(root, 'server.key'), 'KEY\n');
    await writeFile(join(root, '.env'), 'PASSWORD=x\n');

    for (const path of ['server.key', '.env']) {
      const { result } = await read({ path });
      expect(result.success, path).toBe(false);
      expect(result.error).toMatch(/protected file pattern/);
    }
  });

  it('refuses a symlink whose target has a protected name', async () => {
    await writeFile(join(root, 'id_rsa'), 'KEY\n');
    await symlink(join(root, 'id_rsa'), join(root, 'innocent.log'));
    const { result } = await read({ path: 'innocent.log' });

    expect(result.success).toBe(false);
  });

  it('adds the configured patterns to the default ones', async () => {
    await writeFile(join(root, 'payroll.secret'), 'x\n');
    const { result } = await read({ path: 'payroll.secret' }, { denyPatterns: ['*.secret'] });

    expect(result.success).toBe(false);
  });

  it('refuses a binary file', async () => {
    await writeFile(join(root, 'core.dump'), Buffer.from([0x7f, 0x45, 0x00, 0x01]));
    const { result } = await read({ path: 'core.dump' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/binary/);
  });

  it('refuses a directory', async () => {
    await mkdir(join(root, 'sub'));
    const { result } = await read({ path: 'sub' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a regular file/);
  });

  it('reports a missing file without crashing', async () => {
    const { result } = await read({ path: 'nope.log' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no file found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input and build
// ─────────────────────────────────────────────────────────────────────────────

describe('file.read input and build', () => {
  it('lists the roots it knows when asked for an unknown one', async () => {
    const result = await tool().execute({ root: 'etc', path: 'passwd' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('logs');
  });

  it('refuses a negative offset', async () => {
    await writeFile(join(root, 'app.log'), 'x\n');
    const { result } = await read({ path: 'app.log', offset: -1 });

    expect(result.success).toBe(false);
  });

  it('refuses a malformed expectation', async () => {
    await writeFile(join(root, 'app.log'), 'x\n');
    const { result } = await read({ path: 'app.log', expect: { headHash: 'nope' } });

    expect(result.success).toBe(false);
  });

  it('marks results untrusted by default, and not when configured otherwise', async () => {
    await writeFile(join(root, 'app.log'), 'x\n');

    expect((await read({ path: 'app.log' })).result.untrusted).toBe(true);
    expect((await read({ path: 'app.log' }, { untrusted: false })).result.untrusted).toBe(false);
  });

  it('fails to build with no roots', () => {
    expect(() => createFileReadTool({ roots: [] }, ctx)).toThrow(ValidationError);
  });

  it('fails to build with duplicate root names', () => {
    expect(() =>
      createFileReadTool(
        {
          roots: [
            { name: 'a', path: root },
            { name: 'a', path: outside },
          ],
        },
        ctx,
      ),
    ).toThrow(/unique/);
  });

  it('fails to build with a byte cap too small to make progress', () => {
    expect(() => tool({ maxBytes: 4 })).toThrow(ValidationError);
  });

  it('publishes the root names as an enum', () => {
    const properties = tool().inputSchema['properties'] as { root: { enum: string[] } };
    expect(properties.root.enum).toEqual(['logs']);
  });
});
