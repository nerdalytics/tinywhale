# AGENTS.md

TinyWhale is a programming language compiler targeting WebAssembly. It's a pnpm monorepo using mise as the task runner.

## Commands

All tasks run via `mise` (not npm scripts):

- `mise run build` — Build all packages
- `mise run test` — Run tests
- `mise run check` — Lint & format (Biome)
- `mise run typecheck` — TypeScript type checking
- `mise run ci` — Full CI pipeline
