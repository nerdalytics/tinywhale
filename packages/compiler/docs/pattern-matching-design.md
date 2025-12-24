# TinyWhale Pattern Matching Implementation Design

## Executive Summary

This document describes the implementation strategy for pattern matching in TinyWhale. The design follows TinyWhale's data-oriented architecture (inspired by Carbon) and integrates with the existing four-phase compiler pipeline: Lex → Parse → Check → Codegen.

Pattern matching serves as TinyWhale's sole binding mechanism. There is no assignment operator—only pattern matching against values. All bindings are immutable, and shadowing is automatic (the language's single implicit behavior).

## Current Architecture Overview

### Compiler Pipeline

```
Source → TokenStore → NodeStore → InstStore + SymbolStore → WebAssembly
         (Lex)        (Parse)     (Check)                   (Codegen)
```

### Current Binding Implementation

The current grammar supports only simple identifier bindings:

```
VariableBinding = identifier TypeAnnotation equals Expression
```

Example: `x:i32 = 42`

This compiles to:
1. Parse: `[Identifier, TypeAnnotation, IntLiteral, VariableBinding]` (postorder)
2. Check: `[IntConst, Bind]` instructions
3. Codegen: `(local.set $x (i32.const 42))`

### Data Structures

- **NodeId, TokenId, InstId, TypeId, SymbolId, ScopeId**: Branded integer IDs
- **Postorder storage**: Children precede parents in NodeStore
- **SymbolStore**: `nameToSymbol` map supports shadowing via overwrite

---

## Phased Implementation Strategy

Pattern matching is a large feature. We implement it in four phases, each building on the previous:

| Phase | Feature | Complexity |
|-------|---------|------------|
| 1 | Irrefutable pattern bindings (tuple, record, wildcard) | Medium |
| 2 | Match expressions with literal patterns | High |
| 3 | Variant types and exhaustiveness checking | High |
| 4 | Guards | Low |

---

## Phase 1: Irrefutable Pattern Bindings

### 1.1 Grammar Extensions

Extend `tinywhale.ohm`:

```ohm
// Change from:
VariableBinding = identifier TypeAnnotation equals Expression

// To:
VariableBinding = Pattern TypeAnnotation? equals Expression

// Pattern hierarchy (irrefutable only in Phase 1)
Pattern = TuplePattern | RecordPattern | WildcardPattern | IdentifierPattern

IdentifierPattern = identifier
WildcardPattern = underscore

TuplePattern = lbrace PatternList rbrace
PatternList = NonemptyPatternList?
NonemptyPatternList = Pattern (comma Pattern)* comma?

RecordPattern = lbrace FieldPatternList rbrace
FieldPatternList = NonemptyFieldPatternList?
NonemptyFieldPatternList = FieldPattern (comma FieldPattern)* comma?
FieldPattern = identifier colon Pattern    // explicit: {x: pat}
             | identifier                   // shorthand: {x} means {x: x}

// New tokens
underscore = "_" ~identifierPart
lbrace = "{"
rbrace = "}"
comma = ","
```

### 1.2 Token Extensions

Add to `TokenKind` in `src/core/tokens.ts`:

```typescript
export const TokenKind = {
  // ... existing tokens ...

  // Pattern delimiters (80-89)
  Underscore: 80,
  LBrace: 81,
  RBrace: 82,
  Comma: 83,
} as const
```

### 1.3 Node Kind Extensions

Add to `NodeKind` in `src/core/nodes.ts`:

```typescript
export const NodeKind = {
  // ... existing nodes ...

  // Patterns (200-219)
  IdentifierPattern: 200,
  WildcardPattern: 201,
  TuplePattern: 202,
  RecordPattern: 203,
  FieldPattern: 204,

  // Pattern list nodes (220-229)
  PatternList: 220,
  FieldPatternList: 221,
} as const
```

### 1.4 Type System Extensions

Add tuple and record types to `src/check/types.ts`:

