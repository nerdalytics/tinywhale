# Dispatch Strategies for TinyWhale

> **Date**: 2026-01-24
> **Context**: Brainstorming higher-order functions and multiple dispatch for TinyWhale

---

## Overview

This directory contains detailed educational reports on four dispatch strategies for implementing higher-order functions and multiple dispatch in TinyWhale's WASM backend.

### Background

TinyWhale's design includes:
- **Optional fields** that compile to **union types** (e.g., `Person` with `sex?` becomes `Person$without_sex | Person$with_sex`)
- **Sealed unions** — all variants known at compile time
- **Multiple dispatch** — function called depends on types of ALL arguments, not just the first

### Requirements

From brainstorming session:

1. **O(1) lookup performance** — type lookup must be constant time
2. **Multi-argument dispatch** — dispatch on all arguments, not Go-style first-argument-only
3. **Sealed unions** — no runtime type registration, no duck typing

---

## Strategy Comparison

| Strategy | Dispatch Time | Space Efficiency | Complexity | Recommendation |
|----------|---------------|------------------|------------|----------------|
| [1. Monomorphization + Per-Function Tables](./2026-01-24-dispatch-strategy-1-monomorphization-per-function-tables.md) | O(1) | High | Low | ✅ **Recommended** |
| [2. Global Dispatch Matrix](./2026-01-24-dispatch-strategy-2-global-dispatch-matrix.md) | O(1) | Variable | Medium | ⚠️ Viable |
| [3. Cascading Hierarchical Dispatch](./2026-01-24-dispatch-strategy-3-cascading-hierarchical-dispatch.md) | O(k) | Best for sparse | High | ⚠️ Specialized use |
| [4. Tagged Unions with Switch](./2026-01-24-dispatch-strategy-4-tagged-unions-switch.md) | O(N) worst | Low (code bloat) | Low | ❌ Not recommended |

Where:
- k = number of dispatched arguments
- N = number of type variants

---

## Quick Reference

### Strategy 1: Monomorphization + Per-Function Tables

```
One WASM table per generic function
Table entries = specialized implementations
Direct call when type known, call_indirect when union type
```

**Best for**: Most TinyWhale use cases. O(1) dispatch, clean architecture.

### Strategy 2: Global Dispatch Matrix

```
Single large table for all dispatch
Index = function_id * MAX_TYPES + type_tag
```

**Best for**: Simple codebases where centralized dispatch is preferred.

### Strategy 3: Cascading Dispatch

```
Hierarchy of tables
Level 1 dispatches on arg 1 → Level 2 dispatches on arg 2 → ...
```

**Best for**: Sparse dispatch patterns (not all type combinations valid).

### Strategy 4: Tagged Unions with Switch

```
Explicit if-else chains or br_table
No function tables used
```

**Best for**: Micro-optimizations on hot paths with 2-3 variants only.

---

## Decision Tree

```
Start
  │
  ├─► "Do I need O(1) dispatch?"
  │     │
  │     ├─► Yes ─► Strategy 1 or 2
  │     │           │
  │     │           ├─► "Do I want per-function modularity?" ─► Strategy 1
  │     │           └─► "Do I want single-table simplicity?" ─► Strategy 2
  │     │
  │     └─► No (O(k) acceptable) ─► "Is dispatch sparse?"
  │                                   │
  │                                   ├─► Yes ─► Strategy 3
  │                                   └─► No ─► Strategy 1 (still better)
  │
  └─► "Do I have exactly 2-3 variants on a hot path?"
        │
        └─► Yes ─► Consider Strategy 4 (with profiling data)
```

---

## WASM Capabilities & Constraints

### What We Use (Widely Supported)

| Feature | Support | Usage |
|---------|---------|-------|
| **Multiple tables** | WASM 3.0+ | Per-function dispatch tables |
| **call_indirect** | MVP (always) | Indirect function calls |
| **Linear memory** | MVP (always) | Struct storage with manual layout |

### What We Avoid (Limited Runtime Support)

| Feature | Why Avoid |
|---------|-----------|
| **WasmGC** | Not supported in WASI runtimes (wasmtime, wasmer, etc.) as of 2026 |
| **GC structs** | Requires WasmGC |
| **RTT** | Requires WasmGC |

**Implication**: Type tags are stored manually as the first i32 field in linear memory structs, not via WASM's native RTT mechanism.

### Fallback for Single-Table Environments

If targeting older runtimes with only 1 table, Strategy 2 (Global Matrix) becomes necessary. TinyWhale currently targets WASM 3.0 runtimes with multiple table support.

---

## Relationship to Higher-Order Functions

Higher-order functions (the original topic) require:

1. **Functions as values** — pass functions to other functions
2. **Indirect calls** — call a function through a variable

The dispatch strategies address **indirect calls**. Once a strategy is chosen:

- Higher-order functions become straightforward
- Lambdas compile to function references (table indices)
- Calling through a variable uses the chosen dispatch mechanism

### Example

```tinywhale
apply_twice = (f: (i32) -> i32, x: i32): i32 -> f(f(x))
result = apply_twice((n: i32): i32 -> n + 1, 5)
```

With Strategy 1:
- `(n: i32): i32 -> n + 1` compiles to a function with table index
- `f(x)` compiles to `call_indirect` using `f` as the index
- No union types involved → direct table lookup

---

## Files in This Directory

| File | Description |
|------|-------------|
| `README.md` | This overview document |
| `2026-01-24-dispatch-strategy-1-monomorphization-per-function-tables.md` | Strategy 1: Per-function tables |
| `2026-01-24-dispatch-strategy-2-global-dispatch-matrix.md` | Strategy 2: Single global table |
| `2026-01-24-dispatch-strategy-3-cascading-hierarchical-dispatch.md` | Strategy 3: Hierarchical tables |
| `2026-01-24-dispatch-strategy-4-tagged-unions-switch.md` | Strategy 4: Explicit dispatch |

---

## Next Steps

After reviewing these strategies:

1. **Choose primary strategy** — likely Strategy 1 for TinyWhale
2. **Design type tag layout** — where/how to store tags in structs
3. **Implement basic higher-order functions** — without union dispatch first
4. **Add union dispatch** — once type tags are in place
5. **Consider hybrid approach** — Strategy 1 as default, Strategy 3 for sparse cases

---

## References

- [Julia Methods Documentation](https://docs.julialang.org/en/v1/manual/methods/)
- [How Dynamic Dispatch Works in WebAssembly](https://fitzgen.com/2018/04/26/how-does-dynamic-dispatch-work-in-wasm.html)
- [Playing with Indirect Calls in WebAssembly](https://eli.thegreenplace.net/2023/playing-with-indirect-calls-in-webassembly/)
- [WASM 3.0 Announcement](https://webassembly.org/news/2025-09-17-wasm-3.0/)
- [WebAssembly GC Dynamic Dispatch Discussion](https://github.com/WebAssembly/gc/issues/132)
