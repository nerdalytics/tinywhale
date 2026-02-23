# Functions Roadmap

This document tracks what the TinyWhale compiler implements for functions and what remains to build.

## Current State

The compiler fully supports:

- **Forward declarations** — syntax `factorial: (i32) -> i32`. Grammar, parser, and checker handle these. Codegen resolves forward declarations atomically with the definition — there is no separate forward-declaration WASM emission.
- **Function definitions** — lambda syntax `(params): ReturnType -> body` bound to a name. All four pipeline phases handle these.
- **Typed parameters** — parameters require explicit type annotations. Type checking validates argument types at call sites.
- **Multi-line function bodies** — expression sequences in an indented block after `->`. The last expression is the return value.
- **Function calls** — `name(arg1, arg2)`. Argument count and types are checked.
- **Return type annotations** — `: ReturnType` before `->`. The checker validates the body expression against the declared type.

Tested in `packages/compiler/test/semantic-specs.test.ts` and `packages/compiler/test/grammar-specs.test.ts`.

**Not yet working:**

- Nested function definitions (inner lambdas whose names are visible in the outer scope). Grammar and parser handle the syntax; checker and codegen do not.
- Recursive calls are structurally supported by forward declarations but are not covered by tests.
- Everything in PR 2–6 below.

---

## PR Status

| PR | Scope | Status |
|----|-------|--------|
| **PR 1** | Basic functions, parameters, calls, forward declarations | ✅ MERGED (#53) |
| **PR 2** | Nested functions, type aliases | Pending |
| **PR 3** | Higher-order functions | Pending |
| **PR 4** | Tuples | Pending |
| **PR 5** | Closures | Pending |
| **PR 6** | Extern bindings | Pending |

---

## PR 2: Nested Functions and Type Aliases

**What to build:**

Nested function definitions — a lambda bound inside another function's body, visible within that scope:

```tinywhale
outer = (x: i32): i32 ->
    helper = (y: i32): i32 -> y * 2
    helper(x)
```

Type aliases by PascalCase convention — no `type` keyword:

```tinywhale
BinaryOp = (i32, i32) -> i32
add: BinaryOp = (a, b) -> a + b
```

**What needs to change:**

- Checker: register inner bindings in a child scope, allow the outer body to reference them
- Codegen: nested functions must emit as top-level WASM functions (WASM has no nested functions); the checker supplies their names

**Dependency:** None. This is the next PR.

---

## PR 3: Higher-Order Functions

**What to build:**

Function values as first-class citizens. A function may be passed as an argument or returned as a value:

```tinywhale
apply_twice = (f: (i32) -> i32, x: i32): i32 -> f(f(x))
result = apply_twice((n: i32): i32 -> n + 1, 5)  # result = 7
```

**What needs to change:**

- Codegen: function values are `i32` table indices. All functions that appear as values must be placed in a WASM function table. Calls through a function-typed variable emit `call_indirect`.
- See `docs/implementation/packed-memory-layout.md` §7 for the full spec.

**Dependency:** PR 2 (nested lambdas must work before lambdas-as-values does).

---

## PR 4: Tuples

**What to build:**

Tuple types, literals, and destructuring:

```tinywhale
div_mod = (a: i32, b: i32): (i32, i32) -> (a / b, a % b)
(quotient, remainder) = div_mod(10, 3)
```

**What needs to change:**

- Grammar: tuple type `(T1, T2)`, tuple literal `(e1, e2)`, tuple destructuring in bindings
- Checker: new `Tuple` type kind, structural equality
- Codegen: WASM multi-value returns

**Dependency:** PR 2.

---

## PR 5: Closures

**What to build:**

Capture of variables from an outer scope:

```tinywhale
make_adder = (x: i32): ((i32) -> i32) ->
    (y: i32): i32 -> x + y

add5 = make_adder(5)
result = add5(3)  # result = 8
```

**Representation:** `{ func_index: i32, env_ptr: i32 }`. The function pointer is a table index; the environment pointer references a heap-allocated struct of captured values. A closure that calls host functions has the same type as one that does not — the environment captures values, not capabilities.

**What needs to change:**

- Checker: free variable analysis — identify variables referenced in an inner lambda that are bound in an outer scope
- Codegen: generate environment struct layout, emit struct allocation at closure definition site, emit environment load at captured-variable access sites
- See `docs/implementation/packed-memory-layout.md` §7.5 for the representation spec.

**Dependency:** PR 3.

---

## PR 6: Extern Bindings

**What to build:**

`extern wasm` for WASM intrinsics and `extern host` for host imports:

```tinywhale
# WASM intrinsic (pure operation, no import needed)
clz: (i32) -> i32
clz = extern wasm "i32.clz"

# Host import (generates a WASM import declaration)
log: (i32) -> None
log = extern host "env" "log"
```

`extern host` generates a standard WASM `import` in the module. The return type stays as declared — there is no `Task` wrapper and no async annotation. Calling `log(42)` emits a WASM `call` to the imported function, exactly as any other function call would. See `docs/2026-02-22-datagram-model.md` for the rationale.

**WASM intrinsic whitelist** (pure operations only):
- Integer arithmetic: `i32.add`, `i32.sub`, `i32.mul`, `i32.div_s`, `i32.div_u`, `i32.rem_s`, `i32.rem_u`
- Bitwise: `i32.and`, `i32.or`, `i32.xor`, `i32.shl`, `i32.shr_s`, `i32.shr_u`, `i32.rotl`, `i32.rotr`
- Bit counting: `i32.clz`, `i32.ctz`, `i32.popcnt`
- Float math: `f32.sqrt`, `f32.abs`, `f32.ceil`, `f32.floor`, `f32.nearest`, `f32.min`, `f32.max`
- Conversions: `i32.wrap_i64`, `i64.extend_i32_s`, `f32.convert_i32_s`, `f32.convert_i32_u`

**What needs to change:**

- Grammar: `extern wasm "opcode"` and `extern host "module" "name"` as valid right-hand sides for a forward-declared binding
- Checker: validate opcode against whitelist for `extern wasm`; register the symbol as an imported function for `extern host`
- Codegen: for `extern wasm`, emit a WASM function that calls the intrinsic; for `extern host`, emit a `module.addFunctionImport`

**Dependency:** PR 2.

---

## Verification Checklist

For each PR before merging:

- [ ] `mise run build` succeeds
- [ ] `mise run test` — all tests pass
- [ ] `mise run check` — no lint errors
- [ ] `mise run typecheck` — no type errors
- [ ] Example files in `examples/` compile and produce valid WASM
