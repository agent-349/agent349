import type { CollectionResult, ResourceLimits, TruncationReason } from '../../types/index.js';

/** A {@link ResourceLimits} with every field resolved. */
export type ResolvedLimits = Required<ResourceLimits>;

/**
 * SDK-wide fallbacks, used when neither the tool nor its connection sets a cap.
 *
 * Deliberately conservative. An unbounded result burns the context window and
 * the token budget in a single call, and the model has no way to know it
 * happened.
 */
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxRows: 200,
  maxBytes: 131_072,
  timeoutMs: 15_000,
};

/**
 * Resolves the caps for one tool: its own value, else the connection's, else
 * the SDK default — with the connection acting as a **ceiling**.
 *
 * A tool may tighten what its connection allows; it can never loosen it. That
 * asymmetry is what makes a connection's limits a guarantee for whoever
 * declared it rather than a suggestion each tool can ignore.
 *
 * @param tool       - Caps declared on the tool, if any.
 * @param connection - Caps declared on its connection, if any.
 * @param defaults   - Fallbacks. Defaults to {@link DEFAULT_LIMITS}.
 * @returns Fully-resolved caps.
 *
 * @example
 * ```typescript
 * resolveLimits({ maxRows: 500 }, { maxRows: 200 });
 * // → maxRows: 200 — the tool cannot raise its connection's ceiling
 * ```
 */
export function resolveLimits(
  tool?: ResourceLimits,
  connection?: ResourceLimits,
  defaults: ResolvedLimits = DEFAULT_LIMITS,
): ResolvedLimits {
  return {
    maxRows: capped(tool?.maxRows, connection?.maxRows, defaults.maxRows),
    maxBytes: capped(tool?.maxBytes, connection?.maxBytes, defaults.maxBytes),
    timeoutMs: capped(tool?.timeoutMs, connection?.timeoutMs, defaults.timeoutMs),
  };
}

/**
 * Picks the tool's value when present, clamped to the connection's ceiling;
 * otherwise the connection's, otherwise the default.
 */
function capped(
  tool: number | undefined,
  connection: number | undefined,
  fallback: number,
): number {
  const ceiling = connection ?? fallback;
  if (tool === undefined) return ceiling;
  return Math.min(tool, ceiling);
}

/**
 * How many records to ask the source for, so truncation can be *detected*
 * rather than guessed: fetching one extra row is what distinguishes "exactly
 * 200 results" from "at least 200".
 *
 * @param limits - The resolved caps.
 * @returns `maxRows + 1`.
 */
export function fetchSize(limits: ResolvedLimits): number {
  return limits.maxRows + 1;
}

/**
 * Wraps rows in the common {@link CollectionResult} envelope, applying the row
 * and byte caps and describing any truncation in words the model will read.
 *
 * The `notice` is not decorative. Without it a model reports a capped count as
 * the total ("there are 200 sales"); with it, it says there are at least 200
 * and asks the user to narrow the range.
 *
 * @param rows   - Records fetched, possibly including the extra probe row.
 * @param limits - The resolved caps.
 * @param what   - Plural noun for the records, used in the notice
 *                 (e.g. `'rows'`, `'documents'`). Default: `'results'`.
 * @returns The envelope, with `rows` cut to the cap.
 */
export function toCollectionResult<T>(
  rows: T[],
  limits: ResolvedLimits,
  what = 'results',
): CollectionResult<T> {
  let kept = rows;
  let reason: TruncationReason | null = null;

  if (kept.length > limits.maxRows) {
    kept = kept.slice(0, limits.maxRows);
    reason = 'maxRows';
  }

  // Byte cap second: dropping rows to fit the budget can only reduce the set
  // the row cap already produced.
  const withinBytes = fitToBytes(kept, limits.maxBytes);
  if (withinBytes.length < kept.length) {
    kept = withinBytes;
    reason = 'maxBytes';
  }

  if (reason === null) {
    return { rows: kept, rowCount: kept.length, truncated: false };
  }

  return {
    rows: kept,
    rowCount: kept.length,
    truncated: true,
    truncatedBy: reason,
    notice: truncationNotice(kept.length, reason, what),
  };
}

/**
 * Returns the longest prefix of `rows` whose JSON serialisation fits `maxBytes`.
 *
 * Measured by serialising the prefix, since that is what actually reaches the
 * model. Always keeps at least one row: an empty result would misrepresent a
 * successful query as having found nothing.
 */
export function fitToBytes<T>(rows: T[], maxBytes: number): T[] {
  if (rows.length === 0) return rows;
  if (byteLength(rows) <= maxBytes) return rows;

  // Binary search on the prefix length: serialising once per row is O(n²) on
  // wide result sets, and these run inside a tool's latency budget.
  let low = 1;
  let high = rows.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(rows.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return rows.slice(0, low);
}

/** Serialised size of `value` in bytes, as the model would receive it. */
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** Builds the plain-language truncation note handed to the model. */
function truncationNotice(kept: number, reason: TruncationReason, what: string): string {
  const cause =
    reason === 'maxRows'
      ? `the configured maximum of ${kept} ${what} per call`
      : 'the configured response size limit';
  return (
    `Truncated: showing the first ${kept} ${what}, which reached ${cause}. ` +
    `There are more — narrow the query to see the rest, and do not present ` +
    `this as a complete or total count.`
  );
}

/**
 * Cuts text to a character budget, appending a note the model can act on.
 *
 * @param text     - The extracted text.
 * @param maxChars - Character budget.
 * @returns The text and whether it was cut.
 */
export function truncateText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; notice?: string } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    notice:
      `Truncated: showing the first ${maxChars} characters of ${text.length}. ` +
      `Request a narrower range to read the rest.`,
  };
}
