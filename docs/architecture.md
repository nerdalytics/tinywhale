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
