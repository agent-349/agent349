/**
 * A resolved credential, discriminated by `kind`.
 *
 * The SDK never persists, caches or refreshes these: it asks for one when it
 * needs it and forgets it when the execution ends. Anything with a lifecycle
 * (OAuth refresh, rotation, encryption at rest) belongs to the
 * {@link import('./CredentialProvider.js').CredentialProvider} implementation.
 */
export type Credential =
  /** No authentication. */
  | { kind: 'none' }
  /** HTTP Basic / database user+password. */
  | { kind: 'basic'; username: string; password: string }
  /** Bearer token, sent as `Authorization: Bearer <token>`. */
  | { kind: 'bearer'; token: string }
  /** Opaque key sent in an arbitrary header. */
  | { kind: 'apiKey'; header: string; value: string }
  /** Anything else the host needs to hand a driver. */
  | { kind: 'custom'; value: Record<string, unknown> };

/**
 * How a connection points at its credential.
 *
 * Either a `ref` resolved through the provider, or the material inline — the
 * latter only for simple static cases, written as `${ENV_VAR}` so the
 * `ConfigLoader` substitutes it and no secret is committed.
 */
export type CredentialSpec = { ref: string } | Credential;

/** Config shape of the optional `credentials` section. */
export type CredentialsConfig = Record<string, Credential>;