```typescript
export const TypeKind = {
  // ... existing ...

  // Composite types (10-19)
  Tuple: 10,   // {T1, T2, ...}
  Record: 11,  // {field1: T1, field2: T2, ...}
} as const

// Extended TypeInfo for composite types
export interface TupleTypeInfo extends TypeInfo {
  kind: typeof TypeKind.Tuple
  elements: readonly TypeId[]  // Types of each element
}

export interface RecordTypeInfo extends TypeInfo {
  kind: typeof TypeKind.Record
  fields: ReadonlyMap<StringId, TypeId>  // Field name → type
}
```

### 1.5 Instruction Kind Extensions

Add to `InstKind` in `src/check/types.ts`:

```typescript
export const InstKind = {
  // ... existing ...

  // Tuple operations (40-49)
  TupleCreate: 40,    // Create tuple: arg0 = element count, elements on stack
  TupleAccess: 41,    // Access element: arg0 = tuple InstId, arg1 = index

  // Record operations (50-59)
  RecordCreate: 50,   // Create record: arg0 = field count
  RecordAccess: 51,   // Access field: arg0 = record InstId, arg1 = field StringId

  // Pattern matching (60-69)
  PatternBind: 60,    // Bind from pattern: arg0 = SymbolId, arg1 = source InstId
} as const
```

### 1.6 Pattern Checking Algorithm

In `src/check/checker.ts`, add pattern processing:

```typescript
interface PatternResult {
  bindings: Array<{ nameId: StringId; typeId: TypeId; sourceInstId: InstId }>
  typeId: TypeId
}

/**
 * Check a pattern against an expected type.
 * Returns the bindings introduced and the type matched.
 *
 * Patterns are processed PRE-ORDER (top-down) unlike expressions.
 * This allows us to propagate type information downward.
 */
function checkPattern(
  patternId: NodeId,
  expectedType: TypeId,
  sourceInstId: InstId,
  state: CheckerState,
  context: CompilationContext
): PatternResult {
  const node = context.nodes.get(patternId)

  switch (node.kind) {
    case NodeKind.IdentifierPattern:
      return checkIdentifierPattern(patternId, expectedType, sourceInstId, state, context)

    case NodeKind.WildcardPattern:
      // Wildcard matches any type, introduces no bindings
      return { bindings: [], typeId: expectedType }

    case NodeKind.TuplePattern:
      return checkTuplePattern(patternId, expectedType, sourceInstId, state, context)

    case NodeKind.RecordPattern:
      return checkRecordPattern(patternId, expectedType, sourceInstId, state, context)

    default:
      throw new Error(`Unknown pattern kind: ${node.kind}`)
  }
}

function checkIdentifierPattern(
  patternId: NodeId,
  expectedType: TypeId,
  sourceInstId: InstId,
  state: CheckerState,
  context: CompilationContext
): PatternResult {
  const node = context.nodes.get(patternId)
  const token = context.tokens.get(node.tokenId)
  const nameId = token.payload as StringId

  // Check for duplicate bindings in same pattern
  if (state.currentPatternBindings?.has(nameId)) {
    context.emitAtNode('TWCHECK020' as DiagnosticCode, patternId, {
      name: context.strings.get(nameId)
    })
    return { bindings: [], typeId: BuiltinTypeId.Invalid }
  }

  state.currentPatternBindings?.add(nameId)

  return {
    bindings: [{ nameId, typeId: expectedType, sourceInstId }],
    typeId: expectedType
  }
}

function checkTuplePattern(
  patternId: NodeId,
  expectedType: TypeId,
  sourceInstId: InstId,
  state: CheckerState,
  context: CompilationContext
): PatternResult {
  // Verify expected type is a tuple
  const typeInfo = state.types.get(expectedType)
  if (typeInfo.kind !== TypeKind.Tuple) {
    context.emitAtNode('TWCHECK021' as DiagnosticCode, patternId, {
      expected: state.types.typeName(expectedType),
      found: 'tuple pattern'
    })
    return { bindings: [], typeId: BuiltinTypeId.Invalid }
  }

  const tupleInfo = typeInfo as TupleTypeInfo
  const childPatterns = getChildPatterns(patternId, context)

  // Check arity
  if (childPatterns.length !== tupleInfo.elements.length) {
    context.emitAtNode('TWCHECK022' as DiagnosticCode, patternId, {
      expected: tupleInfo.elements.length,
      found: childPatterns.length
    })
    return { bindings: [], typeId: BuiltinTypeId.Invalid }
  }

  // Check each sub-pattern
  const allBindings: PatternResult['bindings'] = []

  for (let i = 0; i < childPatterns.length; i++) {
    const elementType = tupleInfo.elements[i]!
    const accessInstId = state.insts.add({
      kind: InstKind.TupleAccess,
      typeId: elementType,
      arg0: sourceInstId as number,
      arg1: i,
      parseNodeId: patternId
    })

    const result = checkPattern(
      childPatterns[i]!,
      elementType,
      accessInstId,
      state,
      context
    )

    allBindings.push(...result.bindings)
  }

  return { bindings: allBindings, typeId: expectedType }
}
```

