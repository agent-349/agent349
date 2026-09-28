# Memory and sessions

Agent349 keeps three kinds of memory, each answering a different question:

| Level            | Question                            | Scope                     | Where               |
| ---------------- | ----------------------------------- | ------------------------- | ------------------- |
| Session memory   | What was said in this conversation? | One session               | `memory.session`    |
| Long-term memory | What do we know about this user?    | One user, across sessions | `memory.longTerm`   |
| Knowledge (RAG)  | What does the organization know?    | Collections               | [Retrieval](rag.md) |

## Storage backends

Sessions, memory and token accounting are stored through a `StorageAdapter`.
Declare named backends once and point each layer at one:

```json config
{
  "storage": {
    "backends": {
      "local": { "type": "memory" },
      "shared": { "type": "redis", "url": "${REDIS_URL}", "keyPrefix": "agent349:" }
    }
  },
  "memory": {
    "session": {
      "backend": "shared",
      "strategy": "sliding_window",
      "ttlSeconds": 3600,
      "maxMessagesBeforeCompress": 20
    },
    "longTerm": { "backend": "shared", "maxFactsPerUser": 50 }
  },
  "session": { "backend": "shared" },
  "tokens": { "backend": "shared" }
}
```

Built-in adapters are `memory` (default, per process), `redis` (`ioredis`) and
`mongo` (`mongodb`, requires `collection`). Keys are namespaced, so one backend
can serve every layer. For your own store, extend `StorageAdapter` and pass it
through `Orchestrator.fromConfig(config, { storage: { … } })` or a
`storageRegistry`.

With more than one process, use a shared backend. See [Deployment](deployment.md).

## Sessions

`chat()` creates a session when you do not pass `sessionId`. Pass the same
`sessionId` to continue a conversation:

```ts
const r1 = await orch.chat('assistant', 'My name is Ana.', identity, { sessionId: 's-42' });
const r2 = await orch.chat('assistant', 'What is my name?', identity, { sessionId: 's-42' });

const active = await orch.sessions.listActive('acme', 'ana');
await orch.sessions.close('s-42');
```

Session history expires after `ttlSeconds` without activity. It is stored per
session ID, so derive session IDs from the authenticated user rather than
accepting them from clients unchecked.

### Compression strategies

When history exceeds `maxMessagesBeforeCompress`:

- **`sliding_window`** keeps the most recent messages. No extra cost.
- **`incremental_summary`** asks the model to summarize older messages before
  dropping them. It preserves more meaning, at the cost of extra latency and
  tokens.

Agents can override the strategy:

```ts
orch.registerAgent({
  id: 'legal-analyst',
  name: 'Legal analyst',
  systemPrompt: 'You review contracts.',
  skills: [],
  memoryStrategy: { type: 'incremental_summary', maxMessages: 50, summaryThreshold: 40 },
});
```

By default, inline images and documents are **not persisted** in session
history (`memory.session.mediaPersistence: "omit"`). They are replaced by an
explicit `media_omitted` placeholder, and on later turns the model is told the
file is no longer available. References to files uploaded to the provider are
kept. Set `"full"` only if your store is sized for binary content. See the
[multimodal manual](../es/MULTIMODAL_MANUAL.md).

### Stateless mode

If your application owns the conversation history, pass it as
`externalContext` and nothing is loaded from or saved to session memory. See
[Agents, tools and skills](agents-tools-skills.md#stateless-mode).

## Long-term memory

Long-term facts are **written by your application**, never captured
automatically, and injected into the prompt when you pass them in
`userContext`:

```ts
await orch.memory.saveLongTermFact('acme', 'ana', 'Prefers answers as tables');
await orch.memory.saveLongTermFact('acme', 'ana', 'Works in the finance department');

const facts = await orch.memory.getLongTermContext('acme', 'ana');

const response = await orch.chat('assistant', 'Show the Q3 budget.', identity, {
  userContext: { tenantId: 'acme', userId: 'ana', roles: ['analyst'], longTermFacts: facts },
});
```

Facts have no TTL. When `maxFactsPerUser` is reached, the oldest facts are
evicted first. Store preferences and stable context here, never secrets or
data the user has not agreed to keep.

For guidance on what belongs in each level, see the Spanish
[memory manual](../es/MEMORY_MANUAL.md).
