# Packed Memory Layout & Dispatch

> **Status**: Approved Design
> **Date**: 2026-01-24
> **Context**: Moving from "flattened locals" to "linear memory structs" to support optional fields, union types, and higher-order functions.

---

## 1. Overview

TinyWhale is transitioning its backend memory model to support advanced features like **optional fields**, **union types**, **higher-order functions**, and **recursive structures**.

- **Current Model**: "Flattened Locals" (Records are exploded into individual WASM locals).
- **New Model**: "Linear Memory Objects" (Records are stored as contiguous bytes in WASM linear memory; variables hold `i32` pointers).

This document specifies:
- **Packed Layout** for memory-efficient struct storage
- **Monomorphization + Per-Function Tables** for dispatch (Strategy 1)
- **Static Dispatch Bypass** when concrete types are known
- **Higher-Order Functions** as table indices

---

## 2. Design Rationale

### 2.1 Why Packed Layout (Not Fixed)

We evaluated two memory layout strategies:

| Aspect | Packed | Fixed |
|--------|--------|-------|
| Memory per instance | Minimal (absent fields = 0 bytes) | Maximum (all fields allocated) |
| Field offsets | Variable (depend on variant) | Constant |
| Generic field access | Not possible | Possible |
| Code generation | Monomorphization required | Generic code possible |

**Decision: Packed Layout**

Rationale:
1. **Memory efficiency** — Important for WASM environments with limited memory
2. **Monomorphization is acceptable** — TinyWhale is fully statically typed with sealed unions; the compiler knows all types at compile time
3. **Dispatch overhead is rare** — Only at true polymorphic boundaries (function parameters typed as union); most call sites know the concrete type and bypass dispatch entirely
4. **Inside specialized functions, field access is direct** — No dispatch per field, just constant-offset loads

### 2.2 Why No WasmGC Dependency

WasmGC is not yet supported in WASI runtimes (wasmtime, wasmer) as of 2026. TinyWhale uses:
- Linear memory for struct storage
- Manual type tags (not WASM RTT)
- Standard function tables (supported since WASM MVP)

This ensures compatibility with all major WASM runtimes.

---

## 3. Core Concepts

### 3.1 The Standard Object Header

Every complex object in linear memory (Records, Unions) begins with a mandatory 4-byte header.

```
+-------------------+ (Offset 0)
| type_tag (i32)    | → Identifies the concrete variant at runtime
+-------------------+
```

- **Type Tag**: An `i32` integer uniquely identifying the concrete structural variant.
- **Access**: `i32.load` at offset `0` is always safe for any non-null object pointer.
- **Lookup**: O(1) — single memory load.

### 3.2 Sealed Unions

All types in TinyWhale are "sealed" at compile time:
- **Records with Optionals** compile to **Union Types**
- A record with N optional fields expands to 2^N concrete variants
- All variants are known during compilation, enabling full monomorphization
- No runtime type registration, no duck typing

### 3.3 Primitives and Function Values

Not everything needs a type tag:

| Type | Representation | Tag? |
|------|---------------|------|
| `i32`, `i64`, `f32`, `f64` | WASM primitive | No |
| Record (no optionals) | Linear memory struct | No (single variant) |
| Record (with optionals) | Linear memory struct | Yes |
| Explicit union | Linear memory struct | Yes |
| Function value | `i32` table index | No |

---

## 4. Memory Layout: Packed Strategy

### 4.1 Layout Rules

1. **Anchor**: Bytes 0-3 are always the `type_tag` (for types requiring dispatch)
2. **Required Fields**: Appear immediately after the tag, in definition order. Offsets are constant across all variants.
3. **Optional Fields**: Follow required fields.
   - If **present**: Occupies `sizeof(type)` bytes
   - If **absent**: Occupies 0 bytes
   - Subsequent fields shift to fill gaps

### 4.2 Example: Multiple Optionals

```tinywhale
Widget
    id: i32        # Required
    w?: i32        # Optional (bit 0)
    h?: i32        # Optional (bit 1)
    d?: i32        # Optional (bit 2)
```

**Variant Layouts**:

