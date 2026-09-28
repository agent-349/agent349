// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // A superset of the build tsconfig: type-aware rules need every linted
        // file to belong to a project, and `tests/` is excluded from the build.
        project: './tsconfig.eslint.json',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      ...tsPlugin.configs['recommended-requiring-type-checking'].rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        // The `_` prefix marks an intentionally discarded binding — used for
        // dropped destructured fields as well as unused parameters.
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',

      // ── Deliberate project policy ──────────────────────────────────────────
      // Adapters implement async contracts (`Promise`-returning abstract
      // methods) whose in-memory implementations have nothing to await. The
      // async signature is the interface, not an oversight — see CLAUDE.md
      // ("todo I/O es async/await").
      '@typescript-eslint/require-await': 'off',

      // The `unsafe-*` family fires on values typed `any`, which CLAUDE.md
      // sanctions at exactly two boundaries: tool input/output payloads and
      // dynamic LLM response data. Both are shaped by the host application and
      // validated at runtime (AJV for tool input), so static narrowing cannot
      // apply. Kept as warnings so new occurrences outside those boundaries
      // stay visible without failing the build.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
    },
  },
  {
    // Tests assert against `any`-typed tool payloads, stub collaborators with
    // partial objects, and use `!` on fixtures they just created. Enforcing the
    // production type-safety rules here produces noise, not safety.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettierConfig,
];
