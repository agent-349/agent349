/**
 * Forwarding the audit trail to a SIEM as it is written.
 *
 * Shows both ways:
 *   A) a webhook declared in configuration;
 *   B) your own forwarder injected in code (Splunk HEC here).
 *
 * Run: npx tsx examples/audit-siem.ts
 * (the example endpoints do not exist, so delivery is reported as failed;
 * audit writes are never blocked by a failing SIEM)
 */
import { ConfigLoader, Orchestrator, SIEMForwarder } from '../src/index.js';
import type { AuditRecord, ForwardResult } from '../src/index.js';

// ── A) Webhook from configuration ───────────────────────────────────────────
async function webhookFromConfig(): Promise<Orchestrator> {
  const config = ConfigLoader.from({
    audit: {
      enabled: true,
      siem: {
        type: 'webhook',
        url: process.env['SIEM_URL'] ?? 'https://siem.example/ingest',
        format: 'cef',
        headers: { authorization: `Bearer ${process.env['SIEM_TOKEN'] ?? ''}` },
      },
    },
  }).get();
  // Each audit batch is POSTed to the SIEM after it is written to the store.
  return Orchestrator.fromConfig(config);
}

// ── B) Your own forwarder (Splunk HEC, syslog, Kafka…) ──────────────────────
class SplunkHECForwarder extends SIEMForwarder {
  readonly name = 'splunk-hec';
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }
  async forward(records: AuditRecord[]): Promise<ForwardResult> {
    try {
      const body = records.map((r) => JSON.stringify({ event: r })).join('\n');
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Splunk ${this.token}` },
        body,
      });
      return res.ok
        ? { sent: records.length, failed: 0 }
        : { sent: 0, failed: records.length, errors: [`HEC ${res.status}`] };
    } catch (err) {
      return { sent: 0, failed: records.length, errors: [String(err)] };
    }
  }
}

async function injectedForwarder(): Promise<Orchestrator> {
  const config = ConfigLoader.from({ audit: { enabled: true } }).get();
  const forwarder = new SplunkHECForwarder('https://splunk.example/services/collector', 'token');
  return Orchestrator.fromConfig(config, { siemForwarder: forwarder });
}

async function main(): Promise<void> {
  const orch = await webhookFromConfig();

  // In a real run, the agent loop and the security chain emit these events.
  orch.events.emit('security.acl.denied', {
    reason: 'role finance_viewer cannot call payments.transfer',
    _context: { tenantId: 'acme', userId: 'u9', agentId: 'a1', sessionId: 's1', requestId: 'r1' },
  });

  // Force delivery now (normally the buffer flushes on its own schedule).
  await orch.audit!.flush();

  // shutdown() performs the final flush and closes the forwarder.
  await orch.shutdown();

  void injectedForwarder; // shown above for reference
}

void main();
