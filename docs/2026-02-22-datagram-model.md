# Datagram Model

> **Date**: 2026-02-22
> **Status**: Approved design
> **Context**: Retiring the `@` prefix for side-effectful functions in favour of a uniform execution model

---

## 1. The Function Coloring Problem

Bob Nystrom's 2015 post ["What Color is Your Function?"](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/) describes a structural problem that appears in any language with a sync/async split. Each function has a "color": async or sync. A sync function cannot call an async function without itself becoming async. The color spreads upward through the entire call graph — this is contagion.

In TypeScript, an `async` function returns `Promise<T>` instead of `T`. Any function that calls it must either `await` the promise (becoming `async` itself) or accept a `Promise<T>` and deal with it explicitly. Higher-order functions break: a function that accepts a `(x: string) => string` callback cannot receive an `async (x: string) => Promise<string>` without a rewrite. The coloring is not cosmetic — it appears in types, in function signatures, and in the CPS transformation the compiler performs on every `await` boundary.

Even with async/await syntax sugar, Nystrom's point holds: "we're lying to ourselves if we think all of our troubles are gone. As soon as you start trying to write higher-order functions, or reuse code, you're right back to realizing color is still there."

Languages that eliminate the problem do so by keeping functions uniform and pushing the concurrency boundary into the runtime:

- **Go**: No `async` keyword. Any function can yield to the goroutine scheduler. Developers write ordinary-looking code; the Go runtime handles context switching. An I/O call in a goroutine parks the goroutine and resumes it when data arrives — transparently, with no annotation at the call site.
- **Roc**: All functions return `Task` values — descriptions of effects to perform. The platform (runtime) executes them. No function directly performs I/O; they produce data. Composition of effects is ordinary function composition.

The common mechanism: the runtime manages multiple execution stacks and decides when to switch between them. The language does not expose this as a type-system distinction.

---

## 2. TinyWhale's `@` Prefix Was Function Coloring

The original extern bindings design from the [functions roadmap](./2026-01-19-functions-roadmap.md):

```tinywhale
# WASM intrinsics — no prefix
clz: (i32) -> i32
clz = extern wasm "i32.clz"

# Host imports — @ prefix marks side effects
@log: (i32) -> None
@log = extern host "env" "log"
```

The `@` prefix was contagious. A function that called `@log` was itself effectful and required marking:

```tinywhale
@greet = (name: i32): None ->
    @log(name)        # calling @log requires @greet to be @greet
```

This is structurally identical to TypeScript's `async`. Two incompatible worlds: pure functions and `@`-prefixed effectful functions. Higher-order functions accepting effectful callbacks would need to carry the prefix in their type. The problem compounds as the codebase grows.

---

## 3. The Datagram Model

TinyWhale follows Roc's approach: every function virtually returns a datagram — a structured description of instructions for the runtime to execute. The function itself is pure; it maps inputs to a value that may include an effect description. The runtime reads the description and acts.

The word "virtually" is load-bearing. The datagram is a compiler and runtime concern. It does not appear in the language.

**No `@` prefix.** Every function is the same kind of thing. There is no distinction between "effectful" and "pure" at the language level, and therefore nothing to annotate or propagate.

**No `Task` type.** Return types stay as declared. `log: (i32) -> None` does not become `log: (i32) -> Task<None>`. This avoids the need for generic type syntax, which would conflict with TinyWhale's existing use of `<>` for value constraints (`i32<min=0, max=100>`).

**`extern host` generates a datagram constructor**, not a direct host import. The programmer-facing declaration is identical to before, minus the prefix:

```tinywhale
log: (i32) -> None
log = extern host "env" "log"
```

Calling `log(42)` and calling `add(1, 2)` look identical to the programmer. The compiler, not the type system, handles the distinction.

**`extern wasm` is unchanged.** Pure WASM intrinsics (`i32.clz`, `f32.sqrt`, etc.) were never effectful. They remain direct, inline WASM instructions.

---

## 4. WASM/WASI Ecosystem

TinyWhale compiles to WASM targeting WASI runtimes. The datagram model aligns with a direction the WASM ecosystem is converging on across three layers of the stack.

### WASM 3.0 (September 2025)

WASM 3.0 shipped tail calls, exception handling, WasmGC, typed function references, 64-bit memory, and multiple memories. **Stack switching is not in 3.0.**

