# Agents, tools and skills

The core model has three parts. **Tools** do things. **Skills** group tools
and tell the model when to use them. **Agents** declare which skills they may
use, and that list is the whole of what they can do.

## Tools

A `Tool` is a descriptor the model sees (`name`, `description`, `inputSchema`)
plus an `execute` function it never sees.

```ts
import type { Tool, ToolResult } from 'agent349';

export const createTicket: Tool = {
  name: 'helpdesk.createTicket', // prefer namespace.action
  description: 'Opens a helpdesk ticket and returns its number.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 200 },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    },
    required: ['title'],
  },
  sideEffects: true, // acts on the outside world (used by provenance tracking)
  timeout: 10_000,
  retryPolicy: { maxRetries: 2, backoffMs: 500, backoffMultiplier: 2 },
  execute: async (input: { title: string; priority?: string }, context): Promise<ToolResult> => {
    // `context` carries tenantId, userId, roles, sessionId, requestId.
    const number = `HD-${Date.now()}`;
    return { success: true, data: { number, openedBy: context.userId, ...input } };
  },
};
```

What the executor does around `execute`:

- **Validates** the model's input against `inputSchema` (JSON Schema, via AJV).
  Invalid input comes back to the model as a failed result so it can correct
  itself.
- Applies the **timeout** and the **retry policy**.
- Emits `tool.call.start` / `tool.call.end`, which the audit trail and logs are
  built from.
- Returns failures as `{ success: false, error }` instead of throwing, so one
  failing tool does not abort the conversation.

Useful descriptor fields:

| Field              | Effect                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `requiresApproval` | Metadata only. It does **not** gate execution by itself: approvals are enforced by [approval triggers](human-in-the-loop.md) |
| `sideEffects`      | Marks tools that act externally; used by untrusted-content tracking                                                          |
| `tags`             | Free-form labels for filtering (`ToolRegistry.getDescriptors({ tags })`)                                                     |
| `outputSchema`     | Documents the result shape                                                                                                   |

### Calling a tool from your own code

`orch.executeTool(name, input, context)` runs a registered tool through the
same executor (validation, timeout, retries, events and audit) without going
through the model. Use it when the application, not the agent, decides to run
an operation.

## Skills

```ts
import { createTicket } from './tools.js';
import type { Skill } from 'agent349';

export const helpdesk: Skill = {
  name: 'helpdesk',
  description: 'Helpdesk operations',
  tools: [createTicket],
  systemPromptAddition: 'Open a ticket only after confirming the title with the user.',
};
```

When a skill is active, its `systemPromptAddition` is appended to the agent's
system prompt. Role restrictions on skills are enforced by the `ACLService`
(`resourceType: 'skill'`), see [Security](security.md).

## Agents

An agent is plain, serializable configuration:

```ts
import type { AgentConfig } from 'agent349';

export const supportAgent: AgentConfig = {
  id: 'support',
  name: 'Support assistant',
  systemPrompt: 'You help employees with IT issues. Be brief.',
  skills: ['helpdesk'],
  llmConfig: {
    provider: 'claude', // a provider instance name from llm.providers
    model: 'claude-opus-5',
    temperature: 0.2,
    maxTokens: 2048,
    fallbackProvider: 'openai', // tried if the primary fails or its circuit is open
    fallbackModel: 'gpt-6-sol',
  },
  memoryStrategy: { type: 'sliding_window', maxMessages: 20 },
  maxLoopIterations: 8,
};
```

`llmConfig` is optional. Provider and model resolve in this order:
`agent.llmConfig` → `llm.defaultProvider` / `llm.defaultModel` →
`llm.providers[provider].defaultModel`.

`maxLoopIterations` (default 10) bounds how many model ⇄ tool rounds one turn
may take.

`usePlanner: true` makes the agent first ask the model for a structured plan
(`response.plan`). If the plan is flagged as needing approval (financial,
destructive or outbound steps), the turn stops before any tool runs and returns
the plan for review.