### 1.7 Modified Variable Binding Processing

Update `processVariableBinding` to use patterns:

```typescript
function processVariableBinding(
  bindingId: NodeId,
  state: CheckerState,
  context: CompilationContext
): void {
  // Find pattern node (may be complex, not just identifier)
  const patternResult = findPatternInBinding(bindingId, context)
  if (!patternResult) return

  const { patternId, typeAnnotationId, exprId } = patternResult

  // Resolve declared type (if present)
  const declaredType = typeAnnotationId
    ? getTypeFromAnnotation(typeAnnotationId, state, context)
    : null

  // Check expression
  const exprResult = declaredType
    ? checkExpression(exprId, declaredType, state, context)
    : inferExpression(exprId, state, context)

  if (exprResult.typeId === BuiltinTypeId.Invalid) return

  // Initialize pattern binding set (for duplicate detection)
  state.currentPatternBindings = new Set()

  // Check pattern against expression type
  const patternResult = checkPattern(
    patternId,
    exprResult.typeId,
    exprResult.instId,
    state,
    context
  )

  state.currentPatternBindings = null

  // Emit bindings
  for (const binding of patternResult.bindings) {
    const symId = state.symbols.add({
      nameId: binding.nameId,
      typeId: binding.typeId,
      parseNodeId: bindingId
    })

    state.insts.add({
      kind: InstKind.PatternBind,
      typeId: binding.typeId,
      arg0: symId as number,
      arg1: binding.sourceInstId as number,
      parseNodeId: bindingId
    })
  }
}
```

### 1.8 Code Generation for Patterns

Add to `src/codegen/index.ts`:

```typescript
function emitTupleAccess(
  mod: binaryen.Module,
  inst: Inst,
  valueMap: Map<number, binaryen.ExpressionRef>,
  context: CompilationContext
): binaryen.ExpressionRef | null {
  const tupleExpr = valueMap.get(inst.arg0)
  if (!tupleExpr) return null

  const index = inst.arg1
  const binaryenType = toBinaryenType(inst.typeId, context)

  // For now, tuples are represented as linear memory structs
  // This will use struct.get once WASM GC is available
  return mod.tuple.extract(tupleExpr, index)
}

function emitPatternBind(
  mod: binaryen.Module,
  inst: Inst,
  valueMap: Map<number, binaryen.ExpressionRef>,
  context: CompilationContext
): binaryen.ExpressionRef | null {
  const symId = inst.arg0
  const sourceInstId = inst.arg1
  const symbol = context.symbols?.get(symId as SymbolId)
  if (!symbol) return null

  const sourceExpr = valueMap.get(sourceInstId)
  if (sourceExpr === undefined) return null

  return mod.local.set(symbol.localIndex, sourceExpr)
}
```

---

## Phase 2: Match Expressions

### 2.1 Grammar Extensions

```ohm
// Extend Expression
Expression = MatchExpr | UnaryExpr | identifier | floatLiteral | intLiteral

// Match expression
MatchExpr = match Expression matchBody
matchBody = indent MatchArm+ dedent
MatchArm = Pattern arrow Expression

// Extend Pattern for refutable matching
Pattern = ... | LiteralPattern
LiteralPattern = floatLiteral | intLiteral

// New tokens
match = "match" ~identifierPart
arrow = "->"
```

