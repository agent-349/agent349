# CLAUDE.md — Agent349

Guidance for AI coding agents working in this repository. Human contributors:
see [CONTRIBUTING.md](CONTRIBUTING.md), which this file summarizes.

## Project

Agent349 (`agent349` on npm): a Node.js/TypeScript library for running governed
AI agents. Node.js 20+, TypeScript strict, ESM, Vitest, ESLint + Prettier,
tsup.

## Commands

```bash
npm test                  # unit tests (offline)
npm run typecheck         # library
npm run typecheck:examples
npm run lint && npm run format:check
npm run docs:check        # compiles every code sample in README.md and docs/ (not docs/es/)
npm run test:vectorstores # vector store contract vs real engines (docker compose -f tests/integration/vectorstores.compose.yml up -d)
npm run build
```

Run `npm test`, `npm run typecheck` and `npm run docs:check` before
considering a change done.

## Architecture

Layout and dependency rules: [docs/architecture.md](docs/architecture.md#module-layout).

- `types/` and `errors/` depend on nothing. `events/` depends only on `types/`.
  `content/` only on `types/`.
- `tools/`, `skills/`, `llm/`, `memory/`, `session/`, `tokens/` depend on
  `types/`, `events/`, `errors/` (`llm/` and `memory/` also on `content/`).
- `rag/` → `types/`, `events/`, `tools/`, `llm/`. `security/` → `types/`,
  `events/`, `tools/`. `audit/` → `types/`, `events/`. `approval/` → `types/`,
  `events/`, `tools/`, `audit/`. `mcp/` → `types/`, `events/`, `errors/`.
  `config/` → `mcp/`.
- `core/Orchestrator` is the only module that imports from all of them.
- **Never create circular dependencies.** Use the EventBus between modules.
- Public exports go through each module's `index.ts` and `src/index.ts`.

## Conventions

- Named exports only. No `enum` (use unions). No classes for DTOs.
- `abstract class` for pluggable adapters, `interface`/`type` for data.
- Constructor injection. No DI framework.
- `any` only for dynamic user data (tool input/output, metadata), with a
  comment. Prefer `unknown`.
- Custom errors in `src/errors/`, named `*Error`. Never throw strings. Never
  swallow errors.
- async/await for all I/O. Do not mutate inputs.
- The library never writes to stdout/stderr: report through the EventBus.
- No bare `setTimeout` for scheduling.
- JSDoc on public classes and methods (`@param`, `@returns`, `@throws`).
- Files: `PascalCase.ts` for classes, `camelCase.ts` for utilities, `camelCase/`
  directories.

## Tests

- One test file per class under `tests/unit/`, mirroring `src/`.
- Unit tests are offline: `InMemoryAdapter`, mock providers, no real services.
- Optional dependencies (`mssql`, `oracledb`, `mongodb`, …) may or may not be
  installed. Tests must pass either way (see the driver tests for the pattern).

## Documentation

Three levels of authority:

1. **Code and tests** (`src/`, `tests/`) are the final arbiter.
2. **English docs** (`README.md`, `docs/*.md`, `docs/guides/`) are the current,
   maintained documentation, and their samples are compiled by `docs:check`.
   When behavior changes, update the matching guide in the same change.
3. **Spanish manuals** (`docs/es/`) are detailed reference material. They are
   useful for depth, but not verified automatically. If one contradicts the
   code, the manual is wrong.

Code-sample conventions: ` ```ts ` blocks must compile against
`agent349`, ` ```ts nocheck ` marks deliberate fragments, and
` ```json config ` blocks are checked against the config type and loaded
with `ConfigLoader`.

## Configuration

`agent349.config.json` (or an object) with optional sections: `llm`,
`storage`, `memory`, `session`, `agent`, `tools`, `skills`, `agents`,
`connections`, `credentials`, `mcp`, `rag`, `tokens`, `audit`, `logging`,
`appHome`. Secrets are `${ENV_VAR}` references. ACL and approvals are
configured in code. Reference: [docs/configuration.md](docs/configuration.md).
