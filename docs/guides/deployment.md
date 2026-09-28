# Deployment

Agent349 runs inside your application: an HTTP API, a worker or a scheduled
job. It needs no service of its own, which makes it suitable for self-hosted,
private-cloud and air-gapped deployments. With a local model through Ollama or
an OpenAI-compatible server, no data has to leave your network.

## One instance

The defaults keep everything in memory. That is fine for development, and for a
single process that can lose sessions and quotas on restart.

## Several instances

Sessions, memory, token quotas, approvals and the audit trail are state. With
more than one instance (pods, replicas, workers), each instance would otherwise
keep its own copy: a conversation would lose its history when a request lands
on another pod, and each pod would enforce its own quota.

Point every stateful layer at shared infrastructure. This is configuration
only:

```json config
{
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
  "memory": { "session": { "backend": "shared" }, "longTerm": { "backend": "shared" } },
  "session": { "backend": "shared" },
  "tokens": { "backend": "shared" },
  "audit": {
    "enabled": true,
    "store": {
      "type": "mongo",
      "uri": "${MONGO_URI}",
      "database": "agent349",
      "collection": "audit_records",
      "writeConcern": "majority"
    }
  }
}
```

Redis works the same way (`{ "type": "redis", "url": "${REDIS_URL}" }`).

| Component                | In a cluster                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Sessions, memory, tokens | Shared `storage` backend (required)                                                                                          |
| Audit                    | `audit.store` of type `mongo` (configured separately from `storage`). The SIEM forwarder runs per instance, which is correct |
| Approvals                | `MongoPendingActionStore`: atomic claims across processes                                                                    |
| Vector store             | Any database-backed adapter (pgvector, Qdrant, Weaviate, Milvus, Pinecone, Meilisearch), not `in-memory`                     |
| Technical logs           | Stateless; ship them to your central log system                                                                              |
| EventBus                 | In-process: subscribers see only their own instance's events                                                                 |
| Rate limiter             | In-memory, counts per instance                                                                                               |

### Quota precision

Quotas are checked before each model call and recorded after it, because output
tokens are only known at the end. Calls already in flight can therefore
overshoot a limit, and concurrent updates to the same counter can race. For
most uses this soft limit is enough. The Spanish
[cluster manual](../es/CLUSTER_MANUAL.md) describes the exact failure windows
and stricter options (atomic counters, pre-reservation).

## Graceful shutdown

Audit records are buffered in memory. On termination, call `shutdown()`, which
flushes the audit buffer, closes the SIEM forwarder, and closes the
connections and adapters the SDK opened:

```ts
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void orch.shutdown().finally(() => process.exit(0));
  });
}
```

In Kubernetes, leave enough `terminationGracePeriodSeconds` for the final flush.

## Checklist

- [ ] `llm.defaultProvider` and models are set explicitly. API keys come from the environment or a secret manager.
- [ ] Token quotas and pricing reflect your contracts, and `tokens.limitMode` is `enforce` if quotas must block.
- [ ] Sessions, memory and tokens use a shared backend if you run more than one instance.
- [ ] Audit is enabled with a durable store and a retention policy.
- [ ] The security chain is registered with `orch.events`, and every sensitive tool has an ACL policy.
- [ ] Approval triggers exist for irreversible or financial tools, with the right `approverRoles`.
- [ ] Database connections used by agents run as least-privilege users (`readOnlyUser: true` only when true).
- [ ] `orch.shutdown()` runs on `SIGTERM`.
- [ ] A logger adapter ships technical logs to your observability stack.
