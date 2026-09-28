/**
 * Audit trail persisted in MongoDB.
 *
 * Requires `npm install mongodb` and a reachable MongoDB (MONGO_URI, default
 * mongodb://localhost:27017). Shows the three ways to enable MongoAuditStore:
 *   A) from a JSON configuration file,
 *   B) from a configuration object,
 *   C) by injecting the store in code (overrides).
 *
 * Run: npx tsx examples/audit-mongo.ts
 */
import { ConfigLoader, MongoAuditStore, Orchestrator } from '../src/index.js';

// ── A) From JSON (agent349.config.json) ─────────────────────────────────────
// {
//   "audit": {
//     "enabled": true,
//     "verbosity": "standard",
//     "store": {
//       "type": "mongo",
//       "uri": "${MONGO_URI}",
//       "database": "agent349",
//       "collection": "audit_records",
//       "retentionDays": 365,
//       "writeConcern": "majority"
//     }
//   }
// }
//
//   const orch = await Orchestrator.create('./agent349.config.json');

// ── B) From a configuration object ──────────────────────────────────────────
async function fromConfigObject(): Promise<Orchestrator> {
  const config = ConfigLoader.from({
    audit: {
      enabled: true,
      verbosity: 'standard',
      retention: { default: 90, security: 365 },
      sensitiveData: { enabled: true, globalRedactFields: ['password', 'token', 'ssn'] },
      store: {
        type: 'mongo',
        uri: process.env['MONGO_URI'] ?? 'mongodb://localhost:27017',
        database: 'agent349',
        collection: 'audit_records',
        retentionDays: 365,
        writeConcern: 'majority',
      },
    },
  }).get();

  // The orchestrator creates the store (connects and creates indexes) and,
  // because it owns it, closes it in shutdown().
  return Orchestrator.fromConfig(config);
}

// ── C) Injecting the store in code ──────────────────────────────────────────
async function fromInjectedStore(): Promise<Orchestrator> {
  const store = await MongoAuditStore.create({
    uri: process.env['MONGO_URI'] ?? 'mongodb://localhost:27017',
    database: 'agent349',
    collection: 'audit_records',
    retentionDays: 365,
  });

  // An injected store is NOT closed by shutdown(): its lifecycle is yours.
  const config = ConfigLoader.from({ audit: { enabled: true } }).get();
  return Orchestrator.fromConfig(config, { auditStore: store });
  // Remember to close it yourself: await store.close();
}

async function main(): Promise<void> {
  const orch = await fromConfigObject();

  // In a real run, the agent loop and the security chain emit these events.
  orch.events.emit('security.acl.denied', {
    reason: 'role finance_viewer cannot call payments.transfer',
    _context: {
      tenantId: 'acme',
      userId: 'u9',
      agentId: 'agent-1',
      sessionId: 's2',
      requestId: 'r2',
    },
  });
  await orch.audit!.flush();

  const range = { from: new Date(Date.now() - 86_400_000), to: new Date() };
  const incidents = await orch.audit!.query({
    tenantId: 'acme',
    category: 'security',
    dateRange: range,
  });
  console.log('Security incidents:', incidents.total);

  // Export for compliance.
  await orch.audit!.exportJSON({ tenantId: 'acme', dateRange: range }, './audit-acme.json');

  await orch.shutdown(); // final flush, then closes the owned MongoClient

  void fromInjectedStore; // shown above for reference
}

void main();
