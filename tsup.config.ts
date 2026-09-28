import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// tsup auto-externalises `dependencies` and `peerDependencies`, but **not**
// `optionalDependencies`. Left bundled, those packages get their CJS interop
// rewritten and break at runtime in ways that only show up in a consumer's
// module graph ("MongoClient is not a constructor", "Dynamic require of 'ajv'
// is not supported"). They are optional precisely because they load lazily via
// `await import()`, so they must always stay external.
const optionalDeps = Object.keys(
  (JSON.parse(readFileSync('package.json', 'utf-8')) as {
    optionalDependencies?: Record<string, string>;
  }).optionalDependencies ?? {},
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  // Every optionalDependency (mongodb, ioredis, @modelcontextprotocol/sdk, …)
  // stays external — see the note above `optionalDeps`.
  external: optionalDeps,
  // ESM output → index.js, CJS output → index.cjs
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  // Copy JSON assets that are loaded at runtime (not bundled by tsup)
  onSuccess() {
    mkdirSync('dist', { recursive: true });
    copyFileSync(
      join('src', 'config', 'defaults.json'),
      join('dist', 'defaults.json'),
    );
    console.log('Copied src/config/defaults.json → dist/defaults.json');
    return Promise.resolve();
  },
});