| Tag | Binary | Present | Layout (Offsets) | Size |
|-----|--------|---------|------------------|------|
| 0 | `000` | (none) | `0:tag` `4:id` | 8 |
| 1 | `001` | w | `0:tag` `4:id` `8:w` | 12 |
| 2 | `010` | h | `0:tag` `4:id` `8:h` | 12 |
| 3 | `011` | w,h | `0:tag` `4:id` `8:w` `12:h` | 16 |
| 4 | `100` | d | `0:tag` `4:id` `8:d` | 12 |
| 5 | `101` | w,d | `0:tag` `4:id` `8:w` `12:d` | 16 |
| 6 | `110` | h,d | `0:tag` `4:id` `8:h` `12:d` | 16 |
| 7 | `111` | w,h,d | `0:tag` `4:id` `8:w` `12:h` `16:d` | 20 |

### 4.3 Tag Assignment: Bitmask Encoding

For records with optional fields, tags use **bitmask encoding**:
- Bit k corresponds to the k-th optional field (0-indexed)
- `0` = absent, `1` = present

Benefits:
- O(1) presence check: `(tag & (1 << k)) != 0`
- Tag value directly encodes which fields are present
- Predictable: tag 5 = `0b101` = fields 0 and 2 present

For explicit unions (not derived from optionals), tags are sequential: 0, 1, 2, ...

### 4.4 Local Records: Future Optimization

Records that never escape their defining scope could theoretically remain as flattened WASM locals (faster access). However:

- **Current design**: All records use linear memory for simplicity
- **Rationale**: Records exist to pass structured data around; local-only records are rare
- **Future**: Escape analysis could optimize this (`pushScope`/`popScope` = escapes, "maybe escapes" = escapes)

This is deferred until profiling shows it matters.

### 4.5 Nested Records

When a record contains another record:

```tinywhale
Point
    x: i32
    y: i32

Rect
    origin: Point
    size: Point
```

**Strategy: Inline (Flat) Embedding**

```
Rect layout (no optionals, no tag needed):
  Offset 0:  origin.x (i32)
  Offset 4:  origin.y (i32)
  Offset 8:  size.x (i32)
  Offset 12: size.y (i32)
  Total: 16 bytes
```

Nested records are inlined. This avoids pointer indirection and simplifies memory management. The trade-off is that nested records cannot be shared (each Rect has its own copy of Points).

If the nested record has optional fields, its variants affect the parent's variant count.

---

## 5. Dispatch Strategy: Monomorphization + Per-Function Tables

### 5.1 When Dispatch Is Needed

Dispatch is **only needed at polymorphic boundaries**:

| Scenario | Dispatch? |
|----------|-----------|
| Function parameter typed as union | Yes |
| Return value from function returning union | Yes |
| Element from collection of union type | Yes |
| Local variable with known concrete type | No |
| Field access inside specialized function | No |

### 5.2 Compile-Time Specialization

For every function accepting a union type, the compiler generates:

1. **Specialized Variants**: One function per concrete variant
2. **Dispatch Table**: WASM `table` with entries indexed by type_tag
3. **Dispatch Wrapper**: Entry point that reads tag and calls indirect

### 5.3 Static Dispatch Bypass

**Key optimization**: When the caller knows the concrete type, bypass the dispatch wrapper entirely.

```tinywhale
# Caller knows concrete type
main = () -> i32
    w = Widget { id = 1, w = 10, d = 5 }  # Tag 5 known at compile time
    get_depth(w)                           # Emit: call $get_depth$5 (direct!)
```

```wasm
;; Generated: direct call to specialized variant
(call $get_depth$5 (local.get $w))
```

**When type is NOT known** (polymorphic):

```tinywhale
# Caller has union type
process = (w: Widget) -> i32   # w could be any variant
    get_depth(w)               # Emit: call $get_depth (dispatch wrapper)
```

```wasm
;; Generated: call through dispatch wrapper
(call $get_depth (local.get $w))
```

### 5.4 Code Generation Example

**Source**:
```tinywhale
get_depth = (w: Widget) -> i32
    match w.d
        val -> val
        _ -> 0
```