### 2.2 Node Kind Extensions

```typescript
export const NodeKind = {
  // ... existing ...

  // Match expression (230-239)
  MatchExpression: 230,
  MatchArm: 231,
  MatchBody: 232,

  // Literal pattern
  LiteralPattern: 205,
} as const
```

### 2.3 Instruction Kind Extensions

```typescript
export const InstKind = {
  // ... existing ...

  // Match control flow (70-79)
  MatchBegin: 70,     // arg0 = scrutinee InstId, arg1 = arm count
  ArmTest: 71,        // arg0 = pattern value, arg1 = scrutinee InstId (for literals)
  ArmBody: 72,        // arg0 = body InstId
  MatchEnd: 73,       // arg0 = result type, merges all arm results
} as const
```

### 2.4 Match Expression Checking

```typescript
interface MatchArmInfo {
  patternId: NodeId
  bodyId: NodeId
  bindings: PatternResult['bindings']
}

function checkMatchExpression(
  matchId: NodeId,
  expectedType: TypeId,
  state: CheckerState,
  context: CompilationContext
): ExprResult {
  // Find scrutinee expression
  const scrutineeId = findScrutineeInMatch(matchId, context)
  const scrutineeResult = inferExpression(scrutineeId, state, context)

  if (scrutineeResult.typeId === BuiltinTypeId.Invalid) {
    return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
  }

  // Emit MatchBegin
  const arms = collectMatchArms(matchId, context)
  const matchBeginId = state.insts.add({
    kind: InstKind.MatchBegin,
    typeId: scrutineeResult.typeId,
    arg0: scrutineeResult.instId as number,
    arg1: arms.length,
    parseNodeId: matchId
  })

  // Check each arm
  let resultType: TypeId | null = null
  const armResults: InstId[] = []

  for (const arm of arms) {
    // Create arm scope
    const armScopeId = state.scopes.createChildScope(state.currentScope.id)
    const savedScope = state.currentScope
    state.currentScope = state.scopes.get(armScopeId)

    // Check pattern (may be refutable)
    state.currentPatternBindings = new Set()
    const patternResult = checkPattern(
      arm.patternId,
      scrutineeResult.typeId,
      scrutineeResult.instId,
      state,
      context
    )
    state.currentPatternBindings = null

    // Add pattern bindings to arm scope
    for (const binding of patternResult.bindings) {
      const symId = state.symbols.add({
        nameId: binding.nameId,
        typeId: binding.typeId,
        parseNodeId: arm.patternId
      })

      state.insts.add({
        kind: InstKind.PatternBind,
        typeId: binding.typeId,
        arg0: symId as number,
        arg1: binding.sourceInstId as number,
        parseNodeId: arm.patternId
      })
    }

    // Check arm body
    const bodyResult = checkExpression(
      arm.bodyId,
      resultType ?? expectedType,
      state,
      context
    )

    // Track result type (all arms must have same type)
    if (resultType === null) {
      resultType = bodyResult.typeId
    } else if (!state.types.areEqual(resultType, bodyResult.typeId)) {
      context.emitAtNode('TWCHECK030' as DiagnosticCode, arm.bodyId, {
        expected: state.types.typeName(resultType),
        found: state.types.typeName(bodyResult.typeId)
      })
    }

    armResults.push(bodyResult.instId)

    // Restore scope
    state.currentScope = savedScope
  }

  // Emit MatchEnd
  const matchEndId = state.insts.add({
    kind: InstKind.MatchEnd,
    typeId: resultType ?? BuiltinTypeId.None,
    arg0: 0,
    arg1: 0,
    parseNodeId: matchId
  })

  return { instId: matchEndId, typeId: resultType ?? BuiltinTypeId.None }
}
```

### 2.5 Code Generation for Match

For simple literal patterns, generate nested if-else:

