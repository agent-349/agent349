/**
 * Technical logging — console output, and injecting your own sink.
 *
 * Technical logs are the observability plane for developers and SRE, separate
 * from the (immutable) audit trail and from token accounting. The SDK is
 * SILENT by default (adapter 'noop').
 *
 * Run: npx tsx examples/logging-console.ts
 */
import { ConfigLoader, LoggerAdapter, Orchestrator } from '../src/index.js';
import type { LogEntry } from '../src/index.js';

// ── A) Console, from configuration ──────────────────────────────────────────
async function consoleLogging(): Promise<void> {
  const config = ConfigLoader.from({
    logging: {
      adapter: 'console',
      level: 'debug',
      format: 'pretty',
      redactFields: ['password', 'token', 'apiKey'],
    },
  }).get();

  const orch = await Orchestrator.fromConfig(config);

  orch.events.emit('tool.call.end', {
    toolName: 'getBalance',
    success: true,
    durationMs: 30,
    _context: { tenantId: 'acme', userId: 'u1', requestId: 'r1' },
  });

  await orch.shutdown(); // stops the LogCollector
}

// ── B) Your own sink (pino / winston / Loki), injected ──────────────────────
class PinoLikeLogger extends LoggerAdapter {
  readonly name = 'pino-like';
  log(entry: LogEntry): void {
    // Send to your real backend here; must be non-blocking and never throw.
    // logger[entry.level]({ event: entry.event, ...entry.context }, entry.message);
    void entry;
  }
}

async function injectedLogger(): Promise<void> {
  const config = ConfigLoader.from({ logging: { level: 'info' } }).get();
  const orch = await Orchestrator.fromConfig(config, { logger: new PinoLikeLogger() });
  orch.events.emit('llm.call.error', {
    error: 'timeout',
    _context: { tenantId: 'acme', requestId: 'r2' },
  });
  await orch.shutdown();
}

async function main(): Promise<void> {
  await consoleLogging();
  await injectedLogger();
}

void main();
