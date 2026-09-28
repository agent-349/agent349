/**
 * Audit trail — basic use with the in-memory store (development and tests).
 *
 * Run: npx tsx examples/audit-basic.ts
 * In your own project, import from `agent349` instead of `../src/index.js`.
 */
import { ConfigLoader, Orchestrator } from '../src/index.js';

async function main(): Promise<void> {
  // Enable audit in code on top of the default config (store: memory).
  const config = ConfigLoader.from({
    audit: {
      enabled: true,
      verbosity: 'standard',
      verbosityOverrides: { security: 'verbose' },
    },
  }).get();

  const orch = await Orchestrator.fromConfig(config);

  // Capture is already active: every relevant EventBus event becomes an
  // AuditRecord. Events are emitted by hand here for the demo; in a real run
  // the AgentLoop, ToolExecutor, RAG pipeline, etc. emit them.
  orch.events.emit('agent.loop.start', {
    _context: {
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'r1',
    },
  });
  orch.events.emit('tool.call.end', {
    toolName: 'getBalance',
    success: true,
    durationMs: 42,
    _context: {
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'r1',
    },
  });
  orch.events.emit('agent.loop.end', {
    iterations: 1,
    durationMs: 120,
    _context: {
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'r1',
    },
  });

  // Flush the asynchronous buffer before querying.
  await orch.audit!.flush();

  const range = { from: new Date(Date.now() - 3600_000), to: new Date() };

  // Full timeline of the session.
  const timeline = await orch.audit!.getSessionTimeline('s1');
  console.log(
    'Events in session s1:',
    timeline.map((r) => `${r.category}.${r.action}`),
  );

  // Trace of one request.
  const trace = await orch.audit!.getByRequestId('r1');
  console.log('Records of request r1:', trace.length);

  // Aggregated statistics for the tenant.
  const stats = await orch.audit!.getStats('acme', range);
  console.log('byCategory:', stats.byCategory);
  console.log('byAgent:', stats.byAgent);

  // Orderly shutdown: final flush and resource cleanup.
  await orch.shutdown();
}

void main();
