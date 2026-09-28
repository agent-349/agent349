/**
 * Conditional requests for the reading tools (`web.read`, `feed.read`).
 *
 * A host that reads the same URL on a schedule should not download and parse
 * it again when nothing changed. HTTP already has the mechanism: the server
 * hands out an `ETag` and a `Last-Modified`, the client sends them back, and an
 * unchanged resource answers `304` with no body. These helpers carry those two
 * values in and out of a tool without letting them become a header-injection
 * vector.
 */

/** Validators returned by a server, to make the next read conditional. */
export interface ResponseValidators {
  /** `ETag` response header. */
  etag?: string;
  /** `Last-Modified` response header. */
  lastModified?: string;
}

/** Longest validator accepted. Real ETags and HTTP dates are far shorter. */
const MAX_VALIDATOR_LENGTH = 512;

/**
 * Input properties a reading tool publishes when conditional requests are on.
 * Off by default, so an agent-facing tool keeps its one-field schema.
 */
export const CONDITIONAL_INPUT_PROPERTIES: Readonly<Record<string, unknown>> = {
  ifNoneMatch: {
    type: 'string',
    description: 'ETag returned by a previous read. An unchanged resource answers 304.',
  },
  ifModifiedSince: {
    type: 'string',
    description:
      'Last-Modified value returned by a previous read. An unchanged resource answers 304.',
  },
};

/**
 * Builds the conditional request headers from a tool input.
 *
 * @param input - The tool input, possibly carrying `ifNoneMatch` / `ifModifiedSince`.
 * @returns The headers to send, or an error message when a value cannot be
 *          sent as a header (not a string, too long, or containing a line
 *          break that would start a new header).
 */
export function conditionalHeaders(input: {
  ifNoneMatch?: unknown;
  ifModifiedSince?: unknown;
}): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  const fields = [
    ['ifNoneMatch', 'if-none-match'],
    ['ifModifiedSince', 'if-modified-since'],
  ] as const;

  for (const [field, header] of fields) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (
      typeof value !== 'string' ||
      /[\r\n\0]/.test(value) ||
      value.length > MAX_VALIDATOR_LENGTH
    ) {
      return {
        error: `'${field}' must be a single-line string of at most ${MAX_VALIDATOR_LENGTH} characters.`,
      };
    }
    headers[header] = value;
  }

  return { headers };
}

/**
 * Picks the validators out of a response's headers.
 *
 * @param headers - Lower-cased response headers.
 */
export function responseValidators(headers: Record<string, string>): ResponseValidators {
  const etag = headers['etag'];
  const lastModified = headers['last-modified'];
  return {
    ...(etag !== undefined && { etag }),
    ...(lastModified !== undefined && { lastModified }),
  };
}
