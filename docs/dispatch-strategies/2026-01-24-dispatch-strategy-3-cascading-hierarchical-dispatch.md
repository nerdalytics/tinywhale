# Dispatch Strategy 3: Cascading Dispatch (Hierarchical Tables)

> **Summary**: Use a hierarchy of WASM tables where each level dispatches on one argument's type, passing control to the next level until reaching the final implementation.

---

## Table of Contents

1. [Core Concept](#core-concept)
2. [How It Works](#how-it-works)
3. [Visual Model](#visual-model)
4. [WASM Implementation](#wasm-implementation)
5. [Binaryen Code Generation](#binaryen-code-generation)
6. [Multi-Argument Dispatch](#multi-argument-dispatch)
7. [Performance Characteristics](#performance-characteristics)
8. [Trade-offs](#trade-offs)
9. [When to Use](#when-to-use)

---

## Core Concept

**Cascading Dispatch** treats multi-argument dispatch as a series of single-argument dispatches:

1. First table: indexed by first argument's type → returns **another table index** (or dispatcher function)
2. Second table: indexed by second argument's type → returns **another table index** (or implementation)
3. Continue until all dispatched arguments are resolved
4. Final entry is the actual implementation

This mirrors how Julia conceptually handles multiple dispatch, though Julia uses sophisticated caching rather than explicit table hierarchies.

### Key Insight

Instead of flattening `N×M×P` combinations into one table, we create:
- N entries at level 1 (for first arg)
- M entries at level 2 (for second arg, per level-1 choice)
- P entries at level 3 (for third arg, per level-2 choice)

Total entries: `N + N*M + N*M*P` (hierarchical) vs `N*M*P` (flattened)

For sparse dispatch (not all combinations valid), hierarchical can be more efficient.

---

## How It Works

### Example: Two-Argument Dispatch

```tinywhale
Person
    id: i32
    sex?: Male | Female  # 2 variants

GreetingStyle
    formality?: Formal | Casual  # 2 variants

greet = (p: Person, style: GreetingStyle) -> String
    # Implementation depends on both Person variant and Style variant
```

### Dispatch Tree

```
greet(p, style)
    │
    ├─► [Person type tag = 0] ─► greet$person0
    │                              │
    │                              ├─► [Style tag = 0] → greet$0$0 (implementation)
    │                              └─► [Style tag = 1] → greet$0$1 (implementation)
    │
    └─► [Person type tag = 1] ─► greet$person1
                                   │
                                   ├─► [Style tag = 0] → greet$1$0 (implementation)
                                   └─► [Style tag = 1] → greet$1$1 (implementation)
```

### Execution Flow

```
1. Load p.type_tag → 1
2. Look up greet_level1[1] → greet$person1 (dispatcher)
3. Call greet$person1(p, style)
   a. Load style.type_tag → 0
   b. Look up greet$person1_level2[0] → greet$1$0 (implementation)
   c. Call greet$1$0(p, style)
   d. Return result
4. Return result
```

---

## Visual Model

### Flattened (Strategy 2) vs Cascading (Strategy 3)

**Flattened Table (4 entries)**:
```
┌─────────────────────────────────────────────────┐
│ greet$0$0 │ greet$0$1 │ greet$1$0 │ greet$1$1 │
└─────────────────────────────────────────────────┘
   index 0     index 1     index 2     index 3
```

**Cascading Tables (2 + 4 = 6 entries total)**:
```
Level 1 (Person dispatch):
┌────────────────────────────────────┐
│ greet$person0_dispatch │ greet$person1_dispatch │
└────────────────────────────────────┘
        index 0                  index 1

Level 2a (Style dispatch for Person variant 0):
┌───────────────────────────────┐
│ greet$0$0 │ greet$0$1 │
└───────────────────────────────┘
  index 0     index 1

Level 2b (Style dispatch for Person variant 1):
┌───────────────────────────────┐
│ greet$1$0 │ greet$1$1 │
└───────────────────────────────┘
  index 0     index 1
```

### When Cascading Wins

**Sparse dispatch** (not all combinations valid):

```tinywhale
# Some functions only valid for certain combinations
process = (a: A, b: B, c: C) -> Result
    # Only 10 valid combinations out of 4×3×2 = 24 possible
```

Flattened: 24 entries (14 wasted)
Cascading: Only create tables for valid paths

---

## WASM Implementation

### Two-Level Dispatch

```wasm
(module
  ;; Type signatures
  (type $impl_sig (func (param i32 i32) (result i32)))      ;; Final implementation
  (type $dispatch_sig (func (param i32 i32) (result i32)))  ;; Intermediate dispatcher

  ;; Level 1 table: indexed by Person type tag
  (table $greet_L1 2 2 funcref)
  (elem (table $greet_L1) (i32.const 0)
    $greet$person0_dispatch
    $greet$person1_dispatch)

  ;; Level 2 tables: indexed by Style type tag
  (table $greet$person0_L2 2 2 funcref)
  (elem (table $greet$person0_L2) (i32.const 0)
    $greet$0$0
    $greet$0$1)

  (table $greet$person1_L2 2 2 funcref)
  (elem (table $greet$person1_L2) (i32.const 0)
    $greet$1$0
    $greet$1$1)

  ;; Final implementations
  (func $greet$0$0 (param $p i32) (param $style i32) (result i32)
    (i32.const 100))  ;; "Hi casual"

  (func $greet$0$1 (param $p i32) (param $style i32) (result i32)
    (i32.const 101))  ;; "Hi formal"

  (func $greet$1$0 (param $p i32) (param $style i32) (result i32)
    (i32.const 200))  ;; "Hello casual"

  (func $greet$1$1 (param $p i32) (param $style i32) (result i32)
    (i32.const 201))  ;; "Good day formal"

  ;; Level 2 dispatchers (one per Person variant)
  (func $greet$person0_dispatch (param $p i32) (param $style i32) (result i32)
    (call_indirect $greet$person0_L2 (type $impl_sig)
      (local.get $p)
      (local.get $style)
      (i32.load (local.get $style))))  ;; Style type tag

  (func $greet$person1_dispatch (param $p i32) (param $style i32) (result i32)
    (call_indirect $greet$person1_L2 (type $impl_sig)
      (local.get $p)
      (local.get $style)
      (i32.load (local.get $style))))  ;; Style type tag

  ;; Entry point: Level 1 dispatch
  (func $greet (export "greet") (param $p i32) (param $style i32) (result i32)
    (call_indirect $greet_L1 (type $dispatch_sig)
      (local.get $p)
      (local.get $style)
      (i32.load (local.get $p))))  ;; Person type tag
)
```

### Execution Trace

For `greet(person_with_sex, formal_style)`:

```
1. $greet called with p=100, style=200
2. Load p.type_tag: mem[100] = 1 (Person with sex)
3. call_indirect $greet_L1[1] → $greet$person1_dispatch
4. $greet$person1_dispatch called with p=100, style=200
5. Load style.type_tag: mem[200] = 1 (Formal)
6. call_indirect $greet$person1_L2[1] → $greet$1$1
7. $greet$1$1 returns 201 ("Good day formal")
8. Result propagates back
```

---

## Binaryen Code Generation

### TypeScript Implementation

```typescript
import binaryen from 'binaryen'

interface DispatchLevel {
  tableName: string
  entries: (string | DispatchLevel)[]  // Function name or nested level
}

interface CascadingDispatch {
  functionName: string
  argTypes: string[][]  // Variants per argument: [["P0", "P1"], ["S0", "S1"]]
  root: DispatchLevel
  implementations: Map<string, string>  // variant_key → function_name
}

function buildDispatchTree(
  functionName: string,
  argVariants: string[][],
  implementations: Map<string, string>,
  level: number = 0,
  prefix: string = ''
): DispatchLevel {
  const tableName = `$${functionName}_L${level}${prefix ? '_' + prefix : ''}`

  if (level === argVariants.length - 1) {
    // Last level: entries are implementations
    const entries = argVariants[level].map((variant, idx) => {
      const key = prefix ? `${prefix}$${idx}` : `${idx}`
      return implementations.get(key) || `$${functionName}$${key}`
    })
    return { tableName, entries }
  }

  // Intermediate level: entries are dispatchers to next level
  const entries = argVariants[level].map((variant, idx) => {
    const newPrefix = prefix ? `${prefix}$${idx}` : `${idx}`
    return buildDispatchTree(
      functionName,
      argVariants,
      implementations,
      level + 1,
      newPrefix
    )
  })

  return { tableName, entries }
}

function emitDispatchLevel(
  module: binaryen.Module,
  level: DispatchLevel,
  depth: number,
  totalArgs: number,
  paramTypes: binaryen.Type,
  returnType: binaryen.Type
): void {
  const isLeaf = typeof level.entries[0] === 'string'

  // Create table
  const entryNames = level.entries.map(e =>
    typeof e === 'string' ? e : `${e.tableName}_dispatch`
  )

  module.addTable(
    level.tableName,
    entryNames.length,
    entryNames.length,
    binaryen.funcref
  )

  module.addActiveElementSegment(
    level.tableName,
    `${level.tableName}$elem`,
    entryNames,
    module.i32.const(0)
  )

  if (!isLeaf) {
    // Emit nested levels and dispatcher functions
    for (const entry of level.entries) {
      if (typeof entry !== 'string') {
        emitDispatchLevel(module, entry, depth + 1, totalArgs, paramTypes, returnType)

        // Emit dispatcher function for this branch
        const dispatcherName = `${entry.tableName}_dispatch`
        const argGets = Array.from({ length: totalArgs }, (_, i) =>
          module.local.get(i, binaryen.i32)
        )

        // Load type tag from argument at this depth
        const typeTagLoad = module.i32.load(
          0, 0,
          module.local.get(depth, binaryen.i32)
        )

        module.addFunction(
          dispatcherName,
          paramTypes,
          returnType,
          [],
          module.call_indirect(
            entry.tableName,
            typeTagLoad,
            argGets,
            paramTypes,
            returnType
          )
        )
      }
    }
  }
}

function emitCascadingDispatch(
  module: binaryen.Module,
  dispatch: CascadingDispatch
): void {
  const totalArgs = dispatch.argTypes.length
  const paramTypes = binaryen.createType(
    Array(totalArgs).fill(binaryen.i32)
  )
  const returnType = binaryen.i32

  // Build and emit tree
  const tree = buildDispatchTree(
    dispatch.functionName,
    dispatch.argTypes,
    dispatch.implementations
  )

  emitDispatchLevel(module, tree, 0, totalArgs, paramTypes, returnType)

  // Emit root entry point
  const argGets = Array.from({ length: totalArgs }, (_, i) =>
    module.local.get(i, binaryen.i32)
  )

  module.addFunction(
    dispatch.functionName,
    paramTypes,
    returnType,
    [],
    module.call_indirect(
      tree.tableName,
      module.i32.load(0, 0, module.local.get(0, binaryen.i32)),
      argGets,
      paramTypes,
      returnType
    )
  )

  module.addFunctionExport(dispatch.functionName, dispatch.functionName)
}
```

### Usage Example

```typescript
const dispatch: CascadingDispatch = {
  functionName: 'greet',
  argTypes: [
    ['Person$without_sex', 'Person$with_sex'],    // Arg 0: Person
    ['Style$casual', 'Style$formal']               // Arg 1: Style
  ],
  implementations: new Map([
    ['0$0', '$greet$0$0'],
    ['0$1', '$greet$0$1'],
    ['1$0', '$greet$1$0'],
    ['1$1', '$greet$1$1'],
  ])
}

emitCascadingDispatch(module, dispatch)
```

---

## Multi-Argument Dispatch

### Three Arguments Example

```tinywhale
process = (a: A, b: B, c: C) -> Result
# A: 2 variants, B: 3 variants, C: 2 variants
```

**Cascade structure**:

```
Level 1 (A dispatch): 2 entries
    ├─► A0: Level 2a (B dispatch): 3 entries
    │       ├─► B0: Level 3a0 (C dispatch): 2 entries → impl$0$0$0, impl$0$0$1
    │       ├─► B1: Level 3a1 (C dispatch): 2 entries → impl$0$1$0, impl$0$1$1
    │       └─► B2: Level 3a2 (C dispatch): 2 entries → impl$0$2$0, impl$0$2$1
    │
    └─► A1: Level 2b (B dispatch): 3 entries
            ├─► B0: Level 3b0 (C dispatch): 2 entries → impl$1$0$0, impl$1$0$1
            ├─► B1: Level 3b1 (C dispatch): 2 entries → impl$1$1$0, impl$1$1$1
            └─► B2: Level 3b2 (C dispatch): 2 entries → impl$1$2$0, impl$1$2$1
```

**Table count**: 1 + 2 + 6 = 9 tables
**Entry count**: 2 + 6 + 12 = 20 entries
**Flattened would be**: 2×3×2 = 12 entries (fewer entries, but one giant table)

### Sparse Dispatch Optimization

If only certain combinations are valid:

```tinywhale
# Only 4 valid combinations out of 12
process(A0, B0, C0) ✓
process(A0, B1, C1) ✓
process(A1, B2, C0) ✓
process(A1, B2, C1) ✓
```

**Cascading can prune**:

```
Level 1 (A dispatch): 2 entries
    ├─► A0: Level 2a (B dispatch): 2 entries (only B0, B1 needed)
    │       ├─► B0: → impl$0$0$0 (only C0 valid)
    │       └─► B1: → impl$0$1$1 (only C1 valid)
    │
    └─► A1: Level 2b (B dispatch): 1 entry (only B2 needed)
            └─► B2: Level 3b2 (C dispatch): 2 entries → impl$1$2$0, impl$1$2$1
```

**Reduced**: 2 + 3 + 2 = 7 entries (vs 12 flattened, vs 20 full cascade)

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Type tag load | O(1) per argument | Memory load |
| Table lookup | O(1) per level | `call_indirect` |
| Function call | O(1) per level | Call overhead |
| **Total dispatch** | **O(k)** | k = number of dispatched arguments |

Each dispatched argument adds:
- 1 memory load (type tag)
- 1 `call_indirect`
- 1 function call frame

### Space Complexity

**Full cascade** (all combinations valid):
```
Tables: 1 + N1 + N1*N2 + N1*N2*N3 + ...
Entries: N1 + N1*N2 + N1*N2*N3 + ... (same)
```

**Compared to flattened**: `N1 * N2 * N3 * ...`

For dense dispatch, cascading uses **more space**.
For sparse dispatch, cascading can use **less space** via pruning.

### Call Overhead

Each cascade level adds ~3-5 cycles:
- Type tag load: 1 cycle (cached)
- call_indirect: 2-4 cycles

For k=3 arguments: ~9-15 extra cycles vs flattened.

---

## Trade-offs

### Advantages

| Advantage | Explanation |
|-----------|-------------|
| **Sparse efficiency** | Only create tables for valid paths |
| **Modular structure** | Each level is self-contained |
| **Incremental dispatch** | Can bail out early if type known |
| **Matches Julia semantics** | Conceptually similar dispatch model |
| **Easier debugging** | Can trace through levels |

### Disadvantages

| Disadvantage | Explanation |
|--------------|-------------|
| **Multiple indirections** | One `call_indirect` per argument |
| **More tables** | One table per branch in tree |
| **Code complexity** | More functions (dispatchers at each level) |
| **Dense dispatch overhead** | Uses more space than flattened |
| **Call stack depth** | Each level adds a frame |

### Comparison Matrix

| Aspect | Strategy 1 | Strategy 2 | Strategy 3 |
|--------|------------|------------|------------|
| Tables | 1 per function | 1 global | Many (tree) |
| Dispatch cost (k args) | O(1) | O(1) | O(k) |
| Space (dense) | N1*N2*... | N1*N2*... | More |
| Space (sparse) | N1*N2*... | N1*N2*... | Less |
| Modularity | High | Low | Very High |
| Complexity | Low | Medium | High |

---

## When to Use

### Ideal For

- **Highly sparse dispatch** — many invalid type combinations
- **Dynamic dispatch order** — want to dispatch on "most selective" argument first
- **Deep type hierarchies** — Julia-style "most specific method" selection
- **Debugging dispatch** — want to trace through levels
- **Incremental build** — can add/remove branches without full rebuild

### Less Suitable For

- **Dense dispatch** — all combinations valid, flattened is more efficient
- **Performance critical** — O(k) dispatch adds latency
- **Simple type systems** — overkill for small union types
- **Memory constrained** — many small tables have overhead

---

## Optimization: Hybrid Approach

Combine cascading with flattening:

**Heuristic**: If a sub-tree has fewer than N valid combinations, flatten it.

```
Level 1 (A dispatch): 2 entries
    ├─► A0: [Flattened: 3 entries for B×C combinations]
    └─► A1: Level 2b (B dispatch): 3 entries
            ├─► B0: [Flattened: 2 entries for C]
            └─► ...
```

This balances:
- Cascading's flexibility for sparse upper levels
- Flattening's efficiency for dense lower levels

---

## Relationship to TinyWhale Requirements

| Requirement | How Strategy 3 Addresses It |
|-------------|----------------------------|
| O(1) lookup | ⚠️ O(k) where k = dispatched args |
| Multi-argument dispatch | ✅ Natural fit for any number of args |
| Sealed unions | ✅ Tree structure fixed at compile time |
| No reflection | ✅ Type tags internal |
| Progressive enhancement | ✅ Easy to add new variants as tree branches |

### Verdict for TinyWhale

Strategy 3 is **appropriate if**:
1. You expect **sparse dispatch patterns** (not all type combinations used)
2. You want **Julia-like semantics** with explicit dispatch order
3. You're willing to accept **O(k) dispatch cost**

For TinyWhale's current scope (optional fields → union types), the dispatch is likely **dense** (all combinations valid), making Strategy 1 or 2 more efficient.

**Consider Strategy 3 when**:
- Adding inheritance or trait-like features
- Implementing "most specific method" semantics
- Needing to optimize for sparse type combinations

---

## Implementation Checklist

If Strategy 3 is selected:

1. **Design tree structure** — How to represent dispatch hierarchy
2. **Implement tree builder** — Convert type combinations to tree
3. **Add sparse pruning** — Remove invalid branches
4. **Generate tables** — One per tree node
5. **Generate dispatchers** — Functions at intermediate levels
6. **Optimize leaves** — Consider flattening dense sub-trees
7. **Test call overhead** — Measure actual dispatch latency
