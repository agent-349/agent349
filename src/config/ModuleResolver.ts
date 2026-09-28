import { isAbsolute, resolve as resolvePath, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModuleResolutionError } from '../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// ModuleResolver
// ─────────────────────────────────────────────────────────────────────────────

/** Options controlling how relative module specifiers are resolved. */
export interface ModuleResolverOptions {
  /**
   * Application home directory used as the base for relative module paths.
   * If itself relative, it is resolved against `configDir` then `process.cwd()`.
   */
  appHome?: string;
  /**
   * Directory of the loaded config file. Used as the fallback base for relative
   * paths when `appHome` is not set, and to resolve a relative `appHome`.
   */
  configDir?: string;
  /**
   * Optional allowlist of root directories. When set, every resolved file path
   * must live inside one of these roots (guards against path traversal).
   * Relative roots are resolved against `configDir` then `process.cwd()`.
   */
  moduleRoots?: string[];
}

/**
 * Resolves a declarative tool's `module` specifier into an importable target
 * for ESM dynamic `import()`.
 *
 * ### Resolution rules
 * 1. **Bare specifier** (does not start with `'.'` and is not absolute, e.g.
 *    `'@acme/tools'`): returned unchanged so Node resolves it as a package.
 * 2. **Absolute path**: converted to a `file://` URL.
 * 3. **Relative path** (`'./x'`, `'../x'`): resolved against `appHome`, then
 *    `configDir`, then `process.cwd()`, and converted to a `file://` URL.
 *
 * The SDK's own directory is never used as a base — that would break after the
 * library is bundled and installed under `node_modules`.
 *
 * @example
 * ```typescript
 * const resolver = new ModuleResolver({ appHome: '/srv/app', moduleRoots: ['/srv/app'] });
 * const href = resolver.resolve('./tools/calculator.js');
 * const mod = await import(href);
 * ```
 */
export class ModuleResolver {
  readonly #appHome: string | undefined;
  readonly #configDir: string | undefined;
  readonly #moduleRoots: string[] | undefined;

  constructor(options: ModuleResolverOptions = {}) {
    this.#appHome = options.appHome;
    this.#configDir = options.configDir;
    this.#moduleRoots = options.moduleRoots;
  }

  /**
   * Resolves a module specifier to an importable string.
   *
   * @param specifier - The `module` field of a tool definition.
   * @returns A bare package specifier, or a `file://` URL for path specifiers.
   * @throws {@link ModuleResolutionError} if the specifier is empty, still
   *         contains an unresolved `${VAR}` placeholder, or escapes the
   *         configured `moduleRoots` allowlist.
   */
  resolve(specifier: string): string {
    if (typeof specifier !== 'string' || specifier.trim() === '') {
      throw new ModuleResolutionError(String(specifier), 'specifier is empty');
    }
    if (specifier.includes('${')) {
      throw new ModuleResolutionError(specifier, 'contains an unresolved ${ENV_VAR} placeholder');
    }

    // 1. Bare specifier → let Node resolve it as a package.
    if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
      return specifier;
    }

    // 2/3. Absolute or relative path → resolve to an absolute file path.
    const absPath = isAbsolute(specifier)
      ? specifier
      : resolvePath(this.#relativeBase(), specifier);

    this.#assertWithinRoots(absPath, specifier);

    return pathToFileURL(absPath).href;
  }

  /** Base directory for relative specifiers: appHome → configDir → cwd. */
  #relativeBase(): string {
    if (this.#appHome !== undefined) {
      return isAbsolute(this.#appHome)
        ? this.#appHome
        : resolvePath(this.#configDir ?? process.cwd(), this.#appHome);
    }
    return this.#configDir ?? process.cwd();
  }

  /** Enforces the optional `moduleRoots` allowlist. */
  #assertWithinRoots(absPath: string, specifier: string): void {
    if (this.#moduleRoots === undefined || this.#moduleRoots.length === 0) {
      return;
    }

    const base = this.#configDir ?? process.cwd();
    const inSomeRoot = this.#moduleRoots.some((root) => {
      const absRoot = isAbsolute(root) ? root : resolvePath(base, root);
      const rel = relative(absRoot, absPath);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });

    if (!inSomeRoot) {
      throw new ModuleResolutionError(
        specifier,
        `resolved path '${absPath}' is outside the allowed moduleRoots`,
      );
    }
  }
}
