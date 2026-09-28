# Contributing to Agent349

Thank you for considering a contribution. This document explains how to set up
the project, the conventions the codebase follows, and what a pull request
needs to be merged.

## Development setup

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/agent-349/agent349.git
cd agent349
npm install
npm test
```

| Command                                 | Purpose                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                              | Unit tests (offline, no services required)                                                                                                             |
| `npm run test:int`                      | Integration tests (need real services, see `tests/integration/`)                                                                                       |
| `npm run test:vectorstores`             | Vector store contract and end-to-end tests against real engines (start them with `docker compose -f tests/integration/vectorstores.compose.yml up -d`) |
| `npm run test:cov`                      | Coverage report                                                                                                                                        |
| `npm run typecheck`                     | Type-check the library                                                                                                                                 |
| `npm run typecheck:examples`            | Type-check the examples                                                                                                                                |
| `npm run lint` / `npm run format:check` | ESLint and Prettier                                                                                                                                    |
| `npm run docs:check`                    | Type-check every code sample in the English docs and load every config sample                                                                          |
| `npm run build`                         | Build `dist/` (ESM, CJS and type declarations)                                                                                                         |
| `npm run example:quickstart`            | Run the offline quickstart                                                                                                                             |

CI runs all of the offline checks on every pull request.

## Before you start

- For anything beyond a small fix, open an issue first so the approach can be
  agreed before you invest time.
- Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## Architecture rules

The layout and dependency rules are described in
[docs/architecture.md](docs/architecture.md#module-layout). In short:

- Dependencies point inward: `types/` and `errors/` depend on nothing,
  `events/` only on `types/`. `core/Orchestrator` is the only module that wires
  everything together.
- **No circular dependencies.** Modules that need to react to each other
  communicate through the EventBus.
- Pluggable infrastructure is an `abstract class` (for example `StorageAdapter`,
  `LLMProvider`); plain data contracts are `interface` or `type`.
- Dependencies are injected through constructors. There is no DI framework.

## Code conventions

- TypeScript in strict mode, ES modules, Node.js 20+.
- Named exports only (no `default export`). Public API is re-exported from each
  module's `index.ts` and from `src/index.ts`.
- No `enum`: use union types. No classes for DTOs: use `interface`/`type`.
- Avoid `any`. It is accepted only for genuinely dynamic user data (tool input
  and output, metadata), with a comment. Prefer `unknown`.
- Errors are custom classes extending `Error`, named `*Error`, in `src/errors/`.
  Never throw strings. Never swallow errors in `catch`: rethrow, report through
  the EventBus, or handle explicitly.
- All I/O is `async`/`await`. Inputs are not mutated (`structuredClone` or
  spread).
- The library never writes to stdout or stderr. Report through the EventBus.
- No bare `setTimeout` for scheduling. Anything periodic must be managed and
  cleaned up on shutdown.
- Naming: `PascalCase` for classes, interfaces and types (no `I` prefix);
  `PascalCase.ts` files for classes and `camelCase.ts` for utilities;
  `camelCase/` directories; `UPPER_SNAKE_CASE` constants.
- JSDoc on every public class and method (description, `@param`, `@returns`,
  `@throws`). Inline comments only for non-obvious logic.

## Tests

- Every class has a test file (`ToolRegistry.ts` → `ToolRegistry.test.ts`)
  under `tests/unit/`, mirroring `src/`.
- Unit tests must run offline: use `InMemoryAdapter` and mock providers, never
  real Redis, MongoDB or LLM APIs.
- Optional dependencies may or may not be installed. Tests must not depend on
  either.
- A new vector store adapter must pass the shared contract in
  `tests/fixtures/vectorStoreContract.ts` against the real engine (add it to
  `tests/integration/vectorstores.test.ts` and the compose file).
- Target coverage: 80% for business logic, 60% for adapters.

## Documentation

- Behavior changes update the matching guide in `docs/` in the same pull
  request.
- Code samples in `docs/` and `README.md` are compiled by `npm run docs:check`.
  Use ` ```ts ` for runnable samples, ` ```ts nocheck ` only for
  deliberate fragments, and ` ```json config ` for configuration.
- The Spanish manuals in `docs/es/` are reference material. Keeping them in
  sync is welcome, but not required for a pull request.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(rag): …`, `fix(security): …`, `docs: …`, `chore: …`. Mark breaking
  changes with `!` and a `BREAKING CHANGE:` footer.
- Keep pull requests focused. Refactors and behavior changes go in separate PRs.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for
  user-visible changes.
- Fill in the pull request template, including how you tested the change.

## Releases

Maintainers release from `main` by tagging `vX.Y.Z` after updating the
changelog and `package.json` version. The release workflow builds, tests and
publishes to npm with provenance.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
