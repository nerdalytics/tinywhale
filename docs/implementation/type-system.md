# TinyWhale Type System & Memory Model Specification

> **Status**: Draft (Proposed for implementation)
> **Date**: 2026-01-24
> **Context**: Moving from "flattened locals" to "linear memory structs" to support optional fields and union types.

---

## 1. Overview

TinyWhale is transitioning its backend memory model to support advanced features like **optional fields**, **union types**, and **recursive structures**.

- **Current Model**: "Flattened Locals" (Records are exploded into individual WASM locals).
- **New Model**: "Linear Memory Objects" (Records are stored as contiguous bytes in WASM linear memory; variables hold `i32` pointers).

This document specifies the **Packed Layout** strategy for memory management and the **Monomorphization** strategy for dynamic dispatch.

---

## 2. Core Concepts

### 2.1 The Standard Object Header
Every complex object in linear memory (Records, Unions) begins with a mandatory 4-byte header.

```
+-------------------+ (Offset 0)
| type_tag (i32)    | -> Identifies the concrete variant at runtime
+-------------------+
```

- **Type Tag**: An `i32` integer uniquely identifying the concrete structural variant within its type family.
- **Access**: `i32.load` at offset `0` is always safe for any non-null object pointer.

### 2.2 Sealed Unions
All types in TinyWhale are "sealed" at compile time.
- **Records with Optionals** are compiled as **Union Types**.
- A record with $N$ optional fields expands to $2^N$ concrete variants.
- The set of all possible variants is known during compilation, enabling monomorphization.

---

## 3. Memory Layout: The "Packed Strategy"

To minimize memory footprint, we use a **Packed Layout** where absent optional fields occupy zero bytes, shifting subsequent fields to lower offsets.

### 3.1 Layout Rules

1.  **Anchor**: Byte 0-3 is always the `type_tag`.
2.  **Fixed Sequence**: All **required** fields appear immediately after the tag, in definition order. Their offsets are constant across all variants.
3.  **Optional Sequence**: **Optional** fields follow the required fields.
    *   If **Present**: Occupies the next available `sizeof(type)` bytes.
    *   If **Absent**: Occupies 0 bytes.
    *   Subsequent fields shift "left" to fill the gap.

### 3.2 Example: Multiple Optionals

Given:
```tinywhale
Widget
    id: i32        # Required
    w?: i32        # Optional A
    h?: i32        # Optional B
    d?: i32        # Optional C
```

**Common Fields**:
- `id`: Always at Offset 4.

**Variant Layouts**:

| Tag | Variant | Layout (Offsets) | Total Size |
| :--- | :--- | :--- | :--- |
| **0** | `(None)` | `0:tag` `4:id` | 8 bytes |
| **1** | `w` | `0:tag` `4:id` `8:w` | 12 bytes |
| **2** | `h` | `0:tag` `4:id` `8:h` | 12 bytes |
| **3** | `w, h` | `0:tag` `4:id` `8:w` `12:h` | 16 bytes |
| **4** | `d` | `0:tag` `4:id` `8:d` | 12 bytes |
| **5** | `w, d` | `0:tag` `4:id` `8:w` `12:d` | 16 bytes |
| **6** | `h, d` | `0:tag` `4:id` `8:h` `12:d` | 16 bytes |
| **7** | `w, h, d` | `0:tag` `4:id` `8:w` `12:h` `16:d` | 20 bytes |

*Note: In this example, `d` can appear at offset 8, 12, or 16 depending on the variant.*

### 3.3 Tag Assignment
Tags are bitmasks of presence for optional-only records, or sequential IDs for explicit unions.
For records with optionals, we recommend a **Bitmask Mapping**:
- Bit $k$ corresponds to the $k$-th optional field in definition order.
- `0` = Field absent.
- `1` = Field present.

---

## 4. Dispatch Strategy: Monomorphization

Because field offsets vary (e.g., field `d` above), we cannot generate generic code to access them. We use **Strategy 1: Monomorphization + Per-Function Tables**.

### 4.1 Compile-Time Specialization
For every function that accepts a Union Type (or a Record with optionals), the compiler generates:

1.  **Specialized Variants**: One function for each concrete input variant.
    *   *Example*: `get_depth$Variant5` knows `d` is at offset 12.
    *   *Example*: `get_depth$Variant0` knows `d` is missing (returns default/error).
2.  **Dispatch Table**: A WASM `table` containing references to all specialized variants, indexed by the `type_tag`.
3.  **Dispatch Wrapper**: A generic entry point that:
    *   Reads the `type_tag` from the input pointer.
    *   Performs `call_indirect` into the table.

### 4.2 Code Generation Example

**Source**:
```tinywhale
get_depth = (w: Widget) -> i32
    match w.d
        val -> val
        _ -> 0
```

**Generated WASM (Simplified)**:
```wasm
;; 1. Table
(table $get_depth_dispatch 8 funcref)
(elem (i32.const 0)
    $get_depth$0 $get_depth$1 $get_depth$2 ... $get_depth$7)

;; 2. Wrapper
(func $get_depth (param $w i32) (result i32)
    (call_indirect (type $sig_i32_to_i32)
        (local.get $w)                   ;; Argument
        (i32.load (local.get $w))))      ;; Index = type_tag

;; 3. Specialized Variant (Tag 5: w, d present)
(func $get_depth$5 (param $w i32) (result i32)
    ;; Compiler statically determined d is at offset 12 for Tag 5
    (i32.load offset=12 (local.get $w)))

;; 4. Specialized Variant (Tag 0: d missing)
(func $get_depth$0 (param $w i32) (result i32)
    (i32.const 0)) ;; Default value
```

---

## 5. Implementation Roadmap

### Phase 1: Infrastructure (Linear Memory)
- [ ] Add `Allocator` to runtime (simple bump allocator first).
- [ ] Modify `Codegen` to allocate records in memory instead of flattening.
- [ ] Implement `Standard Object Header` (writing tags).

### Phase 2: Optional Fields Grammar & AST
- [ ] Update `grammar` to support `?` syntax: `x?: i32`.
- [ ] Update `TypeChecker` to handle "Expanded Variants" of records.

### Phase 3: Monomorphization
- [ ] Implement `VariantExpander` to generate specialized function ASTs.
- [ ] Implement `TableEmitter` in Binaryen codegen.
- [ ] Implement `DispatchWrapper` generation.
