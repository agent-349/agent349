import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { UnsupportedCapabilityError } from '../errors/index.js';
import type {
  LLMRequest,
  ProviderCapabilities,
  ResponseFormat,
  StructuredOutput,
} from '../types/index.js';

/**
 * Shared AJV instance for response-schema validation.
 *
 * `strict: false` because provider schema dialects are permissive supersets:
 * an unknown keyword should not fail the caller's validation outright.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Compiled validators, keyed by the serialised schema. */
const validatorCache = new Map<string, ValidateFunction>();

/**
 * Checks a request's {@link ResponseFormat} against a provider's declared
 * capabilities, before any translation happens.
 *
 * Fails loudly rather than degrading: asking a provider without native support
 * for a schema-constrained answer and getting back unconstrained prose is worse
 * than an explicit error.
 *
 * @param provider     - Provider instance name (for the error).
 * @param capabilities - What the provider/model declares.
 * @param request      - The request being prepared.
 * @throws {@link UnsupportedCapabilityError} when the format — or its
 *         combination with tools — cannot be served.
 */
export function assertResponseFormatSupported(
  provider: string,
  capabilities: ProviderCapabilities,
  request: LLMRequest,
): void {
  const format = request.responseFormat;
  if (format === undefined) return;

  if (capabilities.structuredOutput === 'none') {
    throw new UnsupportedCapabilityError(
      provider,
      'structuredOutput',
      'this provider has no native structured-output support',
      request.model,
    );
  }
  if (format.type === 'json_schema' && capabilities.structuredOutput !== 'jsonSchema') {
    throw new UnsupportedCapabilityError(
      provider,
      'structuredOutput.json_schema',
      `this provider only supports JSON mode without a schema. Use ` +
        `responseFormat.type: 'json_object' and describe the shape in the prompt.`,
      request.model,
    );
  }
  const hasTools = request.tools !== undefined && request.tools.length > 0;
  if (hasTools && !capabilities.structuredOutputWithTools) {
    throw new UnsupportedCapabilityError(
      provider,
      'structuredOutputWithTools',
      'this provider cannot combine structured output with tool calling in one ' +
        'request. Issue the tool-calling turns first, then request the structured ' +
        'answer in a separate call without tools.',
      request.model,
    );
  }
}

/**
 * Builds the {@link StructuredOutput} report for a response.
 *
 * Keeps three facts apart on purpose — what the provider enforced, whether the
 * text parsed as JSON, and whether it validated against the schema — so a
 * well-formed but schema-violating answer is never mistaken for a validated one.
 *
 * @param responseText - The model's textual answer.
 * @param format       - The requested format, or `undefined` when none was asked for.
 * @param mode         - What the provider was actually asked to enforce.
 * @returns The report, or `undefined` when no format was requested.
 */
export function buildStructuredOutput(
  responseText: string,
  format: ResponseFormat | undefined,
  mode: StructuredOutput['mode'],
): StructuredOutput | undefined {
  if (format === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    return { mode, parsed: false, validation: 'skipped', rawText: responseText };
  }

  if (format.validate !== true || format.schema === undefined) {
    return { mode, parsed: true, value, validation: 'skipped' };
  }

  const errors = validateAgainstSchema(value, format.schema);
  return {
    mode,
    parsed: true,
    value,
    validation: errors.length === 0 ? 'valid' : 'invalid',
    ...(errors.length > 0 && { validationErrors: errors }),
  };
}

/**
 * Validates a value against a JSON Schema, returning human-readable errors.
 *
 * A schema AJV itself rejects (an unsupported dialect, a malformed schema) is
 * reported as a validation error rather than thrown, so a provider's answer is
 * never lost to a schema problem.
 *
 * @param value  - Parsed value to check.
 * @param schema - JSON Schema to check against.
 * @returns Error messages; empty when the value is valid.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const key = JSON.stringify(schema);
  let validator = validatorCache.get(key);

  if (validator === undefined) {
    try {
      validator = ajv.compile(schema);
      validatorCache.set(key, validator);
    } catch (err) {
      return [`schema could not be compiled: ${err instanceof Error ? err.message : String(err)}`];
    }
  }

  if (validator(value)) return [];
  return (validator.errors ?? []).map(
    (e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`,
  );
}
