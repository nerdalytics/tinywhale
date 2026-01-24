# Functions Roadmap

## Overview

Add first-class functions to TinyWhale with the following capabilities:
- Named functions and lambdas (same syntax)
- Forward declarations for recursion
- Higher-order functions (functions as values)
- Tuple return types with destructuring
- Extern bindings (WASM intrinsics and host imports)
- Shadowing warnings for function types

## PR Status

| PR | Scope | Status | Notes |
|----|-------|--------|-------|
| **PR 1** | Basic functions, parameters, calls, forward declarations | ✅ **MERGED** | [#53](https://github.com/nerdalytics/tinywhale/pull/53) - Single-expression bodies only |
| **PR 2** | Expression unification (everything is an expression) | Pending | **Replaces old PR 4** — See [expression-unification.md](../../docs/plans/2026-01-21-expression-unification.md) |
| **PR 3** | Higher-order functions, lambdas as expressions | Pending | Depends on PR 2 |
| **PR 4** | Tuples: types, literals, destructuring | Pending | Depends on PR 2 |
| **PR 5** | Closures (variable capture) | Pending | Depends on PR 2 |
| **PR 6** | Extern bindings: `extern wasm`, `extern host` | Pending | Depends on PR 2 |

## Design Change: Expression Unification

During PR 1 implementation, we discovered that the statement/expression split creates unnecessary complexity. **PR 2 now implements expression unification** — everything becomes an expression:

- Bindings evaluate to `None`
- Type definitions evaluate to `None`
- `panic` evaluates to `Never`
- Function bodies are expression sequences (last expression is return value)
- No `type` keyword — PascalCase identifies types

This change simplifies the grammar and enables multi-line function bodies and nested definitions naturally.

See full design: [docs/plans/2026-01-21-expression-unification.md](../../docs/plans/2026-01-21-expression-unification.md)

## Known Limitations (PR 1)

The following features don't work yet due to `LambdaBody = Expression` (no block support):

```tinywhale
# ❌ Multi-line function bodies
factorial = (n: i32): i32 ->
    match n              # ERROR: body must be single expression
        0 -> 1
        _ -> n * factorial(n - 1)

# ❌ Nested function definitions
outer = (x: i32): i32 ->
    helper = (y: i32): i32 -> y * 2   # ERROR: can't define functions in body
    helper(x)

# ❌ Mutual recursion (forward decl works, calling doesn't)
is_even: (i32) -> i32
is_odd: (i32) -> i32
is_even = (n: i32): i32 -> is_odd(n)  # ERROR: is_odd not yet defined
```

**What works:**
```tinywhale
# ✅ Single-expression functions
double = (x: i32): i32 -> x * 2
add = (a: i32, b: i32): i32 -> a + b

# ✅ Forward declarations
factorial: (i32) -> i32

# ✅ Function calls
result:i32 = double(21)
```

**These limitations are resolved by PR 2 (expression unification).**

---

## Syntax Design (Target)

### Named Functions

```tinywhale
# Single expression body (works now)
double = (x: i32): i32 -> x * 2

# Multi-line body (requires PR 2)
factorial: (i32) -> i32
factorial = (n: i32): i32 ->
    match n
        0 -> 1
        _ -> n * factorial(n - 1)
```

### Type Aliases (PR 2 — no `type` keyword)

```tinywhale
Person                            # PascalCase + block = record type
    id: i32
    age: i32

BinaryOp = (i32, i32) -> i32      # PascalCase = type alias
Percentage = i32<min=0, max=100>  # bounded type alias

add: BinaryOp = (a, b) -> a + b   # value binding with type alias
```

### Higher-Order Functions (PR 3)

```tinywhale
apply_twice = (f: (i32) -> i32, x: i32): i32 -> f(f(x))
result = apply_twice((n: i32): i32 -> n + 1, 5)  # result = 7
```

### Tuple Returns (PR 4)

```tinywhale
div_mod = (a: i32, b: i32): {i32, i32} -> {a / b, a % b}
{quotient, remainder} = div_mod(10, 3)
```

### Extern Bindings (PR 6)

```tinywhale
# WASM intrinsics
clz: (i32) -> i32
clz = extern wasm "i32.clz"

# Host imports (with @ prefix for effects)
@log: (i32) -> None
@log = extern host "env" "log"
```

---

## PR 2: Expression Unification

**This PR replaces the old PR 4 (Nested Functions and Multi-line Bodies).**

See detailed plan: [docs/plans/2026-01-21-expression-unification.md](../../docs/plans/2026-01-21-expression-unification.md)

### Core Changes

1. Remove statement/expression distinction — everything is an expression
2. Remove `type` keyword — PascalCase identifies types
3. Bindings, type definitions, forward declarations evaluate to `None`
4. `panic` evaluates to `Never`
5. Expression sequences: last expression is the return value

### What This Enables

- Multi-line function bodies (expression sequences)
- Nested function definitions (bindings inside bindings)
- Cleaner grammar (no `Statement` rule)

---

## PR 3: Higher-Order Functions and Lambdas

### Scope
- Function types as first-class values
- Lambdas as expressions (not just bound)
- Passing functions as arguments
- Type inference for lambda parameters from context

### Grammar Changes

```ohm
// Lambda becomes a valid Expression
Expression += Lambda

// Function parameter can have function type
Parameter = identifier colon TypeRef  // TypeRef includes FuncType
```

### Implementation Steps

1. Allow Lambda in expression position
2. Handle function-typed parameters
3. Support calling through variables (indirect calls)
4. Type inference from parameter context

---

## PR 4: Tuples

### Scope
- Tuple types: `{T1, T2, ...}`
- Tuple literals: `{expr1, expr2, ...}`
- Tuple destructuring: `{a, b} = expr`

### Grammar

```ohm
TupleType = lbrace TypeList rbrace
TupleLiteral = lbrace ExpressionList rbrace
TupleBinding = TuplePattern equals Expression
TuplePattern = lbrace PatternList rbrace
PatternList = (identifier | underscore) (comma (identifier | underscore))*
```

### Implementation Steps

1. Add Tuple to TypeKind
2. Handle tuple literals
3. Handle tuple destructuring
4. Codegen for tuples (WASM multi-value or struct)

---

## PR 5: Closures

### Scope
- Identify free variables in nested functions
- Generate environment structs for captured variables
- Closure conversion in codegen

### Implementation Steps

1. Track variable references across scope boundaries
2. Identify captured variables (free variables)
3. Generate environment struct type
4. Modify function signature to accept environment
5. Emit closure construction at definition site
6. Emit environment access in closure body

---

## PR 6: Extern Bindings

### Scope
- `extern wasm "opcode"` for WASM intrinsics
- `extern host "module" "function"` for host imports
- `@` prefix requirement for host imports
- Opcode whitelist

### Grammar

```ohm
FuncExpr = ExternWasm | ExternHost | Lambda
ExternWasm = externKeyword wasmKeyword stringLiteral
ExternHost = externKeyword hostKeyword stringLiteral stringLiteral

externKeyword = "extern" ~identifierPart
wasmKeyword = "wasm" ~identifierPart
hostKeyword = "host" ~identifierPart
```

### WASM Intrinsic Whitelist

Pure operations only:
- Integer arithmetic: `i32.add`, `i32.sub`, `i32.mul`, `i32.div_s`, etc.
- Bitwise: `i32.and`, `i32.or`, `i32.xor`, `i32.shl`, etc.
- Bit counting: `i32.clz`, `i32.ctz`, `i32.popcnt`
- Float math: `f32.sqrt`, `f32.abs`, `f32.ceil`, `f32.floor`, etc.
- Conversions: `i32.wrap_i64`, `f32.convert_i32_s`, etc.

---

## Type System (Reference)

### Type Kinds

```typescript
enum TypeKind {
  None, I32, I64, F32, F64, Distinct, Record, List, Refined,
  Func,   // (params) -> return  ✅ Implemented
  Tuple,  // {T1, T2, ...}       Pending (PR 4)
}
```

### Type Compatibility

- `Never` is subtype of all types (bottom type)
- `None` only compatible with `None`
- Func types use structural equality
- Tuple types use structural equality

---

## Verification Checklist

For each PR:
- [ ] `mise run build` succeeds
- [ ] `mise run test` all pass
- [ ] `mise run check` no lint errors
- [ ] `mise run typecheck` no type errors
- [ ] Example files compile and produce valid WASM
