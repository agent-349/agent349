import type { AuditRecord } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A regex-based pattern that detects and redacts sensitive data in strings. */
export interface RedactPattern {
  /** Unique name for this pattern (used for logging and config). */
  name: string;
  /** Regular expression to match sensitive content. */
  pattern: RegExp;
  /** Replacement string (e.g. `'[EMAIL]'`). */
  replacement: string;
}

/** Configuration for {@link SensitiveDataGuard}. */
export interface SensitiveDataGuardConfig {
  /**
   * Top-level field names (anywhere in the object graph) whose values are
   * always replaced with `'[REDACTED]'` without pattern matching.
   * Example: `['password', 'token', 'apiKey']`
   */
  globalRedactFields?: string[];
  /** Additional regex patterns to redact. Merged with the built-in patterns. */
  customPatterns?: RedactPattern[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in patterns
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_PATTERNS: RedactPattern[] = [
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[EMAIL]',
  },
  {
    name: 'creditCard',
    // 13-19 digit sequences optionally separated by spaces or hyphens
    pattern: /\b(?:\d[ -]?){13,18}\d\b/g,
    replacement: '[CREDIT_CARD]',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[SSN]',
  },
  {
    name: 'phone',
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
    replacement: '[PHONE]',
  },
  {
    name: 'apiKey',
    pattern: /(sk-|pk-|Bearer\s+)[A-Za-z0-9_-]+/g,
    replacement: '[API_KEY]',
  },
  {
    name: 'jwt',
    pattern: /ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_TOKEN]',
  },
  {
    name: 'ipAddress',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[IP]',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SensitiveDataGuard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitises {@link AuditRecord} objects before they are persisted, ensuring
 * that sensitive data (PII, secrets, credentials) is redacted from detail and
 * metric fields.
 *
 * Two complementary strategies are applied:
 * 1. **Field redaction** — any object key whose name matches a
 *    `globalRedactFields` entry has its value replaced with `'[REDACTED]'`.
 * 2. **Pattern redaction** — string values are scanned with the built-in and
 *    custom {@link RedactPattern} list, replacing matches with the configured
 *    replacement token.
 *
 * Only mutable, optional fields (`detail`, `metrics`) are touched; the
 * immutable identity and correlation fields are left as-is so that integrity
 * hashes remain valid.
 */
export class SensitiveDataGuard {
  readonly #globalRedactFields: Set<string>;
  readonly #patterns: RedactPattern[];

  /**
   * @param config - Guard configuration. Omitting it creates a guard with
   *   built-in patterns only and no field-name redaction.
   */
  constructor(config: SensitiveDataGuardConfig = {}) {
    this.#globalRedactFields = new Set(config.globalRedactFields ?? []);
    this.#patterns = [...BUILTIN_PATTERNS, ...(config.customPatterns ?? [])];
  }

  /**
   * Returns a sanitised copy of `record`.
   *
   * The record's immutable fields (`id`, `timestamp`, `requestId`, etc.) are
   * never modified. Only `detail` and `metrics` are deep-cloned and sanitised.
   *
   * @param record - The AuditRecord to sanitise.
   * @returns A new AuditRecord with sensitive data removed from mutable fields.
   */
  sanitize(record: AuditRecord): AuditRecord {
    const sanitized: AuditRecord = { ...record };

    if (record.detail !== undefined) {
      sanitized.detail = this.#sanitizeValue(record.detail);
    }

    if (record.metrics !== undefined) {
      sanitized.metrics = this.#sanitizeValue(record.metrics);
    }

    return sanitized;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #sanitizeValue(value: any): any {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      return this.#redactPatterns(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.#sanitizeValue(item));
    }

    if (typeof value === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        if (this.#globalRedactFields.has(key)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.#sanitizeValue(val);
        }
      }
      return result;
    }

    return value;
  }

  #redactPatterns(text: string): string {
    let result = text;
    for (const { pattern, replacement } of this.#patterns) {
      // Reset lastIndex for global regexes reused across calls
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }
    return result;
  }
}
