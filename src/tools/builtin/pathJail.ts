import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { AccessDeniedError, ValidationError } from '../../errors/index.js';

/** How a refusal is worded, so each tool keeps its own vocabulary. */
export interface PathJailOptions {
  /** Field reported on a {@link ValidationError} (e.g. `'ref'`, `'path'`). */
  field: string;
  /** How the reference is named in messages (e.g. `'document reference'`). */
  noun: string;
  /** Resource type reported on an {@link AccessDeniedError} (e.g. `'document'`). */
  resource: string;
  /** What was not found, in the not-found message (e.g. `'document'`). */
  notFound: string;
  /** Roles of the caller, reported on a refusal. */
  roles: string[];
}

/**
 * Resolves `ref` inside `root` and returns the real path, or refuses.
 *
 * ### Staying inside the corral
 * 1. A null byte, or an absolute path, is refused outright.
 * 2. The textual resolution must stay under the root — this catches `..`.
 * 3. The path is resolved **with symlinks followed** and checked again. Step 2
 *    alone is not enough: a symlink sitting inside the permitted directory and
 *    pointing outside it would otherwise hand out any file the process can read.
 *
 * Shared by every tool that reads from a declared directory, so the check is
 * written once.
 *
 * @param root    - Directory the reference must stay within.
 * @param ref     - Path relative to the root.
 * @param options - Wording of the refusals.
 * @returns The real path of the target.
 * @throws {@link ValidationError} for a reference that tries to leave the root, or does not exist.
 * @throws {@link AccessDeniedError} when the resolved target lies outside the root.
 */
export async function resolveInsideRoot(
  root: string,
  ref: string,
  options: PathJailOptions,
): Promise<string> {
  if (ref.includes('\0')) {
    throw new ValidationError(options.field, `the ${options.noun} contains a null byte`);
  }
  if (isAbsolute(ref)) {
    throw new ValidationError(
      options.field,
      `the ${options.noun} must be relative to the source root`,
    );
  }

  const base = resolve(root);
  const candidate = resolve(base, ref);
  if (!isInside(candidate, base)) {
    throw new ValidationError(
      options.field,
      `'${ref}' resolves outside the configured source root`,
    );
  }

  // Follow symlinks and check again: the previous test only covered the
  // textual path.
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ValidationError(options.field, `no ${options.notFound} found for '${ref}'`);
  }
  if (!isInside(real, await realpath(base))) {
    // The textual check above passed, so this is a symlink pointing out of
    // the corral — the case that makes rejecting '..' alone insufficient.
    throw new AccessDeniedError(options.resource, ref, options.roles);
  }

  return real;
}

/**
 * Whether `candidate` sits within `root` (or is `root` itself).
 *
 * @param candidate - Absolute path to test.
 * @param root      - Absolute directory.
 */
export function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}
