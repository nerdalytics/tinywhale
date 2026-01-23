# packages

Monorepo packages with linear dependency flow: `cli → compiler → diagnostics`

| Package | Purpose |
| :--- | :--- |
| [compiler](compiler/AGENTS.md) | Core: tokenize → parse → check → emit |
| [diagnostics](diagnostics/AGENTS.md) | Shared diagnostic types |
| [cli-compiler](cli-compiler/AGENTS.md) | CLI for compiling `.tw` files |
| [grammar-test](grammar-test/AGENTS.md) | Ohm.js grammar testing library |
| [cli-grammar-test](cli-grammar-test/AGENTS.md) | Grammar testing CLI |
| [lsp](lsp/AGENTS.md) | Language Server Protocol |
| [cli-lsp](cli-lsp/AGENTS.md) | LSP CLI wrapper |
