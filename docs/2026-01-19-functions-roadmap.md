# Functions Roadmap

> **Updated:** 2026-07-24

## Current State

TinyWhale supports the foundations for functions:

- Named function bindings and function type aliases
- Forward declarations
- Direct calls with arity and argument type checking
- Single-expression and multi-line function bodies
- Expression sequences whose final expression supplies the result
- Bindings, matches, panic, and lambdas in the unified expression model

The implementation landed in:

- [#53](https://github.com/nerdalytics/tinywhale/pull/53) — basic functions,
  parameters, direct calls, and forward declarations
- [#54](https://github.com/nerdalytics/tinywhale/pull/54) — initial expression
  unification and simplified record syntax
- [#56](https://github.com/nerdalytics/tinywhale/pull/56) — completed expression
  unification, multi-line bodies, and removal of obsolete statement machinery

Higher-order functions are not implemented. Function types exist in the
checker, but ordinary runtime function values, inline expected-type lambdas,
WebAssembly tables, and indirect calls do not.

## TinyWhale 0.1 Milestone

The next language milestone is non-capturing first-class function values and
higher-order functions.

```tinywhale
Unary = (i32) -> i32

apply_twice = (f: Unary, x: i32): i32 -> f(f(x))
increment: Unary = (n: i32): i32 -> n + 1

named_result: i32 = apply_twice(increment, 5)
inline_result: i32 = apply_twice((n: i32): i32 -> n * 2, 3)
```

Expected results:

- `named_result` evaluates to `7`.
- `inline_result` evaluates to `12`.
- Static calls continue to emit direct WebAssembly calls.
- Calls through function values emit `call_indirect`.
- Capturing lambdas produce a dedicated checker diagnostic until closures
  exist.

Tuples, closures, extern bindings, and aggregate runtime representation are
outside this milestone.

## Implementation Sequence

| Stage | Scope | Status |
|---|---|---|
| Foundations | Basic functions and expression unification | Merged in #53, #54, and #56 |
| Call SemIR | Store explicit argument instruction IDs instead of reconstructing them positionally | Next |
| Bottom type | Separate `Never` from effect-only `None` | Pending |
| Function values | Check named function values, function-valued bindings, and expected-type inline lambdas | Pending |
| Indirect lowering | Emit signatures, a function table, element segments, and `call_indirect` | Pending |
| Typed fuzzing | Generate valid and invalid function programs, including nested calls and captures | Pending |
| Extern bindings | Add host imports and approved WebAssembly intrinsics | Later |
| Runtime values | Choose a shared representation for aggregates and closure environments | Design required |

### 1. Represent Call Arguments Explicitly

The checker computes each argument's `InstId`, but a `Call` currently retains
only the callee instruction and argument count. Code generation reconstructs
arguments from instruction position.

Replace that positional assumption with an explicit argument block or side
table. A call needs:

```text
callee: InstId
arguments: InstBlockId
resultType: TypeId
```

Regression coverage must include arguments that emit nested semantic
instructions:

```tinywhale
identity = (x: i32): i32 -> x
add = (a: i32, b: i32): i32 -> a + b

x: i32 = identity(1 + 2)
y: i32 = add(identity(3), 4 * 5)
```

Both modules must validate and preserve the correct operands.

### 2. Separate `Never` from `None`

`None` represents declarations and effect-only expressions that produce no
value. `Never` represents expressions such as `panic` that do not return.

Add distinct `TypeKind.Never` and `BuiltinTypeId.Never` entries, and make only
`Never` a subtype of every type. `None` must be compatible only with `None`.

### 3. Check Non-Capturing Function Values

Add semantic representation for a function reference, then support:

- Named functions passed as arguments
- Function-valued bindings
- Inline lambdas checked against an expected function type
- Anonymous synthetic function identities
- Indirect-call arity and type validation
- Forward-declared functions used as values once defined
- Signature-based structural equality

The first implementation must reject captures deliberately:

```tinywhale
offset: i32 = 10
add_offset = (n: i32): i32 -> n + offset
# Error: lambda captures `offset`; closures are not implemented
```

### 4. Lower Function Values

Assign stable table indices to runtime function values and intern WebAssembly
signatures. Emit:

- A function table
- Element segments
- `call_indirect` for dynamic callees
- Direct `call` for statically known callees

Generated modules must validate before and after Binaryen optimization.

### 5. Extend Property-Based Testing

Add grammar-aware generators for:

- Function signatures
- Valid non-capturing lambda bodies
- Direct and indirect calls
- Nested call expressions
- Deliberate arity and type mismatches
- Capturing lambdas
- Multiple signatures in one module

Every generated program that passes checking must produce valid WebAssembly.

## Later Work

After higher-order functions:

1. Add extern host bindings so compiled programs can communicate with their
   runtime.
2. Decide aggregate and closure representation in one architecture decision
   record.
3. Implement tuples and closure environments using that shared representation.

The runtime-value decision must cover records, lists, tuples, closure
environments, and the host ABI together. Candidate families include:

- Linear-memory values with explicit layouts and handles
- WebAssembly GC reference types
- A constrained local and multi-value representation

Choosing representation independently for each feature would create
incompatible values and repeated lowering work.

## Verification

Each implementation PR must pass:

```fish
mise run ci
```

Feature PRs must also include focused semantic and WebAssembly validation tests
for their new behavior.