```typescript
function emitMatchExpression(
  mod: binaryen.Module,
  matchBeginInstId: InstId,
  armInsts: Inst[],
  valueMap: Map<number, binaryen.ExpressionRef>,
  context: CompilationContext
): binaryen.ExpressionRef {
  const scrutineeExpr = valueMap.get(matchBeginInst.arg0)!
  const resultType = toBinaryenType(matchEndInst.typeId, context)

  // For simple cases: nested if-else
  // For many arms with contiguous integers: br_table

  // Build from last arm backwards (else chain)
  let result: binaryen.ExpressionRef = mod.unreachable() // fallback

  for (let i = armInsts.length - 1; i >= 0; i--) {
    const arm = armInsts[i]!
    const bodyExpr = valueMap.get(arm.bodyInstId as number)!

    if (arm.isLiteralPattern) {
      // Conditional: if scrutinee == literal then body else rest
      const condition = mod.i32.eq(scrutineeExpr, mod.i32.const(arm.literalValue))
      result = mod.if(condition, bodyExpr, result)
    } else {
      // Catch-all (identifier or wildcard): just the body
      result = bodyExpr
    }
  }

  return result
}
```

For variant patterns, use `br_table`:

```typescript
function emitVariantMatch(
  mod: binaryen.Module,
  scrutineeExpr: binaryen.ExpressionRef,
  arms: VariantArm[],
  context: CompilationContext
): binaryen.ExpressionRef {
  // Extract tag from variant
  const tagExpr = mod.struct.get(scrutineeExpr, 0, binaryen.i32)

  // Create block labels for each arm
  const blocks: binaryen.ExpressionRef[] = []

  // br_table dispatch
  return mod.block(null, [
    mod.br_table(
      arms.map((_, i) => `arm_${i}`),
      'default',
      tagExpr
    ),
    ...arms.map((arm, i) =>
      mod.block(`arm_${i}`, [arm.bodyExpr, mod.br('match_end')])
    ),
    mod.block('default', [mod.unreachable()])
  ], 'match_end')
}
```

---

## Phase 3: Variant Types and Exhaustiveness

### 3.1 Grammar for Variant Types

```ohm
// Type declarations
TypeDecl = type identifier equals VariantDef

VariantDef = VariantCase (pipe VariantCase)*
VariantCase = identifier                     // Unit variant: None
            | identifier lparen TypeList rparen  // Payload variant: Some(t)

// Variant pattern
Pattern = ... | VariantPattern
VariantPattern = identifier                         // Unit: None
               | identifier lparen PatternList rparen  // Payload: Some(x)
```

### 3.2 Type System for Variants

```typescript
export interface VariantTypeInfo extends TypeInfo {
  kind: typeof TypeKind.Variant
  cases: ReadonlyMap<StringId, VariantCase>
}

export interface VariantCase {
  tag: number                    // Runtime discriminant
  payloadTypes: readonly TypeId[] // Empty for unit variants
}
```

### 3.3 Exhaustiveness Checking Algorithm

Implement Maranget's algorithm for pattern matrix exhaustiveness:

```typescript
interface PatternMatrix {
  rows: PatternRow[]
  columnTypes: TypeId[]
}

interface PatternRow {
  patterns: Pattern[]
  action: NodeId  // arm body
}

type Pattern =
  | { kind: 'wildcard' }
  | { kind: 'identifier'; nameId: StringId }
  | { kind: 'literal'; value: bigint | number }
  | { kind: 'variant'; tag: number; subpatterns: Pattern[] }
  | { kind: 'tuple'; subpatterns: Pattern[] }

/**
 * Check if a pattern matrix is exhaustive.
 * Returns a list of missing patterns if not exhaustive.
 */
function checkExhaustiveness(
  matrix: PatternMatrix,
  types: TypeStore
): Pattern[] | null {
  // Base case: empty matrix with columns → not exhaustive (missing wildcard)
  if (matrix.rows.length === 0) {
    if (matrix.columnTypes.length === 0) {
      return null // exhaustive
    }
    return [{ kind: 'wildcard' }] // missing case
  }

  // Base case: no columns → exhaustive (we have at least one row)
  if (matrix.columnTypes.length === 0) {
    return null
  }

  // Get the first column type
  const firstType = matrix.columnTypes[0]!
  const typeInfo = types.get(firstType)

  // Collect constructors used in first column
  const usedConstructors = collectConstructors(matrix, 0)

  if (typeInfo.kind === TypeKind.Variant) {
    const variantInfo = typeInfo as VariantTypeInfo
    const allTags = new Set(variantInfo.cases.values().map(c => c.tag))

    // Check if all constructors are covered
    if (setsEqual(usedConstructors, allTags)) {
      // Specialize matrix for each constructor
      for (const tag of allTags) {
        const specialized = specializeMatrix(matrix, tag)
        const missing = checkExhaustiveness(specialized, types)
        if (missing !== null) {
          return [{ kind: 'variant', tag, subpatterns: missing }]
        }
      }
      return null
    } else {
      // Some constructors missing
      const missingTags = difference(allTags, usedConstructors)
      return Array.from(missingTags).map(tag => ({
        kind: 'variant' as const,
        tag,
        subpatterns: []
      }))
    }
  }

  // For infinite types (integers), check for wildcard
  if (hasWildcardInColumn(matrix, 0)) {
    const defaultMatrix = defaultMatrix(matrix, 0)
    return checkExhaustiveness(defaultMatrix, types)
  }

  // No wildcard for infinite type → not exhaustive
  return [{ kind: 'wildcard' }]
}
```

