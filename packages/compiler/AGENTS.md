# packages/compiler

Core compiler: tokenizer, Ohm parser, checker, Binaryen codegen.

## Grammar Changes

After modifying `.ohm` files: `mise run generate-grammar`

## Key Patterns

- Branded integer IDs: `NodeId`, `TokenId`, `InstId`
- Postorder node storage
- Fixed-size SemIR instructions