**Generated WASM**:
```wasm
;; Dispatch table (8 variants for 3 optional fields)
(table $get_depth$dispatch 8 8 funcref)
(elem (table $get_depth$dispatch) (i32.const 0)
    $get_depth$0 $get_depth$1 $get_depth$2 $get_depth$3
    $get_depth$4 $get_depth$5 $get_depth$6 $get_depth$7)

;; Dispatch wrapper (only called when type unknown)
(func $get_depth (param $w i32) (result i32)
    (call_indirect $get_depth$dispatch (type $i32_to_i32)
        (local.get $w)                 ;; Argument
        (i32.load (local.get $w))))    ;; Index = type_tag

;; Specialized variant: Tag 5 (w,d present) — d at offset 12
(func $get_depth$5 (param $w i32) (result i32)
    (i32.load offset=12 (local.get $w)))

;; Specialized variant: Tag 0 (no optionals) — d missing
(func $get_depth$0 (param $w i32) (result i32)
    (i32.const 0))

;; Specialized variant: Tag 7 (w,h,d present) — d at offset 16
(func $get_depth$7 (param $w i32) (result i32)
    (i32.load offset=16 (local.get $w)))
```

---

## 6. Multi-Argument Dispatch

When a function has multiple union-typed parameters:

```tinywhale
combine = (a: Widget, b: Widget) -> Widget
```

### 6.1 Flattened Index Calculation

For two parameters with V1 and V2 variants respectively:

```
index = a.tag * V2 + b.tag
```

**Example**: Widget has 8 variants (tags 0-7)
```
Table size: 8 × 8 = 64 entries
Index for (a.tag=5, b.tag=3): 5 * 8 + 3 = 43
```

### 6.2 Code Generation

```wasm
;; Dispatch table for combine (64 entries)
(table $combine$dispatch 64 64 funcref)

;; Dispatch wrapper
(func $combine (param $a i32) (param $b i32) (result i32)
    (call_indirect $combine$dispatch (type $i32_i32_to_i32)
        (local.get $a)
        (local.get $b)
        ;; Index = a.tag * 8 + b.tag
        (i32.add
            (i32.mul
                (i32.load (local.get $a))
                (i32.const 8))
            (i32.load (local.get $b)))))

;; Specialized variant: a=Tag5, b=Tag3
(func $combine$5$3 (param $a i32) (param $b i32) (result i32)
    ;; Compiler knows exact layout of both a and b
    ...)
```

### 6.3 Static Bypass for Multi-Argument

When both types are known, emit direct call:

```tinywhale
a = Widget { id = 1, w = 10, d = 5 }  # Tag 5
b = Widget { id = 2, h = 20 }          # Tag 2
result = combine(a, b)                  # Emit: call $combine$5$2
```

---

## 7. Higher-Order Functions

### 7.1 Function Values as Table Indices

Function values are represented as `i32` integers — indices into a function table.

```tinywhale
double = (x: i32): i32 -> x * 2
triple = (x: i32): i32 -> x * 3

# 'double' and 'triple' are i32 values (table indices)
```

**No object header needed** for function values. They are not heap-allocated.

### 7.2 Function Tables

All functions that may be called indirectly are placed in a function table:

```wasm
;; Function table for (i32) -> i32 functions
(table $funcs_i32_to_i32 10 funcref)
(elem (table $funcs_i32_to_i32) (i32.const 0)
    $double    ;; index 0
    $triple    ;; index 1
    ...)
```

The compiler tracks which functions are used as values and assigns table indices.

### 7.3 Passing Functions as Arguments

```tinywhale
apply_twice = (f: (i32) -> i32, x: i32): i32 -> f(f(x))

result = apply_twice(double, 5)  # double is table index 0
```

**Generated WASM**:
```wasm
(func $apply_twice (param $f i32) (param $x i32) (result i32)
    ;; f(f(x)) — two indirect calls
    (call_indirect $funcs_i32_to_i32 (type $i32_to_i32)
        (call_indirect $funcs_i32_to_i32 (type $i32_to_i32)
            (local.get $x)
            (local.get $f))
        (local.get $f)))

;; Call site: apply_twice(double, 5)
(call $apply_twice
    (i32.const 0)    ;; double's table index
    (i32.const 5))
```

