# Dispatch Strategy 2: Global Dispatch Matrix

> **Summary**: Use a single large WASM table as a dispatch matrix. Index into it using a formula that combines function ID and type tags.

---

## Table of Contents

1. [Core Concept](#core-concept)
2. [How It Works](#how-it-works)
3. [Index Calculation](#index-calculation)
4. [WASM Implementation](#wasm-implementation)
5. [Binaryen Code Generation](#binaryen-code-generation)
6. [Multi-Argument Dispatch](#multi-argument-dispatch)
7. [Performance Characteristics](#performance-characteristics)
8. [Trade-offs](#trade-offs)
9. [When to Use](#when-to-use)

---

## Core Concept

Instead of creating separate tables for each generic function, **Global Dispatch Matrix** uses a single table that maps `(function_id, type_tags...)` tuples to function implementations.

Think of it as a flattened multi-dimensional array where:
- One dimension is the function being called
- Other dimensions are the types of the arguments

This approach centralizes all dispatch logic into one table, simplifying bookkeeping at the cost of potential sparseness.

---

## How It Works

### The Dispatch Matrix

Conceptually, the matrix looks like this:

```
                    Type Tag 0    Type Tag 1    Type Tag 2
                  +--------------+--------------+--------------+
Function 0        |  fn0$var0    |  fn0$var1    |  fn0$var2    |
(greet_person)    +--------------+--------------+--------------+
Function 1        |  fn1$var0    |  fn1$var1    |  fn1$var2    |
(farewell_person) +--------------+--------------+--------------+
Function 2        |  fn2$var0    |  fn2$var1    |  fn2$var2    |
(describe_person) +--------------+--------------+--------------+
```

Flattened into a 1D table:

```
Index 0: fn0$var0 (greet_person, type 0)
Index 1: fn0$var1 (greet_person, type 1)
Index 2: fn0$var2 (greet_person, type 2)
Index 3: fn1$var0 (farewell_person, type 0)
Index 4: fn1$var1 (farewell_person, type 1)
Index 5: fn1$var2 (farewell_person, type 2)
...
```

### Compile-Time Setup

Given:

```tinywhale
Person
    id: i32
    sex?: Male | Female

# Person expands to 2 variants (tags 0, 1)

greet_person = (p: Person) -> String     # function_id = 0
farewell_person = (p: Person) -> String  # function_id = 1
describe_person = (p: Person) -> String  # function_id = 2
```

The compiler:

1. **Assigns function IDs** to each generic function
2. **Determines MAX_TYPES** — the maximum number of type variants (2 in this case)
3. **Calculates table size** — `num_functions * MAX_TYPES`
4. **Populates table** with specialized implementations

### Runtime Dispatch

At call site:

```
index = function_id * MAX_TYPES + type_tag
call_indirect($global_dispatch, index, args...)
```

---

## Index Calculation

### Single-Argument Dispatch

Formula: `index = function_id * MAX_TYPES + type_tag`

```
Given:
  function_id = 1 (farewell_person)
  MAX_TYPES = 2
  type_tag = 1 (Person with sex)

Index = 1 * 2 + 1 = 3
Table[3] = farewell_person$1
```

### Multi-Argument Dispatch

Formula: `index = function_id * (T1 * T2 * ...) + (tag1 * T2 * T3 * ...) + (tag2 * T3 * ...) + ... + tagN`

Where `T1, T2, ...` are the number of variants for each argument type.

**Example**: Two arguments, Person (2 variants) and Style (3 variants)

```
MAX_COMBOS = 2 * 3 = 6 per function

index = function_id * 6 + person_tag * 3 + style_tag
```

```
function_id=0, person_tag=0, style_tag=0 → index 0
function_id=0, person_tag=0, style_tag=1 → index 1
function_id=0, person_tag=0, style_tag=2 → index 2
function_id=0, person_tag=1, style_tag=0 → index 3
function_id=0, person_tag=1, style_tag=1 → index 4
function_id=0, person_tag=1, style_tag=2 → index 5
function_id=1, person_tag=0, style_tag=0 → index 6
...
```

---

## WASM Implementation

### Module Structure

```wasm
(module
  ;; Global constants (could be in data segment or hardcoded)
  (global $MAX_TYPES i32 (i32.const 2))
  (global $MAX_COMBOS i32 (i32.const 6))  ;; For 2-arg dispatch

  ;; Type signatures
  (type $single_arg (func (param i32) (result i32)))
  (type $double_arg (func (param i32 i32) (result i32)))

  ;; Single global dispatch table
  ;; Size = num_functions * MAX_TYPES (or MAX_COMBOS for multi-arg)
  (table $global_dispatch 12 12 funcref)

  ;; Populate table (order matters!)
  (elem (table $global_dispatch) (i32.const 0)
    ;; Function 0 (greet_person) variants
    $greet_person$0
    $greet_person$1
    ;; Function 1 (farewell_person) variants
    $farewell_person$0
    $farewell_person$1
    ;; Function 2 (describe_person) variants
    $describe_person$0
    $describe_person$1
    ;; ... more functions ...
  )

  ;; Specialized implementations
  (func $greet_person$0 (param $p i32) (result i32)
    (i32.const 100))  ;; "Hi"

  (func $greet_person$1 (param $p i32) (result i32)
    (i32.const 200))  ;; "Hello Mr/Mrs"

  (func $farewell_person$0 (param $p i32) (result i32)
    (i32.const 300))  ;; "Bye"

  (func $farewell_person$1 (param $p i32) (result i32)
    (i32.const 400))  ;; "Goodbye Mr/Mrs"

  ;; ... more implementations ...

  ;; Generic dispatch functions
  ;; Function ID is hardcoded at each call site

  ;; greet_person (function_id = 0)
  (func $greet_person (param $p i32) (result i32)
    (call_indirect $global_dispatch (type $single_arg)
      (local.get $p)
      (i32.add
        (i32.mul (i32.const 0) (global.get $MAX_TYPES))  ;; function_id * MAX_TYPES
        (i32.load (local.get $p)))))                     ;; + type_tag

  ;; farewell_person (function_id = 1)
  (func $farewell_person (param $p i32) (result i32)
    (call_indirect $global_dispatch (type $single_arg)
      (local.get $p)
      (i32.add
        (i32.mul (i32.const 1) (global.get $MAX_TYPES))  ;; function_id * MAX_TYPES
        (i32.load (local.get $p)))))                     ;; + type_tag
)
```

### Multi-Argument Example

```wasm
;; greet with Person and GreetingStyle
;; function_id = 0, Person has 2 variants, Style has 3 variants
(func $greet (param $p i32) (param $style i32) (result i32)
  (call_indirect $global_dispatch (type $double_arg)
    (local.get $p)
    (local.get $style)
    ;; index = function_id * 6 + person_tag * 3 + style_tag
    (i32.add
      (i32.mul (i32.const 0) (i32.const 6))  ;; function_id * MAX_COMBOS
      (i32.add
        (i32.mul
          (i32.load (local.get $p))           ;; person_tag
          (i32.const 3))                      ;; * num_style_variants
        (i32.load (local.get $style))))))     ;; + style_tag
```

---

## Binaryen Code Generation

### TypeScript Implementation

```typescript
import binaryen from 'binaryen'

interface DispatchMatrix {
  tableName: string
  maxTypesPerArg: number[]      // [2, 3] for Person×Style
  functionIds: Map<string, number>
  entries: string[]             // Flattened function names
}

function calculateMaxCombos(maxTypesPerArg: number[]): number {
  return maxTypesPerArg.reduce((acc, n) => acc * n, 1)
}

function calculateIndex(
  functionId: number,
  typeTags: number[],
  maxTypesPerArg: number[]
): number {
  const maxCombos = calculateMaxCombos(maxTypesPerArg)
  let index = functionId * maxCombos

  // Add contributions from each type tag
  for (let i = 0; i < typeTags.length; i++) {
    const stride = maxTypesPerArg.slice(i + 1).reduce((acc, n) => acc * n, 1)
    index += typeTags[i] * stride
  }

  return index
}

function emitGlobalDispatchTable(
  module: binaryen.Module,
  matrix: DispatchMatrix
): void {
  const tableSize = matrix.entries.length

  // Create single global table
  module.addTable(
    matrix.tableName,
    tableSize,
    tableSize,
    binaryen.funcref
  )

  // Populate with all function variants
  module.addActiveElementSegment(
    matrix.tableName,
    `${matrix.tableName}$elem`,
    matrix.entries,
    module.i32.const(0)
  )
}

function emitDispatchCall(
  module: binaryen.Module,
  matrix: DispatchMatrix,
  functionName: string,
  args: binaryen.ExpressionRef[],
  argPtrs: binaryen.ExpressionRef[],  // Pointers to load type tags from
  signature: binaryen.Type,
  returnType: binaryen.Type
): binaryen.ExpressionRef {
  const functionId = matrix.functionIds.get(functionName)!
  const maxCombos = calculateMaxCombos(matrix.maxTypesPerArg)

  // Build index calculation expression
  let indexExpr = module.i32.mul(
    module.i32.const(functionId),
    module.i32.const(maxCombos)
  )

  // Add type tag contributions
  for (let i = 0; i < argPtrs.length; i++) {
    const stride = matrix.maxTypesPerArg.slice(i + 1).reduce((acc, n) => acc * n, 1)
    const tagLoad = module.i32.load(0, 0, argPtrs[i])

    if (stride > 1) {
      indexExpr = module.i32.add(
        indexExpr,
        module.i32.mul(tagLoad, module.i32.const(stride))
      )
    } else {
      indexExpr = module.i32.add(indexExpr, tagLoad)
    }
  }

  return module.call_indirect(
    matrix.tableName,
    indexExpr,
    args,
    signature,
    returnType
  )
}
```

### Usage Example

```typescript
// Setup
const matrix: DispatchMatrix = {
  tableName: '$global_dispatch',
  maxTypesPerArg: [2],  // Person has 2 variants
  functionIds: new Map([
    ['greet_person', 0],
    ['farewell_person', 1],
    ['describe_person', 2],
  ]),
  entries: [
    // greet_person variants
    '$greet_person$0', '$greet_person$1',
    // farewell_person variants
    '$farewell_person$0', '$farewell_person$1',
    // describe_person variants
    '$describe_person$0', '$describe_person$1',
  ]
}

// Emit table
emitGlobalDispatchTable(module, matrix)

// Emit dispatch call
const callExpr = emitDispatchCall(
  module,
  matrix,
  'greet_person',
  [module.local.get(0, binaryen.i32)],  // args
  [module.local.get(0, binaryen.i32)],  // arg ptrs (same for single arg)
  binaryen.createType([binaryen.i32]),
  binaryen.i32
)
```

---

## Multi-Argument Dispatch

### Scaling Behavior

| Args | Variants Each | Combos per Function | Table Growth |
|------|---------------|---------------------|--------------|
| 1    | 2             | 2                   | Linear       |
| 2    | 2, 3          | 6                   | Multiplicative |
| 3    | 2, 3, 4       | 24                  | Multiplicative |
| 4    | 2, 2, 2, 2    | 16                  | Exponential  |

### Sparse Tables

Not all functions use all type combinations. A function might only accept `Person` but not `Style`:

```
greet_person: uses Person (2 variants) → needs 2 slots
greet: uses Person × Style (6 combos) → needs 6 slots
```

With a global matrix, you must either:

1. **Uniform sizing**: All functions use MAX_COMBOS slots (wastes space)
2. **Variable sizing**: Track offsets per function (more complex)

### Recommended Approach: Sectioned Matrix

Divide the table into sections by arity:

```
Section 0 (1-arg functions):  [0, N1)
Section 1 (2-arg functions):  [N1, N1+N2)
Section 2 (3-arg functions):  [N1+N2, N1+N2+N3)
```

Each section has its own `MAX_COMBOS` calculation.

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Type tag lookup | O(1) | Memory load |
| Index calculation | O(k) | k = number of arguments |
| Table lookup | O(1) | Single `call_indirect` |
| Total dispatch | O(k) | Dominated by index math |

For typical k ≤ 3, this is effectively O(1).

### Space Complexity

| Component | Size |
|-----------|------|
| Single global table | `num_functions * MAX_COMBOS * sizeof(funcref)` |
| Type tags | 4 bytes per value |
| Index calculation code | Inline at each call site |

### Sparsity Impact

If only 50% of function×type combinations are valid:
- **Wasted space**: 50% of table entries are unused
- **No runtime cost**: Invalid entries never accessed (compiler ensures this)

---

## Trade-offs

### Advantages

| Advantage | Explanation |
|-----------|-------------|
| **Single table** | Simpler module structure, one place for all dispatch |
| **Predictable layout** | Index formula is deterministic |
| **Easy debugging** | One table to inspect |
| **O(1) dispatch** | Same as Strategy 1 |
| **No per-function overhead** | No need to track multiple tables |

### Disadvantages

| Disadvantage | Explanation |
|--------------|-------------|
| **Sparse tables** | Unused entries waste memory |
| **MAX_TYPES constraint** | Must know maximum variants at compile time |
| **Index calculation overhead** | More arithmetic than Strategy 1 |
| **Less modular** | All functions in one table |
| **Harder to extend** | Adding a function requires recalculating all indices |

### Comparison with Strategy 1

| Aspect | Strategy 1 (Per-Function) | Strategy 2 (Global Matrix) |
|--------|---------------------------|---------------------------|
| Tables | Many (one per function) | One |
| Memory efficiency | High (no waste) | Variable (may be sparse) |
| Modularity | High | Low |
| Index calculation | Simple (just type tag) | Complex (function_id + tags) |
| Extensibility | Easy (add new table) | Harder (rebuild table) |

---

## When to Use

### Ideal For

- **Small, fixed set of functions** requiring dispatch
- **Uniform type usage** across functions (no sparsity)
- **Simple codegen** requirements (one table to manage)
- **Debugging/profiling** scenarios (centralized dispatch)

### Less Suitable For

- **Large codebases** with many generic functions
- **Sparse usage patterns** (some functions use few types)
- **Incremental compilation** (adding functions changes indices)
- **Memory-constrained** environments

---

## Relationship to TinyWhale Requirements

| Requirement | How Strategy 2 Addresses It |
|-------------|----------------------------|
| O(1) lookup | ✅ Single table access after index math |
| Multi-argument dispatch | ⚠️ Works but table grows multiplicatively |
| Sealed unions | ✅ MAX_TYPES known at compile time |
| No reflection | ✅ Type tags internal |
| Progressive enhancement | ⚠️ Adding types may require table restructure |

### Verdict for TinyWhale

Strategy 2 is **viable but not optimal** for TinyWhale because:

1. **Table sparsity**: Not all functions use all types
2. **Index complexity**: More arithmetic than necessary
3. **Extensibility concerns**: Adding functions is more disruptive

Consider Strategy 2 if you want **simpler module structure** and can tolerate some wasted space.

---

## Hybrid Approach

A middle ground: **Per-Arity Global Tables**

- One table for all 1-arg dispatch functions
- One table for all 2-arg dispatch functions
- etc.

This reduces sparsity while maintaining some centralization:

```wasm
(table $dispatch_1arg 20 funcref)   ;; All 1-arg generic functions
(table $dispatch_2arg 50 funcref)   ;; All 2-arg generic functions
```

Index calculation becomes:
```
;; 1-arg: function_id * MAX_TYPES_1 + type_tag
;; 2-arg: function_id * MAX_COMBOS_2 + tag1 * T2 + tag2
```
