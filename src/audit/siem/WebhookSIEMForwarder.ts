import type { AuditRecord } from '../../types/index.js';
import type { ForwardResult } from '../types.js';
import { SIEMForwarder } from './SIEMForwarder.js';
import { formatRecords, type SIEMFormat } from './formatters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for {@link WebhookSIEMForwarder}. */
export interface WebhookSIEMForwarderConfig {
  /** Destination URL that receives the POST request. */
  url: string;
  /** Payload format. Default: `'json'`. */
  format?: SIEMFormat;
  /** Extra headers (e.g. `Authorization`). Merged over the defaults. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default: `10000`. */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebhookSIEMForwarder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forwards audit batches to an HTTP endpoint via `POST`.
 *
 * - `json` → `application/json`, the batch as a JSON array.
 * - `cef` / `leef` → `text/plain`, one line per record.
 *
 * A non-2xx response or a network/timeout error marks the whole batch as failed
 * (returned in {@link ForwardResult}); it never throws, so a SIEM outage cannot
 * break the audit pipeline.
 */
export class WebhookSIEMForwarder extends SIEMForwarder {
  readonly name = 'webhook';

  readonly #url: string;
  readonly #format: SIEMFormat;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;

  constructor(config: WebhookSIEMForwarderConfig) {
    super();
    this.#url = config.url;
    this.#format = config.format ?? 'json';
    this.#headers = config.headers ?? {};
    this.#timeoutMs = config.timeoutMs ?? 10_000;
  }

  /** @inheritdoc */
  async forward(records: AuditRecord[]): Promise<ForwardResult> {
    if (records.length === 0) return { sent: 0, failed: 0 };

    const body = formatRecords(records, this.#format);
    const contentType = this.#format === 'json' ? 'application/json' : 'text/plain';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const res = await fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': contentType, ...this.#headers },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          sent: 0,
          failed: records.length,
          errors: [`SIEM webhook responded ${res.status} ${res.statusText}`],
        };
      }

      return { sent: records.length, failed: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { sent: 0, failed: records.length, errors: [message] };
    } finally {
      clearTimeout(timer);
    }
  }
}