### 3.4 Exhaustiveness Error Messages

```typescript
function formatMissingPattern(pattern: Pattern, types: TypeStore): string {
  switch (pattern.kind) {
    case 'wildcard':
      return '_'
    case 'variant':
      const caseName = getCaseName(pattern.tag, types)
      if (pattern.subpatterns.length === 0) {
        return caseName
      }
      const subs = pattern.subpatterns.map(p => formatMissingPattern(p, types))
      return `${caseName}(${subs.join(', ')})`
    // ...
  }
}

// Error emission
context.emitAtNode('TWCHECK040' as DiagnosticCode, matchId, {
  missing: missingPatterns.map(p => formatMissingPattern(p, types)).join(', ')
})
```

---

## Phase 4: Guards

### 4.1 Grammar

```ohm
MatchArm = Pattern Guard? arrow Expression
Guard = if Expression
```

### 4.2 Node Kind

```typescript
export const NodeKind = {
  // ...
  Guard: 240,
} as const
```

### 4.3 Checking Guards

```typescript
function checkMatchArm(
  armId: NodeId,
  scrutineeType: TypeId,
  scrutineeInstId: InstId,
  expectedResultType: TypeId,
  state: CheckerState,
  context: CompilationContext
): ArmResult {
  const { patternId, guardId, bodyId } = parseArm(armId, context)

  // Check pattern (adds bindings to scope)
  const patternResult = checkPattern(patternId, scrutineeType, scrutineeInstId, state, context)

  // Check guard if present (must be bool)
  let guardInstId: InstId | null = null
  if (guardId) {
    const guardResult = checkExpression(guardId, BuiltinTypeId.Bool, state, context)
    guardInstId = guardResult.instId
  }

  // Check body
  const bodyResult = checkExpression(bodyId, expectedResultType, state, context)

  return {
    patternResult,
    guardInstId,
    bodyInstId: bodyResult.instId,
    resultType: bodyResult.typeId
  }
}
```

### 4.4 Exhaustiveness with Guards

Guards make patterns refutable even if they look exhaustive:

```typescript
function armIsRefutable(arm: ArmInfo): boolean {
  // Arms with guards are always refutable (guard might fail)
  if (arm.guardId !== null) return true

  return patternIsRefutable(arm.pattern)
}

// Exhaustiveness checking must account for guards
function checkExhaustivenessWithGuards(arms: ArmInfo[]): boolean {
  // Find the last arm without a guard
  const lastUnguarded = arms.findLast(a => a.guardId === null)

  if (!lastUnguarded) {
    // All arms have guards → warn about possible non-exhaustiveness
    return false
  }

  // The unguarded arm must be a catch-all
  return isIrrefutablePattern(lastUnguarded.pattern)
}
```

### 4.5 Code Generation with Guards

