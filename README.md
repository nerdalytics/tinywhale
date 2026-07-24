# TinyWhale

A tiny programming language that compiles to WebAssembly.

## Project Structure

This is a monorepo managed with [pnpm](https://pnpm.io/) workspaces:

- **`packages/compiler`** — TinyWhale compiler library
- **`packages/cli-compiler`** — Compiler command-line interface
- **`packages/grammar-test`** — Grammar testing library
- **`packages/cli-grammar-test`** — Grammar testing command-line interface
- **`packages/diagnostics`** — Shared diagnostic types
- **`packages/lsp`** — Language Server Protocol implementation
- **`packages/cli-lsp`** — Language server command-line interface

## Prerequisites

- [mise](https://mise.jdx.dev/) — development tool version manager and task runner
- Node.js 26.5.0
- pnpm 11.16.0

## Getting Started

1. Install mise if you haven't already:

   ```bash
   curl https://mise.run | sh
   ```

2. Create an ignored `mise.local.toml` so mise can install and activate the
   project runtimes:

   ```toml
   [tools]
   node = "26.5.0"
   pnpm = "11.16.0"
   ```

3. Install the tools and dependencies:

   ```bash
   mise install
   mise run install
   ```

## Available Tasks

All tasks are defined in `mise.toml` and run via mise:

- `mise run install` — install dependencies
- `mise run build` — build all packages
- `mise run test` — run tests
- `mise run check` — lint and format with Biome, applying fixes
- `mise run typecheck` — run TypeScript type checking
- `mise run clean` — remove build artifacts
- `mise run generate-grammar` — regenerate Ohm grammar bundles
- `mise run cli <file>` — run the TinyWhale compiler CLI
- `mise run grammar-test [files]` — run grammar tests
- `mise run grammar-analyze <grammar>` — analyze a grammar

## Development

Use `mise run ci` for the authoritative full check. It generates the compiler
grammar bundles, builds every package, runs Biome without modifying files,
typechecks every workspace, and runs all configured tests.

`package.json` is the source of truth for Node and pnpm versions. Keep its
`engines` and `packageManager` declarations synchronized with
`mise.local.toml`. GitHub Actions generates an ephemeral `.tool-versions` from
those tracked declarations before mise installs the CI runtimes.

## License

MIT
