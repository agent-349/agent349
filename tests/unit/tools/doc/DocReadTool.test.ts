import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocReadTool } from '../../../../src/tools/builtin/doc/DocReadTool.js';
import { DocumentStore } from '../../../../src/tools/builtin/doc/DocumentStore.js';
import type { FetchedDocument } from '../../../../src/tools/builtin/doc/DocumentStore.js';
import { selectPages } from '../../../../src/tools/builtin/doc/extract.js';
import { AccessDeniedError, ValidationError } from '../../../../src/errors/index.js';
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

let root: string;
let outside: string;
let ctx: InternalToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent349-doc-'));
  outside = await mkdtemp(join(tmpdir(), 'agent349-out-'));

  await writeFile(join(root, 'notes.txt'), 'Quarterly numbers look good.');
  await writeFile(
    join(root, 'page.html'),
    '<html><title>T</title><body><p>Body text</p></body></html>',
  );
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'deep.txt'), 'deep content');
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');

  ctx = { emit: vi.fn() } as unknown as InternalToolContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function tool(overrides: Record<string, unknown> = {}) {
  return createDocReadTool(
    { name: 'doc.read', sources: [{ name: 'docs', kind: 'fs', root }], ...overrides },
    ctx,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

describe('doc.read', () => {
  it('reads a text file from the configured root', async () => {
    const result = await tool().execute({ source: 'docs', ref: 'notes.txt' }, CTX);

    expect(result.success).toBe(true);
    expect((result.data as { text: string }).text).toContain('Quarterly numbers');
  });

  it('reads a nested file', async () => {
    const result = await tool().execute({ source: 'docs', ref: 'sub/deep.txt' }, CTX);
    expect((result.data as { text: string }).text).toBe('deep content');
  });

  it('strips markup from HTML and keeps the title', async () => {
    const result = await tool().execute({ source: 'docs', ref: 'page.html' }, CTX);
    const data = result.data as { text: string; title?: string };

    expect(data.text).toContain('Body text');
    expect(data.text).not.toContain('<p>');
    expect(data.title).toBe('T');
  });

  it('lists the sources it knows when asked for an unknown one', async () => {
    const result = await tool().execute({ source: 'nope', ref: 'x' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('docs');
  });

  it('reports a missing file without crashing', async () => {
    const result = await tool().execute({ source: 'docs', ref: 'ghost.txt' }, CTX);
    expect(result.success).toBe(false);
  });

  it('truncates a long document and suggests reading it in parts', async () => {
    await writeFile(join(root, 'long.txt'), 'x'.repeat(5000));
    const result = await tool({ maxChars: 100 }).execute({ source: 'docs', ref: 'long.txt' }, CTX);
    const data = result.data as { text: string; truncated?: boolean; notice?: string };

    expect(data.text).toHaveLength(100);
    expect(data.truncated).toBe(true);
    expect(data.notice).toMatch(/page range/i);
  });

  // Reading a whole corpus through this tool is the wrong shape; the message
  // says what to do instead.
  it('refuses a document over the byte cap and points at RAG', async () => {
    await writeFile(join(root, 'huge.txt'), 'x'.repeat(2000));
    const result = await tool({ maxBytes: 100 }).execute({ source: 'docs', ref: 'huge.txt' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/knowledge base/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Staying inside the root
// ─────────────────────────────────────────────────────────────────────────────

describe('doc.read path containment', () => {
  it('refuses a traversal attempt', async () => {
    const result = await tool().execute({ source: 'docs', ref: '../../etc/passwd' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the configured source root/);
  });

  it('refuses an absolute path', async () => {
    const result = await tool().execute({ source: 'docs', ref: join(outside, 'secret.txt') }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be relative/);
  });

  // The case that makes rejecting '..' insufficient on its own: the textual
  // path stays inside the root, and only resolving the link reveals otherwise.
  it('refuses a symlink pointing out of the root', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const result = await tool().execute({ source: 'docs', ref: 'escape.txt' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('TOP SECRET');
  });

  it('refuses a reference containing a null byte', async () => {
    const result = await tool().execute({ source: 'docs', ref: 'notes.txt\0.png' }, CTX);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injected stores
// ─────────────────────────────────────────────────────────────────────────────

describe('doc.read injected stores', () => {
  class HostStore extends DocumentStore {
    override readonly name = 'attachments';
    seenUser: string | null = null;

    override async fetch(ref: string, context: ExecutionContext): Promise<FetchedDocument> {
      this.seenUser = context.userId;
      if (ref === 'forbidden') {
        throw new AccessDeniedError('document', ref, context.roles);
      }
      return {
        bytes: Buffer.from('from the host store'),
        mimeType: 'text/plain',
        fileName: ref,
      };
    }
  }

  it('reads through a host-injected store', async () => {
    const store = new HostStore();
    const local = { ...ctx, documentStores: { attachments: store } };
    const built = createDocReadTool(
      { sources: [{ name: 'attachments', kind: 'store' }] },
      local as InternalToolContext,
    );

    const result = await built.execute({ source: 'attachments', ref: 'a1' }, CTX);
    expect((result.data as { text: string }).text).toBe('from the host store');
  });

  // The reason the store receives the context at all: so the host can apply
  // its own access control before handing over any bytes.
  it('passes the execution context to the store', async () => {
    const store = new HostStore();
    const local = { ...ctx, documentStores: { attachments: store } };
    const built = createDocReadTool(
      { sources: [{ name: 'attachments', kind: 'store' }] },
      local as InternalToolContext,
    );

    await built.execute({ source: 'attachments', ref: 'a1' }, CTX);
    expect(store.seenUser).toBe('u1');
  });

  it("surfaces the store's refusal as a failed result", async () => {
    const local = { ...ctx, documentStores: { attachments: new HostStore() } };
    const built = createDocReadTool(
      { sources: [{ name: 'attachments', kind: 'store' }] },
      local as InternalToolContext,
    );

    const result = await built.execute({ source: 'attachments', ref: 'forbidden' }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Access denied/);
  });

  it('fails to build when the declared store was not injected', () => {
    expect(() => createDocReadTool({ sources: [{ name: 'ghost', kind: 'store' }] }, ctx)).toThrow(
      /documentStores/,
    );
  });

  it('fails to build with no sources at all', () => {
    expect(() => createDocReadTool({ sources: [] }, ctx)).toThrow(ValidationError);
  });

  it('fails to build a filesystem source with no root', () => {
    expect(() => createDocReadTool({ sources: [{ name: 'x', kind: 'fs' }] }, ctx)).toThrow(
      /needs a root/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Page ranges
// ─────────────────────────────────────────────────────────────────────────────

describe('selectPages', () => {
  const paged = ['one', 'two', 'three', 'four'].join('\f');

  it('returns everything when no range is given', () => {
    expect(selectPages(paged).applied).toBe(false);
  });

  it('selects a single page', () => {
    expect(selectPages(paged, '2').text).toBe('two');
  });

  it('selects a range', () => {
    expect(selectPages(paged, '2-3').text).toBe('two\n\nthree');
  });

  it('reports the total page count', () => {
    expect(selectPages(paged, '1').totalPages).toBe(4);
  });

  // A document with no page breaks should return its text, not nothing.
  it('ignores a range on a document with no pages', () => {
    const result = selectPages('flat text', '2-3');
    expect(result.applied).toBe(false);
    expect(result.text).toBe('flat text');
  });

  it('ignores a malformed range', () => {
    expect(selectPages(paged, 'abc').applied).toBe(false);
  });
});