```typescript
function emitGuardedArm(
  mod: binaryen.Module,
  arm: ArmInfo,
  scrutineeExpr: binaryen.ExpressionRef,
  nextArm: binaryen.ExpressionRef,
  valueMap: Map<number, binaryen.ExpressionRef>
): binaryen.ExpressionRef {
  // Pattern bindings
  const bindings = emitPatternBindings(mod, arm.patternResult, scrutineeExpr)

  // Guard condition
  const guardExpr = valueMap.get(arm.guardInstId as number)!

  // Body
  const bodyExpr = valueMap.get(arm.bodyInstId as number)!

  // if (guard) { body } else { nextArm }
  return mod.block(null, [
    ...bindings,
    mod.if(guardExpr, bodyExpr, nextArm)
  ])
}
```

---

## Scope Model Details

### Continuation-Based Scoping

Each binding extends an implicit scope for all subsequent code:

```typescript
interface Scope {
  id: ScopeId
  parentId: ScopeId | null
  // New: track which symbols were introduced in this scope
  introducedSymbols: Set<SymbolId>
  reachable: boolean
}

class ScopeStore {
  // ...

  createChildScope(parentId: ScopeId): ScopeId {
    return this.add({
      id: scopeId(this.scopes.length),
      parentId,
      introducedSymbols: new Set(),
      reachable: this.get(parentId).reachable
    })
  }

  // When exiting a scope, symbols introduced in it become unreachable
  // (handled by nameToSymbol restoration)
}
```

### Block Scope Interaction

For future blocks (if/while/for), we need scope restoration:

```typescript
class SymbolStore {
  // Snapshot for scope restoration
  private readonly scopeSnapshots: Map<ScopeId, Map<number, SymbolId>> = new Map()

  enterScope(scopeId: ScopeId): void {
    // Snapshot current name→symbol mapping
    this.scopeSnapshots.set(scopeId, new Map(this.nameToSymbol))
  }

  exitScope(scopeId: ScopeId): void {
    // Restore previous mapping
    const snapshot = this.scopeSnapshots.get(scopeId)
    if (snapshot) {
      this.nameToSymbol = snapshot
      this.scopeSnapshots.delete(scopeId)
    }
  }
}
```

---

## Diagnostic Codes

New diagnostic codes for pattern matching:

| Code | Severity | Message |
|------|----------|---------|
| TWCHECK020 | Error | duplicate binding '{name}' in pattern |
| TWCHECK021 | Error | type mismatch: expected {expected}, found {found} |
| TWCHECK022 | Error | tuple pattern has wrong arity: expected {expected} elements, found {found} |
| TWCHECK023 | Error | record pattern missing field '{field}' |
| TWCHECK024 | Error | record pattern has extra field '{field}' |
| TWCHECK025 | Error | unknown variant '{name}' |
| TWCHECK030 | Error | match arms have incompatible types: expected {expected}, found {found} |
| TWCHECK040 | Error | non-exhaustive match: missing {missing} |
| TWCHECK041 | Warning | unreachable match arm |
| TWCHECK042 | Warning | match with guards may not be exhaustive |

---

## WebAssembly Representation

### Tuples

**Phase 1 (MVP):** Tuples as WASM multi-values or linear memory.

```wat
;; {x, y}:{{i32, i64}} = getTuple()
(call $getTuple)  ;; returns (i32, i64) on stack
(local.set $y)    ;; pop second element
(local.set $x)    ;; pop first element
```

**Future (WASM GC):** Tuples as structs.

```wat
;; With WASM GC
(struct.get $tuple_i32_i64 0)  ;; get first element
(struct.get $tuple_i32_i64 1)  ;; get second element
```

### Variants

**Phase 1:** Tagged unions in linear memory.

```wat
;; type Result = Ok(i32) | Err(i32)
;; Memory layout: [tag: i32][payload: i32]

;; match result { Ok(v) -> v, Err(e) -> 0 }
(block $match_end (result i32)
  (block $arm_err
    (block $arm_ok
      (local.get $result)
      (i32.load)         ;; load tag
      (br_table $arm_ok $arm_err)
    )
    ;; arm_ok: extract payload
    (local.get $result)
    (i32.load offset=4)
    (br $match_end)
  )
  ;; arm_err: return 0
  (i32.const 0)
)
```