### 7.4 Lambdas

Lambdas without captures are identical to named functions — they get a table index.

```tinywhale
result = apply_twice((n: i32): i32 -> n + 1, 5)
```

The anonymous lambda is compiled to a function (e.g., `$lambda$0`), added to the table, and its index is passed.

### 7.5 Closures (Future Work)

Closures that capture variables require additional machinery:
- Environment struct holding captured values
- Closure representation: `{ func_index: i32, env_ptr: i32 }`
- Modified calling convention to pass environment

This is deferred to a later phase (PR 5 per functions roadmap).

---

## 8. Type Flow and Static Tracking

### 8.1 Concrete Type Propagation

The compiler tracks concrete types through the program:

```tinywhale
w1 = Widget { id = 1, w = 10 }       # Type: Widget$Tag1
w2 = Widget { id = 2, d = 5 }        # Type: Widget$Tag4
w3 = if cond then w1 else w2         # Type: Widget (union of Tag1, Tag4)
```

For `w1` and `w2`, concrete types are known → direct calls to specialized functions.
For `w3`, type is a union → dispatch needed.

### 8.2 Narrowing via Match

Pattern matching narrows types:

```tinywhale
process = (w: Widget) -> i32
    match w.d
        val ->
            # Here, compiler knows w has 'd' present
            # Can use specialized code for tags 4,5,6,7
            val * 2
        _ ->
            # Here, compiler knows w does NOT have 'd'
            # Can use specialized code for tags 0,1,2,3
            0
```

### 8.3 Explicit Casts

TinyWhale uses explicit casting functions for type transitions:

```tinywhale
# Cast widens type (always safe)
widen_to_widget = (w: Widget$Tag5) -> Widget
    w

# Cast narrows type (may fail)
narrow_to_tag5 = (w: Widget) -> Widget$Tag5?
    if w.__tag == 5 then Some(w) else None
```

Casts are explicit, trackable, and the compiler knows exact types at each point.

---

## 9. Implementation Roadmap

### Phase 1: Linear Memory Infrastructure
- [ ] Add `Allocator` to runtime (bump allocator)
- [ ] Modify `Codegen` to allocate records in linear memory
- [ ] Implement `Standard Object Header` (write tags on allocation)
- [ ] Update field access to use `i32.load` with offsets

### Phase 2: Higher-Order Functions (PR 3)
- [ ] Assign table indices to functions used as values
- [ ] Emit function tables in codegen
- [ ] Implement `call_indirect` for indirect calls
- [ ] Support lambdas as expressions

### Phase 3: Optional Fields Grammar & AST
- [ ] Update grammar to support `?` syntax: `field?: Type`
- [ ] Implement variant expansion in type checker
- [ ] Generate bitmask tags for optional-field records

### Phase 4: Monomorphization & Dispatch
- [ ] Implement `VariantExpander` to generate specialized function variants
- [ ] Implement `DispatchTableEmitter` for per-function tables
- [ ] Implement `DispatchWrapperEmitter` for polymorphic entry points
- [ ] Implement static dispatch bypass (direct calls when type known)

### Phase 5: Multi-Argument Dispatch
- [ ] Extend flattened index calculation for N parameters
- [ ] Generate combined dispatch tables

### Phase 6: Closures (PR 5)
- [ ] Design closure representation (func_index + env_ptr)
- [ ] Implement capture analysis
- [ ] Generate environment structs
- [ ] Modified calling convention for closures

---

## 10. Summary

| Component | Design Choice |
|-----------|---------------|
| Memory layout | Packed (absent fields = 0 bytes) |
| Type tags | Bitmask encoding for optionals |
| Dispatch strategy | Monomorphization + Per-Function Tables |
| Static optimization | Direct calls when concrete type known |
| Function values | i32 table indices |
| Multi-argument dispatch | Flattened index: `tag1 * V2 + tag2` |
| Nested records | Inline embedding |
| WasmGC | Not used (linear memory only) |
