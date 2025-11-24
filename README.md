# TinyWhale

A tiny programming language that compiles to WebAssembly.

## Project Structure

This is a monorepo managed with [pnpm](https://pnpm.io/) workspaces:

- **`packages/compiler`** - The TinyWhale compiler library
- **`packages/cli`** - Command-line interface for TinyWhale
- **`packages/lsp`** - Language Server Protocol implementation

## Prerequisites

- [mise](https://mise.jdx.dev/) - Development tool version manager and task runner
- Node.js 24.11.0 (automatically installed via mise)
- pnpm 10.23.0 (automatically installed via mise)

## Getting Started

1. Install mise if you haven't already:
   ```bash
   curl https://mise.run | sh
   ```

2. Install tools and dependencies:
   ```bash
   mise install
   mise run install
   ```

## Available Tasks

All tasks are defined in `.mise.toml` and run via mise:

- `mise run install` - Install dependencies
- `mise run build` - Build all packages
- `mise run test` - Run tests for all packages
- `mise run lint` - Lint all packages
- `mise run clean` - Clean build artifacts
- `mise run dev` - Run development mode

You can also use `pnpm start <task>` which will execute `mise run <task>`.

## Development

The project uses mise as the task runner. All tasks are defined in `.mise.toml`, and the root `package.json` contains only one script that delegates to mise.

## License

MIT
