# Getting started

This guide takes you from an empty directory to a governed agent: an LLM that
calls your tools, under a role-based access policy, with every step recorded in
an audit trail.

## Requirements

- Node.js 20 or later
- An ES module project (`"type": "module"` in `package.json`)
- An API key for at least one provider (Anthropic, OpenAI, Google Gemini), or a
  local [Ollama](https://ollama.com) server. You can also start with no key at
  all: see [Run the example without an API key](#run-the-example-without-an-api-key).

## Install

```bash
npm install agent349
```

Agent349 is TypeScript-first and ships its own type declarations. To run
TypeScript files directly during development:

```bash
npm install -D typescript tsx @types/node
```

Integrations with external infrastructure are **optional dependencies**,
installed only if you use them: `ioredis` (Redis storage), `mongodb` (Mongo
storage, audit and approvals), `@modelcontextprotocol/sdk` (MCP servers), and
`pg`, `mysql2`, `mssql`, `oracledb` (SQL tools). If one is missing, the SDK
fails with a message naming the package to install.

## Your first agent

```ts
import { Orchestrator } from 'agent349';

// Reads ANTHROPIC_API_KEY from the environment. Everything else uses defaults:
// in-memory sessions, memory and token accounting.
const orch = await Orchestrator.create({});

orch.registerAgent({
  id: 'assistant',
  name: 'Assistant',
  systemPrompt: 'You are a concise, helpful assistant.',
  skills: [],
});

const response = await orch.chat('assistant', 'What is the capital of France?', {
  tenantId: 'acme',
  userId: 'ana',
  roles: [],
});

console.log(response.content);
console.log('tokens:', response.usage.totalInputTokens + response.usage.totalOutputTokens);

await orch.shutdown();
```

`chat()` always takes the caller's **identity** — tenant, user and roles. That
identity travels with the request through tools, access control, memory, token
accounting and audit. It is what makes the rest of the SDK work.

## Add a tool

A tool is a plain object: a name, a description, a JSON Schema for its input,
and an async `execute`. Tools are grouped into **skills**, and an agent declares
the skills it may use.

```ts
import { Orchestrator } from 'agent349';
import type { Tool } from 'agent349';

const getBalance: Tool = {
  name: 'accounts.getBalance',
  description: 'Returns the current balance of an account.',
  inputSchema: {
    type: 'object',
    properties: { accountId: { type: 'string' } },
    required: ['accountId'],
  },
  execute: async ({ accountId }: { accountId: string }) => ({
    success: true,
    data: { accountId, balance: 12_500, currency: 'USD' },
  }),
};

const orch = await Orchestrator.create({});
orch.registerTool(getBalance);
orch.registerSkill({ name: 'banking', description: 'Account queries', tools: [getBalance] });
orch.registerAgent({
  id: 'banking-assistant',
  name: 'Banking assistant',
  systemPrompt: 'Answer account questions using the tools.',
  skills: ['banking'],
});

const r = await orch.chat('banking-assistant', 'What is the balance of ACC-1?', {
  tenantId: 'acme',
  userId: 'ana',
  roles: ['analyst'],
});
console.log(r.content, r.toolsUsed); // [...] [ 'accounts.getBalance' ]
```

The model's tool input is validated against `inputSchema` before `execute`
runs. Tool calls get timeouts, retries and events for free.

## Govern it

Access control is registered once and applies to every `chat()`:

```ts
import { ACLService, SecurityMiddlewareChain, ToolACLMiddleware } from 'agent349';

const acl = new ACLService({
  policies: [
    { resourceType: 'tool', resourceId: 'accounts.getBalance', allowedRoles: ['analyst'] },
    { resourceType: 'tool', resourceId: 'payments.transfer', allowedRoles: ['treasurer'] },
  ],
});

// Tools the caller may not use are removed before the model sees them...
orch.registerACLService(acl);

// ...and every tool call is re-checked right before it executes.
const chain = new SecurityMiddlewareChain(orch.events);
chain.use(new ToolACLMiddleware(acl));
orch.registerSecurityChain(chain);
```

Turn on the audit trail with one config key:

```ts
import { Orchestrator } from 'agent349';

const orch = await Orchestrator.create({ audit: { enabled: true } });
// ... run agents ...
await orch.audit!.flush();
const { records } = await orch.audit!.query({
  tenantId: 'acme',
  category: ['tool', 'security'],
  dateRange: { from: new Date(Date.now() - 3_600_000), to: new Date() },
});
```

## Run the example without an API key

The repository contains a complete, runnable version of this guide:
[`examples/quickstart.ts`](../examples/quickstart.ts). Two users ask the same
agent to make a transfer. The ACL lets only one of them do it, and the audit
trail records both the transfer and the denial.

```bash
git clone https://github.com/agent-349/agent349.git
cd agent349
npm install
npm run example:quickstart
```

```text
analyst   → Tool result: {"error":"ACCESS_DENIED","message":"Required roles: [treasurer], user has: [analyst]"} | tools used: []
treasurer → Tool result: {"from":"ACC-1","to":"ACC-2","amount":500,"status":"completed"} | tools used: [ 'payments.transfer' ]

Audit trail:
  tom  tool/call_end                      success
  tom  tool/call_start                    success
  ana  security/access_denied             blocked
```

Without `ANTHROPIC_API_KEY` the example uses a small scripted model, so it runs
offline and deterministically. With the key set, it talks to Claude. The
governance layer is the same code either way.

## Choose a model provider

`Orchestrator.create({})` preconfigures four provider instances whose keys come
from the environment: `claude` (`ANTHROPIC_API_KEY`, the default), `openai`
(`OPENAI_API_KEY`), `gemini` (`GEMINI_API_KEY`) and `ollama`
(`http://localhost:11434`, no key needed). A keyed provider is created only when
its key is set, so you export the one you use.

Pick the default provider and model explicitly in production:

```json config
{
  "llm": {
    "defaultProvider": "openai",
    "providers": {
      "openai": { "apiKey": "${OPENAI_API_KEY}", "defaultModel": "gpt-6-sol" }
    }
  }
}
```

Save that as `agent349.config.json` and load it with
`Orchestrator.create('./agent349.config.json')`. `${VAR}` placeholders are
resolved from the environment at load time, so secrets never live in the file.
An unset variable resolves to an empty string.
See [LLM providers](guides/llm-providers.md) and
[Configuration](configuration.md).

## Next steps

- [Architecture](architecture.md): how the pieces fit together.
- [Agents, tools and skills](guides/agents-tools-skills.md): the core model in depth.
- [Security and access control](guides/security.md): the full security pipeline.
- [Examples](../examples/): runnable examples for audit, logging, token accounting and integration tools.
