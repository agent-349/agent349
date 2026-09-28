# MCP servers

Agent349 is a [Model Context Protocol](https://modelcontextprotocol.io) **client**.
It connects to MCP servers (file systems, databases, internal or third-party
services) and exposes their tools to agents as ordinary tools. It does not
implement the server side.

A bridged MCP tool goes through the same pipeline as any other tool: input
validation, timeout, retries, `tool.call.*` events, the security chain,
approvals and audit. Agents cannot tell the difference.

## Install

MCP support is an optional dependency:

```bash
npm install @modelcontextprotocol/sdk
```

## Declare servers

```json config
{
  "mcp": {
    "allowedCommands": ["npx"],
    "servers": {
      "files": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared-docs"],
        "namespace": "files",
        "autoRegisterTools": false,
        "toolTimeoutMs": 15000
      },
      "crm": {
        "transport": "http",
        "url": "https://mcp.crm.example.com/mcp",
        "headers": { "Authorization": "Bearer ${CRM_MCP_TOKEN}" }
      }
    }
  },
  "tools": {
    "definitions": [
      { "kind": "mcp", "name": "docs.read", "server": "files", "remoteName": "read_file" }
    ]
  }
}
```

- **Explicit mode** (recommended in production): list the remote tools you
  want under `tools.definitions` with `kind: "mcp"`. Only those are exposed,
  under names you choose.
- **Automatic mode**: `autoRegisterTools: true` registers every tool the server
  lists, prefixed with `namespace.`.
- Connections are lazy. The server's catalog is a snapshot, so call
  `orch.refreshMcpTools(serverName)` to re-sync after the server changes.
- `allowedCommands` restricts which executables `stdio` servers may launch.
- `transport: "custom"` (a transport object you construct) is available from code.

## Security

An MCP server is code and content you may not control. Treat it accordingly:

- Its tool descriptions and results reach the model verbatim and can carry
  prompt injection. Scope servers narrowly and prefer explicit mode.
- `requiresApproval` on a server or tool is metadata. To actually hold MCP calls
  for a human, add an [approval trigger](human-in-the-loop.md) whose scope
  matches the tool names (a namespace prefix covers a whole server).
- ACL policies, data filters and masking apply to MCP tools by name, like any
  other tool.
- The caller's `ExecutionContext` is **not** sent to the server.
- A `stdio` server is a child process with the permissions of your application.

For transports, result mapping, error types and the full configuration
reference, see the Spanish [MCP manual](../es/MCP_MANUAL.md).