**Future (WASM GC):** Proper sum types.

---

## Testing Strategy

### Unit Tests

1. **Parser tests**: Pattern syntax parsing
2. **Checker tests**: Pattern type checking, binding extraction
3. **Exhaustiveness tests**: Coverage analysis
4. **Codegen tests**: WASM output verification

### Integration Tests

```tinywhale
# Test: tuple destructuring
{x, y}:{i32, i32} = {1, 2}
result:i32 = x + y  # should be 3

# Test: record destructuring
{name, age}:{name: String, age: i32} = getPerson()

# Test: match expression
result:i32 = match count {
  0 -> 100
  1 -> 200
  n -> n * 10
}

# Test: variant matching
type Option(t) = Some(t) | None

value:i32 = match maybeInt {
  Some(n) -> n
  None -> 0
}

# Test: guards
type Ordering = Less | Equal | Greater

compare:Ordering = match {a, b} {
  {x, y} if x < y -> Less
  {x, y} if x > y -> Greater
  _ -> Equal
}
```

### Error Case Tests

```tinywhale
# Should error: duplicate binding
{x, x}:{i32, i32} = getTuple()  # ERROR: duplicate binding 'x'

# Should error: non-exhaustive
match maybeInt {  # ERROR: non-exhaustive, missing None
  Some(n) -> n
}

# Should error: type mismatch
{x, y}:{i32, i32} = 42  # ERROR: expected tuple, found i32
```

---

## Implementation Checklist

### Phase 1: Irrefutable Patterns
- [ ] Add tokens: `_`, `{`, `}`, `,`
- [ ] Add grammar rules for patterns
- [ ] Add NodeKind values for patterns
- [ ] Implement pattern parsing in semantic actions
- [ ] Add TypeKind.Tuple and TypeKind.Record
- [ ] Implement checkPattern in checker
- [ ] Add duplicate binding detection
- [ ] Implement pattern code generation
- [ ] Add diagnostic messages
- [ ] Write unit tests
- [ ] Write integration tests

### Phase 2: Match Expressions
- [ ] Add tokens: `match`, `->`
- [ ] Add grammar rules for match
- [ ] Add NodeKind values for match
- [ ] Implement match parsing
- [ ] Add literal patterns
- [ ] Implement match expression checking
- [ ] Implement arm type unification
- [ ] Implement match code generation
- [ ] Add diagnostic messages
- [ ] Write tests

### Phase 3: Variants & Exhaustiveness
- [ ] Add grammar for type declarations
- [ ] Add TypeKind.Variant
- [ ] Implement variant type checking
- [ ] Add variant patterns
- [ ] Implement exhaustiveness algorithm
- [ ] Add exhaustiveness errors
- [ ] Implement variant code generation
- [ ] Write tests

### Phase 4: Guards
- [ ] Add grammar for guards
- [ ] Add NodeKind.Guard
- [ ] Implement guard checking
- [ ] Update exhaustiveness for guards
- [ ] Implement guarded arm codegen
- [ ] Write tests

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| No shadow keyword | Automatic shadowing | Single concept (immutable bindings), no false dichotomy |
| Irrefutable patterns first | Phase 1 | Simpler to implement, immediately useful |
| Continuation scoping | Roc-style | Natural for pipelines, matches shadowing semantics |
| Exhaustiveness checking | Compile-time | Catches bugs early, matches ML tradition |
| Guards explicit | `if` keyword | No ambiguity between pattern and condition |
| Tuple syntax | `{a, b}` | Consistent with record destructuring |
| WASM representation | Multi-value MVP | Works without GC, upgrade path clear |

---

## References

- [Carbon Design: Pattern Matching](https://github.com/carbon-language/carbon-lang/tree/trunk/docs/design/pattern_matching)
- [Roc: Pattern Matching](https://www.roc-lang.org/tutorial#pattern-matching)
- [Maranget: Compiling Pattern Matching](http://moscova.inria.fr/~maranget/papers/ml05e-maranget.pdf)
- [WebAssembly GC Proposal](https://github.com/WebAssembly/gc)