Relevant to the datagram model:

- **Tail calls** (`return_call`, `return_call_indirect`): Enable functional composition of effect descriptions without stack growth. Chaining datagram operations tail-recursively is now natively supported.
- **Exception handling** (`try_table`, `throw`, `throw_ref`): Could model one-shot effect dispatch, but exceptions cannot be resumed — execution after `throw` is abandoned, not continued. Not suitable for the full datagram model.
- **WasmGC** (struct/array types): Disabled by default in Wasmtime; not supported in Wasmer without the V8 backend. WasmGC structs could represent effect descriptions as typed data with subtype-based dispatch — the idiomatic pattern uses a base struct type with variant subtypes and `br_on_cast` for dispatch. However, Wasmtime's GC implementation shipped a null (bump-allocating) collector in v27.0 and is explicitly documented as not production-ready. TinyWhale's linear memory approach with type tags is universally supported and remains correct.

### WASI 0.3 / Component Model Async (RC January 2026)

WASI 0.3 adds composable concurrency to the Component Model. The key design: `async` is an option on the canonical ABI binding (`canon lift` / `canon lower`), not a property of the WIT function type. A function `func(x: u32) -> u32` has the same type regardless of whether it is lifted synchronously or asynchronously. The Canonical ABI transparently bridges sync-compiled guest code with async host operations.

The specification states directly that this design "avoids the function coloring problem by seamlessly connecting async imports to sync-exported functions and vice versa."

If TinyWhale targets the Component Model, `extern host` bindings map naturally to Component Model async imports. Sync-compiled TinyWhale code calls them via the Canonical ABI machinery, which handles task creation, suspension, and resumption transparently. No source-level annotation is required — exactly the datagram model.

Available experimentally in Wasmtime 37+; Spin v3.5 was the first production runtime with WASIp3 RC support. WASI 1.0 is expected late 2026 or early 2027.

### Stack Switching / Typed Continuations (Phase 3)

The stack-switching proposal adds first-class continuations to core WASM: `cont.new`, `cont.bind`, `resume`, `suspend`, `switch`. It is the native primitive that the datagram model will eventually compile to.

The mechanism: a control tag declares a typed interface for suspension, e.g. `(tag $http_get (param i32) (result i32))`. A TinyWhale function needing an HTTP response emits `suspend $http_get ptr`. Execution transfers to the nearest enclosing `resume ... (on $http_get $handler)`, which installed the handler. The handler receives the request pointer and a reference to the suspended continuation. It performs the HTTP call, then resumes the continuation with the response pointer.

From the compiler's perspective: no whole-program transformation, no state machine splitting, no CPS conversion. Whether a function suspends is a runtime property — determined by whether `suspend` executes — not a compile-time type property. The coloring problem is solved at the instruction level.

Status: Phase 3. Functional on x64 Linux in Wasmtime behind the `wasm_stack_switching` flag. Not production-ready. Chrome implements JSPI instead (a separate, JS-integration-specific mechanism); typed continuations are the more general primitive intended for non-browser WASM environments.

TinyWhale does not need to wait for stack switching. The datagram model is implementable now with linear memory and the entry-point protocol described in the open questions. Stack switching is the intended long-term compilation target — it removes the need for an application-level datagram protocol and makes the execution model native to WASM.

---

## 5. Open Questions

The design decision is made; the implementation details are not.

**Datagram format.** What is the concrete memory layout of an effect description? The [packed memory layout](./implementation/packed-memory-layout.md) and type-tag approach apply, but the specific variant definitions for host operation kinds — their tags, field layouts, and result protocols — are not yet specified.

**Effect composition.** How do multiple host calls in a single function chain? Sequencing (do A then B), branching on results, error handling — none of this is designed.

**Closures with effects** (PR 5 in the functions roadmap). How do closures that perform host operations interact with the datagram model? A closure captures its environment; if the effect description is a return value, the closure's calling convention may need to account for it.

**Component Model targeting.** Will TinyWhale eventually target the WASM Component Model, making `extern host` map to Component Model async imports via the Canonical ABI? Or will TinyWhale maintain a custom datagram protocol for raw WASM?

**Stack switching migration.** When stack switching is production-ready in WASI runtimes, what changes in the TinyWhale compiler? The programmer-facing API is unchanged — only the compilation strategy for `extern host` and the entry-point protocol are affected.
