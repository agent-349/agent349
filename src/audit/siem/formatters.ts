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

/**
 * Escapes a CEF header field (vendor, signature id, name): `\` and `|`
 * escaped, line breaks flattened, so a value cannot add header fields or a
 * forged record on the next line.
 */
function cefHeader(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]/g, ' ');
}

/**
 * Escapes a CEF extension value: `\` and `=` escaped (so `x act=delete` stays
 * one value), CR/LF written as `\r`/`\n` as the CEF specification requires.
 */
function cefValue(value: string | undefined): string {
  return (value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** LEEF header field: `|` cannot be escaped, so it becomes `_`; tabs and line breaks become spaces. */
function leefHeader(value: string): string {
  return value.replace(/\|/g, '_').replace(/[\t\r\n]/g, ' ');
}

/** LEEF attribute value: the tab separates attributes, so tabs and line breaks become spaces. */
function leefValue(value: string | undefined): string {
  return (value ?? '').replace(/[\t\r\n]/g, ' ');
}

/**
 * Formats a single {@link AuditRecord} as an ArcSight **CEF** line.
 */
export function toCEF(r: AuditRecord): string {
  const sev = cefSeverity(r.severity);
  const ext =
    `src=${cefValue(r.userId)} dst=${cefValue(r.agentId)} ` +
    `msg=${cefValue(r.detail?.summary ?? '')} ` +
    `cs1=${cefValue(r.tenantId)} cs1Label=tenantId ` +
    `cs2=${cefValue(r.requestId)} cs2Label=requestId ` +
    `outcome=${cefValue(r.outcome)}`;
  const action = cefHeader(r.action);
  return `CEF:0|Agent349|AgentOrchestrator|1.0|${action}|${action}|${sev}|${ext}`;
}

/**
 * Formats a single {@link AuditRecord} as an IBM QRadar **LEEF** line.
 */
export function toLEEF(r: AuditRecord): string {
  return (
    `LEEF:2.0|Agent349|AgentOrchestrator|1.0|${leefHeader(r.action)}|` +
    `tenantId=${leefValue(r.tenantId)}\tusrName=${leefValue(r.userId)}\tcat=${leefValue(r.category)}\t` +
    `sev=${leefValue(r.severity)}\toutcome=${leefValue(r.outcome)}\trequestId=${leefValue(r.requestId)}`
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
