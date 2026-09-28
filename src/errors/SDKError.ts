// ─────────────────────────────────────────────────────────────────────────────
// BASE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base class for all SDK errors. Extend this — never throw it directly.
 *
 * Provides a `code` field for programmatic matching and ensures the prototype
 * chain is correctly restored (required when targeting ES5/CommonJS).
 */
export class SDKError extends Error {
  // Explicitly typed as `string` so subclasses can override with narrower literals.
  override readonly name: string = 'SDKError';

  /**
   * Machine-readable error code.
   * Sub-classes override this with a specific `SCREAMING_SNAKE_CASE` value.
   */
  readonly code: string;

  /**
   * @param message - Human-readable description of the error.
   * @param code - Machine-readable identifier for the error class.
   * @param options - Standard `ErrorOptions`; pass `{ cause }` to chain errors.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    // Restore prototype chain in environments that target ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
