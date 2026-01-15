# Copilot Code Review Instructions

## Project Overview

TinyWhale is a programming language compiler targeting WebAssembly. It's a pnpm monorepo with:

- `packages/compiler` - Core compiler (Ohm.js parser, Binaryen codegen)
- `packages/cli` - Command-line interface (AdonisJS Ace)
- `packages/diagnostics` - Shared diagnostic types
- `packages/lsp` - Language Server Protocol (not yet implemented)

## Architecture: Data-Oriented Design

The compiler follows Carbon's data-oriented architecture. Key principles:

- **Dense arrays with integer IDs** - No pointer-heavy object graphs
- **Branded types** - `NodeId`, `TokenId`, `TypeId` are numbers with compile-time branding
- **Postorder node storage** - Children precede parent for O(1) subtree access
- **Discriminated unions** - Use `kind` discriminants for type narrowing

```typescript
// Correct pattern
type BlockContext = TypeDeclContext | RecordLiteralContext | NestedRecordInitContext

// Check for this anti-pattern
interface BadContext {
  kind: string
  optionalField?: T  // Avoid optional fields when discriminated union works
}
```

## Code Standards

### TypeScript
- Strict mode enabled, no `any` types
- Use branded types for IDs: `as NodeId`, `as TokenId`
- Prefer discriminated unions over optional properties
- Use `satisfies` for type validation while preserving inference

### Formatting (Biome)
- Tab indentation, 100 char line width
- Single quotes, semicolons as needed

## Security Critical Issues

- Check diagnostic messages don't leak sensitive paths
- Validate all user input in CLI before processing
- No dynamic code execution or arbitrary code evaluation
- Sanitize file paths in error messages

## Performance Red Flags

- **Avoid object allocation in hot paths** - Reuse objects, use integer IDs
- **No array copying in loops** - Use indices into existing arrays
- **Watch for O(n²) in node traversal** - Use postorder properties
- **Prefer `for` over `.forEach`** - Better optimization

```typescript
// Red flag: creates new array
nodes.filter(n => n.kind === kind).map(n => process(n))

// Better: single pass with reused array
for (const [id, node] of store) {
  if (node.kind === kind) process(id, node)
}
```

## Testing Requirements

- **Property-based tests** for compiler invariants (fast-check)
- **Unit tests** for specific error cases and edge conditions
- Tests must not depend on execution order
- Use `node --test` runner (not Jest/Mocha)

```typescript
// Good: property test covers many cases
it('arithmetic operations compile to valid WASM', () => {
  fc.assert(fc.property(operatorArb, typeArb, (op, type) => {
    // Test invariant holds for all combinations
  }))
})
```

## Code Quality Essentials

- Functions under 50 lines (extract helpers)
- No dead code or unused imports
- Diagnostic codes must be defined in `@tinywhale/diagnostics`
- Use `as DiagnosticCode` for type safety

## Review Checklist

1. Does it follow data-oriented patterns (IDs, not object refs)?
2. Are discriminated unions used instead of optional fields?
3. Are there property-based tests for new compiler features?
4. Do diagnostic messages follow existing patterns?
5. Is there unnecessary allocation in hot paths?
