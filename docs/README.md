# Agent349 documentation

## Start here

- [Getting started](getting-started.md): install, first agent, tools, governance, running the example.
- [Architecture](architecture.md): the building blocks, what happens during a call, cross-cutting concerns.
- [Configuration](configuration.md): sections, defaults worth knowing, a production-shaped example.

## Guides

| Guide                                                     | Covers                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Agents, tools and skills](guides/agents-tools-skills.md) | The core model, running agents, streaming, stateless mode, declarative configuration                                         |
| [LLM providers](guides/llm-providers.md)                  | Claude, OpenAI, Gemini, Ollama, OpenAI-compatible endpoints, fallback, multimodal input, structured output, custom providers |
| [Memory and sessions](guides/memory-and-sessions.md)      | Storage backends, sessions, compression, long-term facts                                                                     |
| [Retrieval (RAG)](guides/rag.md)                          | Ingestion, vector stores, embeddings, reranking, access control                                                              |
| [Security and access control](guides/security.md)         | ACL, data filtering, field masking, prompt-injection checks, rate limits                                                     |
| [Human-in-the-loop](guides/human-in-the-loop.md)          | Approval triggers, suspension and resumption, escalation                                                                     |
| [Audit trail](guides/audit.md)                            | Records, stores, queries, SIEM forwarding, integrity, retention                                                              |
| [Observability](guides/observability.md)                  | Events, technical logs, token accounting and quotas                                                                          |
| [MCP servers](guides/mcp.md)                              | Using Model Context Protocol servers as tools                                                                                |
| [Integration tools](guides/integration-tools.md)          | SQL, MongoDB, HTTP, web, feeds, documents, files and mail                                                                    |
| [Deployment](guides/deployment.md)                        | Multi-instance setups, graceful shutdown, production checklist                                                               |

## Examples

Runnable examples live in [`examples/`](../examples/).

## Reference manuals (Spanish)

The complete reference manuals written during the SDK's development are
available in Spanish under [`es/`](es/README.md). The English guides above
cover the same features. Each of them links to the matching manual for
exhaustive detail.

## Keeping these docs correct

Every TypeScript snippet and every configuration block tagged `config` in this
directory is compiled against the current sources, and the configuration blocks
are also loaded with the real `ConfigLoader`:

```bash
npm run docs:check
```
