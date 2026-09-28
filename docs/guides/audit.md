# Audit trail

The audit trail answers **who did what, when, and with which outcome**. Every
relevant event (agent runs, model calls, tool calls, security decisions,
approvals, retrieval, sessions, token usage) becomes an `AuditRecord`, written
to a pluggable store and optionally forwarded to a SIEM.

Audit is opt-in (`audit.enabled: false` by default). When disabled, nothing is
built and nothing is captured.

## Enable it

```json config
{
  "audit": {
    "enabled": true,
    "verbosity": "standard",
    "verbosityOverrides": { "security": "verbose" },
    "buffer": { "maxSize": 100, "flushIntervalMs": 5000 },
    "retention": { "default": 90, "security": 365 },
    "sensitiveData": {
      "enabled": true,
      "globalRedactFields": ["password", "token", "apiKey", "secret", "ssn"]
    },
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

Stores: `memory` (development and tests) and `mongo`. Implement
`AuditStoreAdapter` for another database and pass it as
`Orchestrator.fromConfig(config, { auditStore })`.

Security decisions are audited when the security chain is constructed with the
EventBus: `new SecurityMiddlewareChain(orch.events)`. See
[Security](security.md#wiring).

## The record

```ts nocheck
interface AuditRecord {
  id: string;
  timestamp: Date;
  requestId: string; // groups everything that happened in one chat() call
  sessionId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  category: AuditCategory; // agent | llm | tool | skill | rag | security | approval | session | memory | system
  action: string; // call_end, access_denied, approved, …
  outcome: 'success' | 'failure' | 'blocked' | 'error';
  severity: 'info' | 'warning' | 'critical';
  detail?: { summary?; input?; output?; error?; … }; // depth depends on verbosity
  resource?: { type; id; name? };
  metrics?: { durationMs?; tokensInput?; tokensOutput?; estimatedCostUsd? };
  security?: { aclDecision?; fieldsMasked?; injectionDetected?; riskLevel? };
  _integrityHash?: string;
}
```

Verbosity controls how much detail is kept. `minimal` keeps summaries,
`standard` adds inputs and outputs, and `verbose` adds full messages and
responses. It can be overridden per category.

## Query

```ts
await orch.audit!.flush(); // records are buffered; flush before reading your own writes

const lastHour = { from: new Date(Date.now() - 3_600_000), to: new Date() };

const denials = await orch.audit!.query({
  tenantId: 'acme',
  category: 'security',
  outcome: 'blocked',
  dateRange: lastHour,
  limit: 50,
});

const trace = await orch.audit!.getByRequestId('req-123'); // one chat() call
const timeline = await orch.audit!.getSessionTimeline('sess-9'); // one conversation
const stats = await orch.audit!.getStats('acme', lastHour); // counts by category, agent, outcome…
```

`orch.observability.getRequestReport(requestId)` combines a request's audit
trail with its token cost.

## Export and SIEM

File exports: `exportJSON(query, path)`, `exportCSV(query, path)` and
`exportSIEM(query, format, path)` (JSON, CEF, LEEF; up to 1,000 records per call).

Live forwarding sends each batch after it is durably written:

```json config
{
  "audit": {
    "enabled": true,
    "siem": {
      "type": "webhook",
      "url": "${SIEM_URL}",
      "format": "cef",
      "headers": { "authorization": "Bearer ${SIEM_TOKEN}" },
      "timeoutMs": 10000
    }
  }
}
```

A failed delivery is reported but never blocks or loses audit writes. For
Splunk HEC, syslog, Kafka and similar targets, extend `SIEMForwarder` and pass
it as `{ siemForwarder }`. CEF and LEEF lines identify the vendor as
`Agent349`.

## Privacy and integrity

- **Redaction.** Fields named in `globalRedactFields` are redacted anywhere in
  a record, and custom regex patterns can be added through an injected
  `AuditLogger`.
- **Integrity hash.** Each record carries `_integrityHash`, a SHA-256 over its
  identity fields (id, timestamp, request, tenant, user, category, action,
  outcome). `new IntegrityHash().verify(record)` detects accidental or
  unsophisticated modification. It is a plain hash, not a signature: someone
  with write access to the store can recompute it. For tamper-proof storage,
  use a write-once store or forward records to a SIEM.
- **Retention.** `retention` sets days per category. Call
  `orch.audit.applyRetention()` from your scheduler, or use `retentionDays` in
  the Mongo store.

## Shutdown

Records are buffered in memory. Call `await orch.shutdown()` on `SIGTERM`, so
the final flush happens before the process exits. See
[Deployment](deployment.md#graceful-shutdown).

The Spanish [audit manual](../es/AUDIT_MANUAL.md) has the complete reference,
recipes and troubleshooting.
