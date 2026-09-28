# Configuration

An orchestrator is created from a JSON file or an object with the same shape:

```ts
import { Orchestrator } from 'agent349';

const fromFile = await Orchestrator.create('./agent349.config.json');
const fromObject = await Orchestrator.create({ audit: { enabled: true } });
```

Your configuration is merged over the built-in defaults, so every section is
optional. `${ENV_VAR}` placeholders are resolved from the environment when the
configuration is loaded, and an unset variable becomes an empty string. Keep
secrets in the environment or a secret manager, never in the file.

Programmatic overrides that JSON cannot express (injected adapters, loggers,
custom LLM adapter types, credential providers, pre-opened connections) are
passed as the second argument:
`Orchestrator.create(config, overrides)` or
`Orchestrator.fromConfig(resolvedConfig, overrides)`.

## Sections

| Section                      | Purpose                                                                                  | Guide                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `llm`                        | Provider instances, default provider and model, circuit breaker                          | [LLM providers](guides/llm-providers.md)                  |
| `storage`                    | Named storage backends (`memory`, `redis`, `mongo`)                                      | [Memory and sessions](guides/memory-and-sessions.md)      |
| `memory`                     | Session memory strategy, TTL, media persistence, long-term facts                         | [Memory and sessions](guides/memory-and-sessions.md)      |
| `session`                    | Session store backend                                                                    | [Memory and sessions](guides/memory-and-sessions.md)      |
| `agent`                      | Defaults for all agents: iterations, temperature, max tokens                             | [Agents, tools and skills](guides/agents-tools-skills.md) |
| `tools`                      | Timeouts, retries, result limits, declarative tool definitions                           | [Agents, tools and skills](guides/agents-tools-skills.md) |
| `skills`, `agents`           | Declarative skills and agents                                                            | [Agents, tools and skills](guides/agents-tools-skills.md) |
| `connections`, `credentials` | Databases and APIs used by integration tools                                             | [Integration tools](guides/integration-tools.md)          |
| `mcp`                        | MCP servers                                                                              | [MCP servers](guides/mcp.md)                              |
| `rag`                        | Vector store (seven adapters), embeddings, retrieval defaults, reranker, query rewriting | [Retrieval](guides/rag.md)                                |
| `tokens`                     | Token store, quotas and pricing                                                          | [Observability](guides/observability.md)                  |
| `audit`                      | Audit trail, store, retention, redaction, SIEM                                           | [Audit trail](guides/audit.md)                            |
| `logging`                    | Technical log adapter and level                                                          | [Observability](guides/observability.md)                  |
| `appHome`                    | Base directory for resolving tool modules                                                | [Agents, tools and skills](guides/agents-tools-skills.md) |

Access control (`ACLService`, security chain) and approvals
(`ApprovalService`, triggers) are configured **in code**, because their rules
are usually functions of your application's data. See
[Security](guides/security.md) and [Human-in-the-loop](guides/human-in-the-loop.md).

## Defaults worth knowing

| Setting                                      | Default                                             | Note                                                                                     |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `llm.defaultProvider`                        | `claude`                                            | Keyed providers are created only when their key is set                                   |
| Storage for sessions, memory and tokens      | `memory`                                            | Per process. Use Redis or MongoDB with more than one instance                            |
| `tokens.limitMode`                           | `observe`                                           | Usage is recorded and over-quota calls are reported, not blocked. Set `enforce` to block |
| `tokens.limits.perUser`                      | 50,000 / day, 1,000,000 / month                     | Sample values: set your own before enforcing                                             |
| `tokens.limits.perTenant`                    | 1,000,000 / day, 20,000,000 / month                 |                                                                                          |
| `tokens.pricing`                             | Two sample entries                                  | Maintain your own price list                                                             |
| `agent.maxLoopIterations`                    | 10                                                  |                                                                                          |
| `tools.defaultTimeoutMs`, `tools.maxRetries` | 10,000 ms, 2                                        |                                                                                          |
| `tools.defaultLimits`                        | 200 rows, 128 KiB, 15 s                             | For integration tools                                                                    |
| `memory.session`                             | sliding window, 20 messages, 1 h TTL, media omitted |                                                                                          |
| `audit.enabled`                              | `false`                                             |                                                                                          |
| `logging.adapter`                            | `noop`                                              | The SDK is silent unless you enable a logger                                             |
| `rag.vectorStore.adapter`                    | `in-memory`                                         | Also `pgvector`, `qdrant`, `weaviate`, `milvus`, `pinecone`, `meilisearch`               |

The complete default configuration is
[`src/config/defaults.json`](../src/config/defaults.json).

## A production-shaped example

```json config
{
  "llm": {
    "defaultProvider": "claude",
    "providers": {
      "claude": { "apiKey": "${ANTHROPIC_API_KEY}", "defaultModel": "claude-opus-5" },
      "openai": { "apiKey": "${OPENAI_API_KEY}", "defaultModel": "gpt-6-sol" }
    }
  },
  "storage": {
    "backends": {
      "shared": {
        "type": "mongo",
        "uri": "${MONGO_URI}",
        "database": "agent349",
        "collection": "kv"
      }
    }
  },
  "memory": {
    "session": { "backend": "shared", "strategy": "sliding_window", "ttlSeconds": 7200 },
    "longTerm": { "backend": "shared" }
  },
  "session": { "backend": "shared" },
  "tokens": {
    "backend": "shared",
    "limitMode": "enforce",
    "limits": {
      "perTenant": { "daily": 20000000, "monthly": 400000000 },
      "perUser": { "daily": 500000, "monthly": 10000000 }
    }
  },
  "audit": {
    "enabled": true,
    "store": {
      "type": "mongo",
      "uri": "${MONGO_URI}",
      "database": "agent349",
      "collection": "audit_records",
      "writeConcern": "majority"
    }
  },
  "logging": { "adapter": "console", "level": "info", "format": "json" }
}
```