## Running agents

```ts
import { Orchestrator } from 'agent349';
import { helpdesk } from './skills.js';
import { supportAgent } from './agents.js';

const orch = await Orchestrator.create('./agent349.config.json');
for (const tool of helpdesk.tools) orch.registerTool(tool);
orch.registerSkill(helpdesk);
orch.registerAgent(supportAgent);

const identity = { tenantId: 'acme', userId: 'ana', roles: ['employee'] };

// A new session is created when no sessionId is given…
const first = await orch.chat('support', 'My laptop will not boot.', identity);

// …pass one to continue the same conversation.
const followUp = await orch.chat('support', 'Please open a ticket.', identity, {
  sessionId: 'support-ana-1',
});

console.log(first.content, followUp.toolsUsed, followUp.usage.totalCostUsd);
```

`AgentResponse` carries `content`, `toolsUsed`, `iterations`, `usage` (tokens
and cost, per iteration), `durationMs`, and for approvals `suspended` and
`pendingActions`.

### Streaming and cancellation

```ts
const controller = new AbortController();

const response = await orch.chat('support', 'Summarize my open tickets.', identity, {
  stream: true,
  signal: controller.signal,
  onEvent: (event) => {
    if (event.type === 'llm.token') process.stdout.write(String(event.data['delta']));
  },
});
```

`onEvent` receives every event of the run (`tool.call.*`, `llm.call.*`,
`security.*`…), which is also the simplest way to drive a progress UI.

### Stateless mode

If your application already stores the conversation, pass it as
`externalContext` and the SDK will not load or save session memory:

```ts
const response = await orch.chat('support', 'And the second one?', identity, {
  externalContext: [
    { role: 'user', content: 'List my tickets.' },
    { role: 'assistant', content: 'You have HD-1 and HD-2.' },
  ],
});
```

## Declaring tools, skills and agents in configuration

Everything above can also be declared in `agent349.config.json`, next to
code-registered components (last registration wins):

```json config
{
  "appHome": "./dist",
  "tools": {
    "moduleRoots": ["./dist"],
    "loadMode": "strict",
    "definitions": [
      {
        "name": "helpdesk.createTicket",
        "kind": "module",
        "module": "./tools/helpdesk.js",
        "export": "createTicketTool",
        "config": { "queue": "it" }
      },
      {
        "name": "rag.search",
        "kind": "internal",
        "ref": "rag.search",
        "config": { "collections": ["it-kb"], "topK": 8 }
      }
    ]
  },
  "skills": [
    {
      "name": "helpdesk",
      "description": "Helpdesk",
      "tools": ["helpdesk.createTicket", "rag.search"]
    }
  ],
  "agents": [
    {
      "id": "support",
      "name": "Support",
      "systemPrompt": "You help with IT issues.",
      "skills": ["helpdesk"]
    }
  ]
}
```

- `kind: "module"` loads a **named export** from your code: either a `Tool` or
  a factory `(config) => Tool`. Bare specifiers resolve as packages. Relative
  paths resolve against `appHome`, then the config file's directory, then the
  working directory.
- `moduleRoots` restricts where modules may be loaded from. `loadMode:
"tolerant"` skips a tool that fails to load and emits
  `config.tool.load.error` instead of failing startup.
- `kind: "internal"` references a tool the SDK provides: `rag.search`, the
  [integration tools](integration-tools.md) (`sql.query`, `http.request`, …)
  and, with `kind: "mcp"`, tools from [MCP servers](mcp.md).

## Lower level: `AgentLoop`

`Orchestrator` builds an `AgentLoop` per call. You can build one yourself when
you need full control over its dependencies (memory manager, token tracker,
security chain, ACL, approval service, planner). The orchestrator is the
recommended API: it also handles provider resolution, sessions, fallback and
the second phase of approvals.
