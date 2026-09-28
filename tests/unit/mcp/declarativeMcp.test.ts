import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import { McpClient } from '../../../src/mcp/McpClient.js';
import { startTestMcpServer } from '../../fixtures/mcpServer.js';
import type { TestMcpServer } from '../../fixtures/mcpServer.js';
import type { DeepPartial, SDKConfig } from '../../../src/config/ConfigLoader.js';
import type { ExecutionContext } from '../../../src/types/index.js';

const CONTEXT: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['user'],
  sessionId: 's1',
  agentId: 'a1',
  requestId: 'r1',
};

const ECHO_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

/**
 * Wraps an in-process test server as an injectable client.
 *
 * The `custom` transport carries a factory function, and the config is
 * deep-cloned (so it must stay serialisable). In-process servers therefore
 * reach the Orchestrator through `overrides.mcpClients` — the same route a
 * production custom transport takes.
 */
function inject(name: string, server: TestMcpServer): Record<string, McpClient> {
  return { [name]: new McpClient(name, server.config) };
}

/** Minimal LLM section so the Orchestrator can be constructed. */
const LLM: DeepPartial<SDKConfig>['llm'] = {
  providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'x' } },
  defaultProvider: 'ollama',
};

describe('declarative MCP configuration', () => {
  it("auto-registers a server's tools and exposes the client on the Orchestrator", async () => {
    const server = await startTestMcpServer({
      tools: [
        { name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('contents') },
        { name: 'write_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('written') },
      ],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: {
          servers: { files: { transport: 'stdio', command: 'ignored', autoRegisterTools: true } },
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    expect(orch.toolRegistry.list()).toEqual(['files.read_file', 'files.write_file']);
    expect(orch.listMcpServers()).toEqual(['files']);
    expect(orch.getMcpClient('files')).toBeDefined();
    expect(orch.getMcpClient('nope')).toBeUndefined();

    await orch.shutdown();
    await server.close();
  });

  it('registers a single tool from a kind:"mcp" definition', async () => {
    const server = await startTestMcpServer({
      tools: [
        { name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('contents') },
        { name: 'delete_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('gone') },
      ],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        tools: {
          definitions: [
            {
              kind: 'mcp',
              name: 'docs.read',
              server: 'files',
              remoteName: 'read_file',
              tags: ['docs', 'readonly'],
              requiresApproval: false,
            },
          ],
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    // Only the declared tool is registered — `delete_file` stays unreachable.
    expect(orch.toolRegistry.list()).toEqual(['docs.read']);

    const tool = orch.toolRegistry.get('docs.read')!;
    expect(tool.tags).toEqual(['docs', 'readonly']);
    expect(tool.requiresApproval).toBe(false);
    // The remote input schema came across, so validation still applies.
    expect(tool.inputSchema).toMatchObject({ required: ['message'] });

    const result = await tool.execute({ message: 'x' }, CONTEXT);
    expect(result).toEqual({ success: true, data: 'contents' });

    await orch.shutdown();
    await server.close();
  });

  it('lets an explicit definition override an auto-registered tool', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: {
          servers: { files: { transport: 'stdio', command: 'ignored', autoRegisterTools: true } },
        },
        tools: {
          definitions: [
            {
              kind: 'mcp',
              name: 'files.read_file',
              server: 'files',
              remoteName: 'read_file',
              tags: ['overridden'],
            },
          ],
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    expect(orch.toolRegistry.get('files.read_file')!.tags).toEqual(['overridden']);

    await orch.shutdown();
    await server.close();
  });

  it('resolves a declarative skill that references an MCP tool', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        tools: {
          definitions: [
            { kind: 'mcp', name: 'files.read', server: 'files', remoteName: 'read_file' },
          ],
        },
        skills: [{ name: 'documents', description: 'Read documents', tools: ['files.read'] }],
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    const skill = orch.skillRegistry.get('documents');
    expect(skill!.tools.map((t) => t.name)).toEqual(['files.read']);

    await orch.shutdown();
    await server.close();
  });

  it('closes MCP clients on shutdown, including injected ones', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: {
          servers: { files: { transport: 'stdio', command: 'ignored', autoRegisterTools: true } },
        },
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    const client = orch.getMcpClient('files')!;
    expect(client.connected).toBe(true);

    await orch.shutdown();

    expect(client.connected).toBe(false);
    await server.close();
  });

  it('fails startup when a tool references an unknown server', async () => {
    await expect(
      Orchestrator.create({
        llm: LLM,
        tools: {
          definitions: [{ kind: 'mcp', name: 'x', server: 'ghost', remoteName: 'read_file' }],
        },
      } as DeepPartial<SDKConfig>),
    ).rejects.toThrow(/unknown MCP server 'ghost'/);
  });

  it('fails startup when the remote tool does not exist', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });

    await expect(
      Orchestrator.create(
        {
          llm: LLM,
          tools: {
            definitions: [{ kind: 'mcp', name: 'x', server: 'files', remoteName: 'nonexistent' }],
          },
        } as DeepPartial<SDKConfig>,
        { mcpClients: inject('files', server) },
      ),
    ).rejects.toThrow(/Available tools: read_file/);

    await server.close();
  });

  it('opens no connection for a server whose tools are never declared', async () => {
    const server = await startTestMcpServer({
      tools: [{ name: 'read_file', inputSchema: ECHO_SCHEMA, handler: () => textResult('ok') }],
    });

    const orch = await Orchestrator.create(
      {
        llm: LLM,
        mcp: { servers: { files: { transport: 'stdio', command: 'ignored' } } },
      } as DeepPartial<SDKConfig>,
      { mcpClients: inject('files', server) },
    );

    // Lazy by design: startup stays fast when a server is declared but unused.
    expect(server.connectCount).toBe(0);
    expect(orch.getMcpClient('files')!.connected).toBe(false);

    await orch.shutdown();
    await server.close();
  });
});

describe('MCP config validation', () => {
  const base = { llm: LLM } as DeepPartial<SDKConfig>;

  /** Runs the merge + validation pipeline without constructing an Orchestrator. */
  function validate(mcp: unknown, tools?: unknown): void {
    ConfigLoader.from({
      ...base,
      mcp,
      ...(tools !== undefined && { tools }),
    } as DeepPartial<SDKConfig>);
  }

  it('rejects an unknown transport', () => {
    expect(() => validate({ servers: { x: { transport: 'carrier-pigeon' } } })).toThrow(
      ConfigError,
    );
  });

  it('rejects a custom transport, pointing at the injection escape hatch', () => {
    expect(() => validate({ servers: { x: { transport: 'custom' } } })).toThrow(
      /OrchestratorOverrides.mcpClients/,
    );
  });

  it('requires command for stdio and url for http', () => {
    expect(() => validate({ servers: { x: { transport: 'stdio' } } })).toThrow(
      /command is required/,
    );
    expect(() => validate({ servers: { x: { transport: 'http' } } })).toThrow(/url is required/);
  });

  it('rejects a malformed http url', () => {
    expect(() => validate({ servers: { x: { transport: 'http', url: 'not-a-url' } } })).toThrow(
      /not a valid URL/,
    );
  });

  it('requires server and remoteName on a kind:"mcp" tool definition', () => {
    const servers = { servers: { files: { transport: 'stdio', command: 'x' } } };

    expect(() =>
      validate(servers, { definitions: [{ kind: 'mcp', name: 'a', server: 'files' }] }),
    ).toThrow(/remoteName is required/);
    expect(() =>
      validate(servers, { definitions: [{ kind: 'mcp', name: 'a', remoteName: 'r' }] }),
    ).toThrow(/server is required/);
  });

  it('accepts a well-formed stdio declaration', () => {
    expect(() =>
      validate({
        servers: {
          files: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
            autoRegisterTools: true,
          },
        },
      }),
    ).not.toThrow();
  });

  describe('allowedCommands', () => {
    const stdio = (command: string): unknown => ({
      servers: { files: { transport: 'stdio', command } },
    });

    it('rejects a command outside the allowlist', () => {
      expect(() =>
        validate({ ...(stdio('curl') as object), allowedCommands: ['/opt/erp/mcp-server'] }),
      ).toThrow(/'curl' is not in mcp.allowedCommands/);
    });

    it('accepts a command on the allowlist', () => {
      expect(() =>
        validate({
          ...(stdio('/opt/erp/mcp-server') as object),
          allowedCommands: ['/opt/erp/mcp-server'],
        }),
      ).not.toThrow();
    });

    it('matches exactly — a bare name does not cover an absolute path', () => {
      expect(() =>
        validate({ ...(stdio('/usr/bin/npx') as object), allowedCommands: ['npx'] }),
      ).toThrow(/is not in mcp.allowedCommands/);
    });

    it('allows any command when the allowlist is omitted', () => {
      expect(() => validate(stdio('anything'))).not.toThrow();
    });

    it('rejects every command when the allowlist is empty', () => {
      expect(() => validate({ ...(stdio('npx') as object), allowedCommands: [] })).toThrow(
        /Allowed: \(none\)/,
      );
    });

    it('does not constrain http servers', () => {
      expect(() =>
        validate({
          servers: { s: { transport: 'http', url: 'https://h/mcp' } },
          allowedCommands: ['nothing'],
        }),
      ).not.toThrow();
    });
  });

  it('accepts a well-formed http declaration', () => {
    expect(() =>
      validate({
        servers: {
          search: {
            transport: 'http',
            url: 'https://mcp.internal.corp/mcp',
            headers: { Authorization: 'Bearer x' },
          },
        },
      }),
    ).not.toThrow();
  });
});
