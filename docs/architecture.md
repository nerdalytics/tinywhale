# Architecture

## Compiler Pipeline

```
Source → [TOKENIZE] → TokenStore → [PARSE] → NodeStore → [CHECK] → SemIR/InstStore → [EMIT] → WASM
```

## Data-Oriented Design

The compiler follows Carbon's data-oriented architecture:
- Dense arrays with branded integer IDs (`NodeId`, `TokenId`, `InstId`)
- Postorder node storage
- Fixed-size SemIR instructions

## Packages

| Package | Description |
| :--- | :--- |
| `packages/compiler` | Core: tokenizer, Ohm parser, checker, Binaryen codegen |
| `packages/diagnostics` | Shared diagnostic types |
| `packages/cli-compiler` | CLI wrapper (AdonisJS Ace) |
| `packages/cli-grammar-test` | Grammar testing framework |
| `packages/lsp` | Language Server Protocol (in progress) |
| `packages/cli-lsp` | LSP CLI wrapper |
