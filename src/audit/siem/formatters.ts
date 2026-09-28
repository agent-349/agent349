import type { AuditRecord } from '../../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// SIEM line formatters
// ─────────────────────────────────────────────────────────────────────────────

/** Supported SIEM serialisation formats. */
export type SIEMFormat = 'json' | 'cef' | 'leef';

/** Maps an audit severity to a CEF severity integer (0–10). */
function cefSeverity(severity: AuditRecord['severity']): number {
  switch (severity) {
    case 'critical':
      return 9;
    case 'warning':
      return 5;
    default:
      return 1;
  }
}

/** Escapes a value for safe inclusion in a CEF extension field. */
function cefEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, ' ');
}

/**
 * Formats a single {@link AuditRecord} as an ArcSight **CEF** line.
 */
export function toCEF(r: AuditRecord): string {
  const sev = cefSeverity(r.severity);
  const ext =
    `src=${cefEscape(r.userId)} dst=${cefEscape(r.agentId)} ` +
    `msg=${cefEscape(r.detail?.summary ?? '')} ` +
    `cs1=${cefEscape(r.tenantId)} cs1Label=tenantId ` +
    `cs2=${cefEscape(r.requestId)} cs2Label=requestId ` +
    `outcome=${r.outcome}`;
  return `CEF:0|Agent349|AgentOrchestrator|1.0|${r.action}|${r.action}|${sev}|${ext}`;
}

/**
 * Formats a single {@link AuditRecord} as an IBM QRadar **LEEF** line.
 */
export function toLEEF(r: AuditRecord): string {
  return (
    `LEEF:2.0|Agent349|AgentOrchestrator|1.0|${r.action}|` +
    `tenantId=${r.tenantId}\tusrName=${r.userId}\tcat=${r.category}\t` +
    `sev=${r.severity}\toutcome=${r.outcome}\trequestId=${r.requestId}`
  );
}

/**
 * Serialises a batch of records into the given SIEM format.
 *
 * - `cef` / `leef` → one line per record, newline-separated.
 * - `json`         → pretty-printed JSON array.
 */
export function formatRecords(records: AuditRecord[], format: SIEMFormat): string {
  if (format === 'cef') return records.map(toCEF).join('\n');
  if (format === 'leef') return records.map(toLEEF).join('\n');
  return JSON.stringify(records, null, 2);
}
