import type { AuditSIEMConfig } from '../../config/ConfigLoader.js';
import { SIEMForwarder } from './SIEMForwarder.js';
import { WebhookSIEMForwarder } from './WebhookSIEMForwarder.js';

/**
 * Builds a {@link SIEMForwarder} from a resolved {@link AuditSIEMConfig}, or
 * returns `undefined` when forwarding is disabled (`type: 'none'`).
 *
 * Synchronous and dependency-free: the only built-in forwarder uses the global
 * `fetch`. Custom forwarders are injected via the `siemForwarder` Orchestrator
 * override instead of this factory.
 */
export function createSIEMForwarder(config: AuditSIEMConfig): SIEMForwarder | undefined {
  switch (config.type) {
    case 'none':
      return undefined;
    case 'webhook':
      return new WebhookSIEMForwarder({
        url: config.url,
        ...(config.format !== undefined && { format: config.format }),
        ...(config.headers !== undefined && { headers: config.headers }),
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      });
  }
}
