import { CredentialError } from '../errors/index.js';
import type { ExecutionContext } from '../types/index.js';
import { CredentialProvider } from './CredentialProvider.js';
import type { Credential, CredentialsConfig } from './types.js';

/**
 * Built-in provider backed by the `credentials` config section.
 *
 * Covers static credentials only — a database password, an API key — written
 * as `${ENV_VAR}` placeholders that the `ConfigLoader` substitutes at load
 * time, so nothing secret is committed.
 *
 * It has no notion of expiry: every `get()` returns the same value. For
 * anything with a lifecycle (OAuth), implement {@link CredentialProvider} and
 * inject it via `OrchestratorOverrides.credentialProvider`.
 *
 * @example
 * ```jsonc
 * { "credentials": {
 *     "erp-readonly": { "kind": "basic", "username": "agent_ro", "password": "${ERP_PASSWORD}" }
 * } }
 * ```
 */
export class ConfigCredentialProvider extends CredentialProvider {
  override readonly name = 'config';

  readonly #credentials: CredentialsConfig;

  /**
   * @param credentials - The `credentials` config section, already
   *                      env-substituted. Defaults to empty.
   */
  constructor(credentials: CredentialsConfig = {}) {
    super();
    this.#credentials = credentials;
  }

  /**
   * Returns the credential declared under `ref`.
   *
   * @param ref      - Key in the `credentials` config section.
   * @param _context - Unused: config credentials are the same for every user.
   * @returns The declared credential.
   * @throws {@link CredentialError} when `ref` is not declared, or when a
   *         `${ENV_VAR}` placeholder resolved to an empty string — which means
   *         the variable is missing from the environment.
   */

  async get(ref: string, _context: ExecutionContext): Promise<Credential> {
    const credential = this.#credentials[ref];
    if (credential === undefined) {
      const known = Object.keys(this.#credentials);
      throw new CredentialError(
        ref,
        `not declared in the 'credentials' config section. ` +
          `Declared: ${known.join(', ') || '(none)'}`,
      );
    }

    // An unresolved `${ENV_VAR}` collapses to '' in the ConfigLoader. Failing
    // here beats handing a driver an empty password and reporting an
    // authentication failure that hides a missing environment variable.
    const empty = emptyField(credential);
    if (empty !== null) {
      throw new CredentialError(
        ref,
        `field '${empty}' is empty — a \${ENV_VAR} placeholder most likely ` +
          'resolved to nothing because the variable is not set',
      );
    }

    return credential;
  }
}

/**
 * Returns the name of the first required field that is an empty string, or
 * `null` when the credential is fully populated.
 */
function emptyField(credential: Credential): string | null {
  switch (credential.kind) {
    case 'basic':
      if (credential.username === '') return 'username';
      if (credential.password === '') return 'password';
      return null;
    case 'bearer':
      return credential.token === '' ? 'token' : null;
    case 'apiKey':
      if (credential.header === '') return 'header';
      if (credential.value === '') return 'value';
      return null;
    case 'none':
    case 'custom':
      return null;
  }
}
