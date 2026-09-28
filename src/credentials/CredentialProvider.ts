import type { ExecutionContext } from '../types/index.js';
import type { Credential } from './types.js';

/**
 * Resolves credential references to usable material.
 *
 * The SDK deliberately owns none of the lifecycle: it calls {@link get} on
 * every execution that needs a credential and discards the result afterwards.
 * That is what lets an implementation refresh an expired OAuth token without
 * the SDK ever knowing such a thing as a refresh token exists. Caching, when
 * it makes sense, is the provider's decision.
 *
 * `get()` receives the {@link ExecutionContext} so a provider can return
 * **per-user** credentials — the token of whoever is talking to the agent —
 * not just service credentials. Implementations backing a service account
 * simply ignore the parameter.
 *
 * ### Implementing one
 * ```typescript
 * export class MyOAuthProvider extends CredentialProvider {
 *   readonly name = 'my-oauth';
 *
 *   async get(ref: string, context: ExecutionContext): Promise<Credential> {
 *     const token = await this.store.freshTokenFor(context.userId, ref);
 *     if (token === null) throw new CredentialError(ref, 'no grant for this user');
 *     return { kind: 'bearer', token };
 *   }
 * }
 * ```
 */
export abstract class CredentialProvider {
  /** Human-readable identifier for this provider (e.g. `'config'`). */
  abstract readonly name: string;

  /**
   * Resolves `ref` to a credential valid for this execution.
   *
   * @param ref     - Reference declared in `connection.credential.ref`.
   * @param context - Context of the execution requesting the credential.
   * @returns The resolved credential.
   * @throws {@link import('../errors/index.js').CredentialError} when the
   *         reference is unknown or cannot be resolved.
   */
  abstract get(ref: string, context: ExecutionContext): Promise<Credential>;
}
