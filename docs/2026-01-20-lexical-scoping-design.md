# Lexical Scoping for TinyWhale

**Version**: 0.1.0-draft
**Status**: Design
**Date**: 2026-01-20

---

## Problem

The D3 implementation (binding patterns in match expressions) leaks symbols after the arm completes. The current `SymbolStore` uses flat continuation-style shadowing with no scope restoration.

```tinywhale
x: i32 = 5

result: i32 = match x
    0 -> 0
    n -> n + 1    # 'n' binds to matched value

check: i32 = n    # BUG: 'n' still visible (should be undefined)
```

## Solution

Implement lexical scoping with a scope stack in `SymbolStore`.

## Core Data Structures

```typescript
interface ScopeFrame {
  readonly bindings: Map<StringId, SymbolId>
}

class SymbolStore {
  private readonly symbols: SymbolEntry[] = []      // All symbols (for codegen)
  private readonly scopeStack: ScopeFrame[] = []    // Visibility stack
  private nextLocalIndex = 0                         // Monotonic counter
}
```

**Key insight:** The `symbols` array keeps all symbols because codegen needs to allocate locals for every binding that ever existed. The `scopeStack` controls what's *visible* during type checking.

## Core Operations

| Operation | Behavior |
|-----------|----------|
| `pushScope()` | Add new empty frame to stack |
| `popScope()` | Remove top frame (bindings become invisible) |
| `add(entry)` | Add symbol to current (top) scope |
| `lookupByName(nameId)` | Search top-to-bottom, return first match |

### Implementation

```typescript
pushScope(): void {
  this.scopeStack.push({ bindings: new Map() })
}

popScope(): void {
  if (this.scopeStack.length <= 1) {
    throw new Error('Cannot pop global scope')
  }
  this.scopeStack.pop()
}

add(entry: Omit<SymbolEntry, 'localIndex'>): SymbolId {
  const localIndex = this.nextLocalIndex++
  const id = symbolId(this.symbols.length)
  const fullEntry: SymbolEntry = { ...entry, localIndex }

  // Store in flat array (codegen needs all symbols)
  this.symbols.push(fullEntry)

  // Register in current scope's bindings
  const currentScope = this.scopeStack[this.scopeStack.length - 1]!
  currentScope.bindings.set(entry.nameId, id)

  return id
}

lookupByName(nameId: StringId): SymbolId | undefined {
  for (let i = this.scopeStack.length - 1; i >= 0; i--) {
    const scope = this.scopeStack[i]!
    const symId = scope.bindings.get(nameId)
    if (symId !== undefined) return symId
  }
  return undefined
}
```

## Key Guarantee

**Shadows never leak.** When a scope is popped, all its bindings are removed from the lookup path entirely.

```
# Trace example
scopeStack: [ Frame0: { outer → sym0 } ]

match x
    a ->                        # pushScope()
        # scopeStack: [ Frame0: {outer→sym0}, Frame1: {a→sym1} ]

        a + outer               # lookup(a) → sym1, lookup(outer) → sym0

        # popScope()
        # scopeStack: [ Frame0: {outer→sym0} ]

check: i32 = a                  # lookup(a) → undefined, ERROR
```

## Integration Points

### Match Arms

```typescript
export function processMatchArm(
  armId: NodeId,
  state: CheckerState,
  context: CompilationContext
): void {
  // ... validation unchanged ...

  // Push scope for this arm
  state.symbols.pushScope()

  // Check pattern (may create bindings in arm scope)
  checkPattern(patternId, state.matchContext.scrutinee.typeId, state, context)

  // Check arm body (sees arm-local bindings)
  const bodyResult = checkExpression(exprId, state.matchContext.expectedType, state, context)

  // Pop scope - arm bindings no longer visible
  state.symbols.popScope()

  // ... result handling unchanged ...
}
```

### Summary of Changes

| Location | Change |
|----------|--------|
| `SymbolStore` constructor | Push global scope |
| `processMatchArm()` | Push before pattern, pop after body |
| `createPatternBindingSymbol()` | No change (uses `add()`) |
| Codegen | No change (iterates flat `symbols` array) |

## Scope Boundaries

**Current (with this design):**

| Construct | Scope Behavior |
|-----------|----------------|
| Global/module level | Base scope (never popped) |
| Match arm | Push before pattern, pop after body |

**Future (when implemented):**

| Construct | Scope Behavior |
|-----------|----------------|
| Function body | Push on entry, pop on exit |
| Multi-line arm body | Same arm scope (no extra push needed) |
| Let blocks (if added) | Push/pop around block |

## Conceptual Model

Scoping explains multiple TinyWhale constructs consistently:

**Type declarations:**
```tinywhale
type Cell
    row: i32 = 1
    col: i32 = 1
    value: i32 = 10

# row, col, value don't exist here - scoped to Cell
```

**Match arms:**
```tinywhale
x: i32 = 5
result: i32 = match x
    n -> n + 1    # 'n' scoped to this arm

y: i32 = n        # ERROR: undefined variable 'n'
```

**Record initialization:**
```tinywhale
p: Point =
    x: 10         # scoped to init block
    y: 20
```

**Future - Functions:**
```tinywhale
add(a: i32, b: i32) -> i32 =
    a + b         # 'a', 'b' scoped to function body
```

**Mental shortcut:** Indentation signals scope boundary. Things defined "inside" stay inside.

## What Stays Unchanged

- `SymbolEntry` structure (nameId, typeId, parseNodeId, localIndex)
- `get(id: SymbolId)` — direct access by ID
- `declareRecordBinding()` — adds flattened symbols to current scope
- `declareListBinding()` — adds flattened symbols to current scope
- `localCount()` — returns total locals ever allocated
- Codegen — iterates `symbols` array, all locals still exist

## Follow-up Topics

1. **Memory management** — The `symbols` array grows monotonically since codegen needs all locals. Investigate local slot reuse for non-overlapping scopes. Address this before adding functions.

2. **Functions** — Scoping infrastructure will be in place, making functions simpler to add.

## Related Specifications

- Pattern Matching Specification (shadowing behavior)
- D3 Grammar/Semantic Discrepancies (binding patterns)
