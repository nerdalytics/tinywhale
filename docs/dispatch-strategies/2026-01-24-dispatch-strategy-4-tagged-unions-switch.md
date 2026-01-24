# Dispatch Strategy 4: Tagged Unions with Switch (Explicit Dispatch)

> **Summary**: Generate explicit comparison chains (`if-else` or `br_table`) instead of using `call_indirect`. Each call site contains inline dispatch logic.
>
> **Status**: Generally not recommended. Documented for completeness and to explain why table-based dispatch is preferred.

---

## Table of Contents

1. [Core Concept](#core-concept)
2. [How It Works](#how-it-works)
3. [WASM Implementation](#wasm-implementation)
4. [Binaryen Code Generation](#binaryen-code-generation)
5. [Multi-Argument Dispatch](#multi-argument-dispatch)
6. [Performance Characteristics](#performance-characteristics)
7. [Trade-offs](#trade-offs)
8. [When This Might Be Acceptable](#when-this-might-be-acceptable)
9. [Why This Is Problematic](#why-this-is-problematic)

---

## Core Concept

Instead of using WASM's `call_indirect` with function tables, **explicitly generate dispatch code** at each call site:

```wasm
;; Instead of call_indirect
(if (i32.eq (local.get $type_tag) (i32.const 0))
  (then (call $impl_variant_0 ...))
  (else
    (if (i32.eq (local.get $type_tag) (i32.const 1))
      (then (call $impl_variant_1 ...))
      (else (unreachable)))))
```

This is essentially **re-implementing virtual dispatch in userland** rather than using WASM's built-in mechanism.

---

## How It Works

### Compile-Time

Given:

```tinywhale
Person
    id: i32
    sex?: Male | Female  # 2 variants: tags 0 and 1

greet_person = (p: Person) -> String
    match p.sex as s
        ...
```

The compiler generates:

```tinywhale
# Specialized implementations
greet_person$0 = (p: Person$without_sex) -> String
    "Hi"

greet_person$1 = (p: Person$with_sex) -> String
    match p.sex
        Male -> "Hello Mr"
        Female -> "Hello Mrs"
```

At each call site, instead of `call_indirect`:

```tinywhale
# Inline dispatch logic
greet_person = (p: Person) -> String
    tag = p.__type_tag
    if tag == 0
        greet_person$0(p)
    else if tag == 1
        greet_person$1(p)
    else
        unreachable
```

### Runtime

Each call to `greet_person(some_person)`:

1. Load type tag from `some_person`
2. Compare against 0 → if match, call variant 0
3. Compare against 1 → if match, call variant 1
4. If no match, trap (should never happen with sealed unions)

---

## WASM Implementation

### Using If-Else Chain

```wasm
(module
  ;; Specialized implementations
  (func $greet_person$0 (param $p i32) (result i32)
    (i32.const 100))  ;; "Hi"

  (func $greet_person$1 (param $p i32) (result i32)
    (i32.const 200))  ;; "Hello Mr/Mrs"

  ;; Dispatch function with explicit comparisons
  (func $greet_person (param $p i32) (result i32)
    (local $tag i32)

    ;; Load type tag
    (local.set $tag (i32.load (local.get $p)))

    ;; Compare chain
    (if (result i32) (i32.eq (local.get $tag) (i32.const 0))
      (then
        (call $greet_person$0 (local.get $p)))
      (else
        (if (result i32) (i32.eq (local.get $tag) (i32.const 1))
          (then
            (call $greet_person$1 (local.get $p)))
          (else
            (unreachable))))))
)
```

### Using br_table (More Efficient)

WASM's `br_table` instruction provides a jump table, which is more efficient for many cases:

```wasm
(func $greet_person (param $p i32) (result i32)
  (local $tag i32)
  (local $result i32)

  (local.set $tag (i32.load (local.get $p)))

  (block $done (result i32)
    (block $case1
      (block $case0
        (block $default
          ;; br_table: jump based on $tag value
          ;; $tag=0 → $case0, $tag=1 → $case1, else → $default
          (br_table $case0 $case1 $default (local.get $tag)))
        ;; $default: unreachable (invalid tag)
        (unreachable))
      ;; $case0: tag == 0
      (local.set $result (call $greet_person$0 (local.get $p)))
      (br $done))
    ;; $case1: tag == 1
    (local.set $result (call $greet_person$1 (local.get $p)))
    (br $done))
  (local.get $result))
```

### Comparison: call_indirect vs br_table

```wasm
;; call_indirect approach (Strategy 1-3)
(call_indirect $table (type $sig)
  (local.get $p)
  (i32.load (local.get $p)))

;; br_table approach (Strategy 4)
(block $done
  (block $case1
    (block $case0
      (br_table $case0 $case1 $default (local.get $tag)))
    (call $greet_person$0 (local.get $p))
    (br $done))
  (call $greet_person$1 (local.get $p)))
```

`call_indirect`: 1 instruction + type check
`br_table`: 4+ blocks + branches + calls

---

## Binaryen Code Generation

### TypeScript Implementation

```typescript
import binaryen from 'binaryen'

interface SwitchDispatch {
  functionName: string
  variants: {
    tag: number
    implementation: string
  }[]
  paramType: binaryen.Type
  returnType: binaryen.Type
}

function emitIfElseDispatch(
  module: binaryen.Module,
  dispatch: SwitchDispatch
): void {
  const { functionName, variants, paramType, returnType } = dispatch

  // Build nested if-else from bottom up
  let body: binaryen.ExpressionRef = module.unreachable()

  // Reverse order to build from innermost else outward
  for (let i = variants.length - 1; i >= 0; i--) {
    const variant = variants[i]
    const tagCheck = module.i32.eq(
      module.i32.load(0, 0, module.local.get(0, binaryen.i32)),
      module.i32.const(variant.tag)
    )
    const thenBranch = module.call(
      variant.implementation,
      [module.local.get(0, binaryen.i32)],
      returnType
    )
    body = module.if(tagCheck, thenBranch, body)
  }

  module.addFunction(
    functionName,
    binaryen.createType([binaryen.i32]),
    returnType,
    [],
    body
  )
}

function emitBrTableDispatch(
  module: binaryen.Module,
  dispatch: SwitchDispatch
): void {
  const { functionName, variants, returnType } = dispatch

  // Create block labels
  const doneLabel = 'done'
  const defaultLabel = 'default'
  const caseLabels = variants.map((_, i) => `case${i}`)

  // Build br_table targets (sorted by tag)
  const sortedVariants = [...variants].sort((a, b) => a.tag - b.tag)
  const brTableTargets = sortedVariants.map((_, i) => caseLabels[i])

  // Local for result
  const resultLocal = 0

  // Build the nested block structure
  // This is complex in Binaryen's API, simplified here
  const blocks: binaryen.ExpressionRef[] = []

  // Innermost: br_table
  const brTable = module.switch(
    brTableTargets,
    defaultLabel,
    module.i32.load(0, 0, module.local.get(0, binaryen.i32))
  )

  // Wrap in blocks and add calls
  // ... (complex nesting logic)

  module.addFunction(
    functionName,
    binaryen.createType([binaryen.i32]),
    returnType,
    [binaryen.i32],  // result local
    module.block(doneLabel, blocks, returnType)
  )
}
```

### Generated Code Size

For N variants:

**If-Else Chain**:
- N comparisons
- N conditional branches
- N function calls
- Code size: O(N)

**br_table**:
- 1 br_table instruction
- N+1 blocks (including default)
- N function calls
- Code size: O(N) but with lower constant factor

---

## Multi-Argument Dispatch

For multiple union-typed arguments, explicit dispatch becomes nested:

```tinywhale
greet = (p: Person, style: GreetingStyle) -> String
# Person: 2 variants, Style: 2 variants
```

**Generated dispatch**:

```wasm
(func $greet (param $p i32) (param $style i32) (result i32)
  (local $p_tag i32)
  (local $s_tag i32)

  (local.set $p_tag (i32.load (local.get $p)))
  (local.set $s_tag (i32.load (local.get $style)))

  ;; Outer dispatch on Person
  (if (result i32) (i32.eq (local.get $p_tag) (i32.const 0))
    (then
      ;; Inner dispatch on Style for Person variant 0
      (if (result i32) (i32.eq (local.get $s_tag) (i32.const 0))
        (then (call $greet$0$0 (local.get $p) (local.get $style)))
        (else
          (if (result i32) (i32.eq (local.get $s_tag) (i32.const 1))
            (then (call $greet$0$1 (local.get $p) (local.get $style)))
            (else (unreachable))))))
    (else
      ;; Inner dispatch on Style for Person variant 1
      (if (result i32) (i32.eq (local.get $p_tag) (i32.const 1))
        (then
          (if (result i32) (i32.eq (local.get $s_tag) (i32.const 0))
            (then (call $greet$1$0 (local.get $p) (local.get $style)))
            (else
              (if (result i32) (i32.eq (local.get $s_tag) (i32.const 1))
                (then (call $greet$1$1 (local.get $p) (local.get $style)))
                (else (unreachable))))))
        (else (unreachable))))))
```

**Code explosion**: For k arguments with N variants each: O(N^k) comparisons.

---

## Performance Characteristics

### Time Complexity

| Operation | If-Else Chain | br_table | call_indirect |
|-----------|---------------|----------|---------------|
| Best case | O(1) - first match | O(1) | O(1) |
| Worst case | O(N) - last match | O(1) | O(1) |
| Average | O(N/2) | O(1) | O(1) |

### Instruction Count

| Variants | If-Else | br_table | call_indirect |
|----------|---------|----------|---------------|
| 2        | 4 inst  | 6 inst   | 2 inst        |
| 4        | 10 inst | 10 inst  | 2 inst        |
| 8        | 22 inst | 18 inst  | 2 inst        |
| 16       | 46 inst | 34 inst  | 2 inst        |

### Branch Prediction Impact

- **If-else chains**: Branch predictor can optimize common paths
- **br_table**: Indirect jump, harder to predict
- **call_indirect**: Single indirect call, well-optimized in WASM runtimes

Modern WASM engines optimize `call_indirect` heavily. Explicit dispatch loses this optimization.

---

## Trade-offs

### Advantages

| Advantage | Explanation |
|-----------|-------------|
| **No tables needed** | Simpler module structure |
| **Inline optimization** | Compiler can optimize known paths |
| **Branch prediction** | If-else can benefit from prediction |
| **No type signature matching** | Avoids `call_indirect` type check |
| **Debugging clarity** | Dispatch logic is explicit in code |

### Disadvantages

| Disadvantage | Explanation |
|--------------|-------------|
| **Code bloat** | Dispatch logic at every call site |
| **O(N) worst case** | If-else chains are slow for many variants |
| **Maintenance burden** | Adding variants requires changing all sites |
| **Reimplements WASM feature** | `call_indirect` exists for this purpose |
| **Reflection risk** | Encodes type knowledge in generated code |

---

## When This Might Be Acceptable

### Small, Fixed Variant Count

If you have exactly 2-3 variants that will never change:

```tinywhale
Result = Ok | Err  # Always exactly 2 variants
```

The dispatch is trivial and tables add unnecessary overhead:

```wasm
;; 2 variants: simple if-else is fine
(if (i32.eqz (local.get $tag))
  (then (call $handle_ok ...))
  (else (call $handle_err ...)))
```

### Performance-Critical Hot Paths

If profiling shows dispatch is a bottleneck AND:
- Variant count is small (≤4)
- One variant dominates (>90% of calls)
- Branch prediction can optimize the common path

```wasm
;; Hot path optimization: check common case first
(if (i32.eqz (local.get $tag))  ;; 95% of calls
  (then (call $common_case ...))
  (else (call $greet_person ...)))  ;; Rare: use table dispatch
```

### Interpreter Targets

If targeting a WASM interpreter (not JIT), `call_indirect` may have high overhead. Explicit dispatch can be faster in this scenario.

### Educational/Debugging

When you want to see exactly how dispatch works:

```wasm
;; Clear, explicit dispatch for debugging
(if (i32.eq (local.get $tag) (i32.const 0))
  (then
    ;; Person without sex
    (call $log (i32.const 1000))  ;; Debug: "dispatching to variant 0"
    (call $greet_person$0 ...))
  (else ...))
```

---

## Why This Is Problematic

### 1. Code Explosion

For a function with 4 variants called from 10 places:

- **Table-based**: 1 dispatcher function + 10 simple calls = ~50 instructions
- **Explicit dispatch**: 10 × 10-instruction dispatch chains = ~100 instructions

### 2. Maintenance Nightmare

Adding a new variant requires:
- Updating every call site
- Risk of missing a site → runtime trap
- No compiler help (type tag is just an integer)

### 3. Reimplements What WASM Provides

`call_indirect` was designed for exactly this use case. WASM engines:
- Optimize indirect call dispatch
- Perform type checking efficiently
- Handle table lookups in ~2 cycles

Explicit dispatch throws away these optimizations.

### 4. Opens Door to Reflection

Explicit dispatch generates code that "knows about" all type variants:

```wasm
;; This code encodes knowledge of all variants
(if (i32.eq (local.get $tag) (i32.const 0)) ...)
(if (i32.eq (local.get $tag) (i32.const 1)) ...)
(if (i32.eq (local.get $tag) (i32.const 2)) ...)
```

This is one step from:
```
;; Reflection: "what variants exist?"
;; The dispatch code already lists them!
```

Table-based dispatch keeps variant knowledge in tables, not code.

### 5. Scalability

| Variants | If-Else | Tables |
|----------|---------|--------|
| 2        | OK      | OK     |
| 4        | Marginal | OK    |
| 8        | Poor    | OK     |
| 16+      | Terrible | OK    |

---

## Relationship to TinyWhale Requirements

| Requirement | How Strategy 4 Addresses It |
|-------------|----------------------------|
| O(1) lookup | ❌ O(N) worst case with if-else |
| Multi-argument dispatch | ❌ Exponential code explosion |
| Sealed unions | ✅ Works, but no advantage |
| No reflection | ⚠️ Risk: type knowledge in code |
| Progressive enhancement | ❌ Adding types changes all call sites |

### Verdict for TinyWhale

**Do not use Strategy 4** as the primary dispatch mechanism.

Consider it only for:
- Micro-optimizations on hot paths with 2 variants
- Debugging/tracing dispatch behavior
- Fallback when tables are somehow unavailable

---

## Comparison Summary

| Aspect | Strategy 1 | Strategy 2 | Strategy 3 | Strategy 4 |
|--------|------------|------------|------------|------------|
| Dispatch | O(1) | O(1) | O(k) | O(N) worst |
| Tables | Per-function | Global | Hierarchical | None |
| Code size | Small | Small | Medium | Large |
| Modularity | High | Low | High | Low |
| Reflection risk | Low | Low | Low | Medium |
| WASM idiomatic | Yes | Yes | Yes | No |
| Recommended | ✅ | ⚠️ | ⚠️ | ❌ |

---

## If You Must Use This

### Use br_table, Not If-Else

`br_table` is O(1) lookup, similar to a jump table:

```wasm
(br_table $case0 $case1 $case2 $default (local.get $tag))
```

### Limit to 2-4 Variants

Beyond 4 variants, the code overhead isn't justified.

### Combine with Tables

Use explicit dispatch for the most common case, fall back to tables:

```wasm
(if (i32.eqz (local.get $tag))
  (then (call $hot_path_variant ...))        ;; 90% of calls
  (else (call $greet_person_dispatch ...)))  ;; Table-based for rest
```

### Document Why

If you use explicit dispatch, comment why:

```wasm
;; PERF: Explicit dispatch for 2-variant hot path
;; Measured 15% faster than call_indirect in this case
;; TODO: Re-evaluate if variant count changes
```
