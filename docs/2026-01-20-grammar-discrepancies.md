# Grammar vs Semantic Discrepancies Analysis

> **Date:** 2026-01-20 (Updated: 2026-01-25)
> **Purpose:** Identify discrepancies between grammar (what parses) and semantics (what compiles) to prepare for property-based compiler fuzzing.
> **Design Philosophy:** Strict grammar - grammar should only accept what the compiler can actually compile.

---

## Major Updates Since Original Analysis

**PR #53-56: Functions and Expression Unification**
- Basic functions implemented (lambdas, declarations, direct calls)
- "Everything is an expression" design completed
- Removed: `Statement`, `PanicStatement`, `FuncBinding`, `PrimitiveBinding`, `RecordBinding` grammar rules
- Unified all bindings through `BindingExpr`
- Record type syntax changed from `type Point` to just `Point`
- Record instantiation syntax changed from `p:Point =` to `p = Point`

**PR #57: Remove Deprecated Code**
- Removed deprecated node kinds from compiler
- Cleaned up ~410 lines of legacy code

---

## No-Discrepancies (Working Correctly)

### 1. Panic Expression

```tinywhale
panic
```

Unconditional trap that terminates execution. Fully supported from grammar through codegen.

```ohm
PanicExpr = panic
panic = "panic" ~identifierPart
```

**Updated:** Now `PanicExpr` (was `PanicStatement`). Everything is an expression.

---

### 2. Primitive Bindings (i32, i64, f32, f64)

```tinywhale
x: i32 = 42
y: i64 = 123
a: f32 = 1.5
b: f64 = 2.5
```

Variable bindings with primitive types and required expressions. Type checking and codegen work correctly.

```ohm
BindingExpr = identifier TypeAnnotation? equals Expression
```

**Updated:** Now unified as `BindingExpr` (was `PrimitiveBinding`).

---

### 3. Type Hints (min/max constraints)

```tinywhale
x: i32<min=0> = 5
y: i32<max=100> = 50
z: i32<min=0, max=100> = 75
```

Refinement types with constraint validation. Checker emits TWCHECK041 when constraints are violated.

```ohm
RefinementType = typeKeyword TypeBounds
TypeBounds = lessThan BoundList greaterThan
Bound = boundKeyword equals minus? intLiteral
boundKeyword = minKeyword | maxKeyword | sizeKeyword
```

---

### 4. Record Type Declarations

```tinywhale
Point
    x: i32
    y: i32
```

Nominal record types with field declarations. Type registration and field validation work correctly.

```ohm
RecordTypeDecl = upperIdentifier
FieldDecl = lowerIdentifier colon TypeRef
```

**Updated:** Syntax changed from `type Point` to just `Point`.

---

### 5. Record Initialization

```tinywhale
Point
    x: i32
    y: i32

p = Point
    x = 10
    y = 20
```

Record instantiation with field initializers. Field initialization validates types and detects missing/unknown fields.

```ohm
BindingExpr = identifier TypeAnnotation? equals Expression
FieldInit = lowerIdentifier equals Expression
```

**Updated:** Syntax changed from `p:Point =` to `p = Point`.

---

### 6. Nested Records

```tinywhale
Inner
    value: i32

Outer
    inner: Inner

o = Outer
    inner: Inner
        value = 42
```

Records containing other record types. Nested initialization syntax works correctly.

```ohm
FieldInit = lowerIdentifier (colon upperIdentifier | equals Expression)
```

---

### 7. Single-Level Lists

```tinywhale
arr: i32[]<size=3> = [1, 2, 3]
x: i32 = arr[0]
```

Lists with size hints and index access using integer literals. All primitive element types supported.

```ohm
ListType = typeKeyword ListTypeSuffix+
ListTypeSuffix = lbracket rbracket TypeBounds
ListLiteral = lbracket ListElements rbracket
IndexAccess = PostfixableBase (lbracket intLiteral rbracket)+
```

---

### 8. Field Access

```tinywhale
Point
    x: i32
    y: i32

p = Point
    x = 10
    y = 20

v: i32 = p.x
```

Accessing record fields, including chained access (`o.inner.value`). Type checking validates field existence.

```ohm
FieldAccess = PostfixableBase (dot lowerIdentifier)+
```

---

### 9. Arithmetic Operators

```tinywhale
x: i32 = 1 + 2 * 3
y: i32 = 10 - 5
z: i32 = 10 / 3
m: i32 = 10 % 3
e: i32 = -7 %% 3
```

All arithmetic operators with correct precedence. Includes Euclidean modulo (`%%`).

```ohm
AddExpr = MulExpr (addOp MulExpr)*
MulExpr = UnaryExpr (mulOp UnaryExpr)*
addOp = plus | minus
mulOp = star | slash | percentPercent | percent | ...
```

---

### 10. Comparison Operators and Chaining

```tinywhale
x: i32 = 1 < 2
y: i32 = 1 <= 2
chain: i32 = 1 < 2 < 3
```

All comparison operators return i32 (0/1). Comparison chaining supported (`a < b < c`).

```ohm
CompareExpr = AddExpr (compareOp AddExpr)*
compareOp = lessEqual | greaterEqual | lessThan | greaterThan | equalEqual | bangEqual
```

---

### 11. Bitwise and Shift Operators

```tinywhale
a: i32 = 5 & 3
b: i32 = 5 | 3
c: i32 = 5 ^ 3
d: i32 = ~5
e: i32 = 1 << 4
f: i32 = 16 >> 2
g: i32 = -1 >>> 1
```

Bitwise AND, OR, XOR, NOT and all shift operators. Integer types only.

```ohm
BitwiseAndExpr = CompareExpr (ampersand CompareExpr)*
BitwiseOrExpr = BitwiseXorExpr (bitwiseOr BitwiseXorExpr)*
BitwiseXorExpr = BitwiseAndExpr (caret BitwiseAndExpr)*
mulOp = ... | greaterGreaterGreater | greaterGreater | lessLess
unaryOp = minus | tilde
```

---

### 12. Logical Operators

```tinywhale
x: i32 = 1 && 0
y: i32 = 0 || 1
```

Short-circuit logical AND and OR. Return i32.

```ohm
LogicalOrExpr = LogicalAndExpr (pipePipe LogicalAndExpr)*
LogicalAndExpr = BitwiseOrExpr (ampAmp BitwiseOrExpr)*
```

---

### 13. Match with Literal Patterns

```tinywhale
x: i32 = 5
result: i32 = match x
    0 -> 100
    1 -> 200
    _ -> 0
```

Match expressions with integer literal patterns and wildcard. Exhaustiveness checking requires catch-all.

```ohm
MatchExpr = matchKeyword Expression
MatchArm = Pattern arrow Expression
LiteralPattern = minus? intLiteral
WildcardPattern = underscore
```

---

### 14. Match with Or-Patterns

```tinywhale
x: i32 = 2
result: i32 = match x
    0 | 1 | 2 -> 100
    _ -> 0
```

Multiple patterns combined with `|` in a single arm.

```ohm
OrPattern = PrimaryPattern (pipe PrimaryPattern)*
```

---

### 15. Standalone Match (for side effects)

```tinywhale
x: i32 = 1
match x
    0 -> panic
    _ -> panic
```

Match expression without binding result - for branching with side effects.

```ohm
# Match is an expression, can appear anywhere an expression is valid
Expression = ... | MatchExpr | ...
```

**Updated:** Match is now an expression (was routed through Statement).

---

### 16. Binding Patterns in Match

```tinywhale
x: i32 = 5
result: i32 = match x
    0 -> 100
    other -> other + 1
```

Binding patterns capture the matched value and make it available in the arm body. Lexically scoped - the binding is only visible within the arm.

```ohm
BindingPattern = ~keyword ~underscore identifier
```

**Fixed in PR #48:** Implemented lexical scoping with scope stack in SymbolStore. Match arms push/pop scopes so bindings don't leak.

---

### 17. Comments

```tinywhale
# This is a comment #
x: i32 = 42 # inline comment
```

Hash-delimited or to end-of-line comments. Stripped during tokenization.

```ohm
comment = "#" (~("#" | "\n" | "\r" | anyDedent) any)* ("#" | &"\n" | &"\r" | &anyDedent | end)
```

---

### 18. Underscore-Prefixed Identifiers

```tinywhale
_unused: i32 = 42
```

Allowed for documentation purposes (marking unused variables). Compiler will warn but not error.

```ohm
identifier = ~keyword letter (alnum | "_")*
```

---

### 19. Empty Lists Disallowed

```tinywhale
# This correctly fails to parse:
# arr: i32[]<size=0> = []
```

Empty lists are intentionally invalid - TinyWhale uses Result/Option types, no uninitialized values.

```ohm
ListElements = Expression (comma Expression)*
```

---

### 20. `<<<` Operator Correctly Omitted

Unsigned left shift (`<<<`) would be identical to left shift (`<<`) - zeros fill from right regardless of signedness. Correctly not implemented.

```ohm
# Only these shift operators exist:
lessLess = "<<"
greaterGreater = ">>"
greaterGreaterGreater = ">>>"
```

---

### 21. Refinement Types in Field Declarations

```tinywhale
Point
    x: i32<min=0, max=100>
    y: i32<min=0, max=100>

p = Point
    x = 50
    y = 75
```

Refinement types can be used in record field declarations. Constraints are enforced during field initialization.

```ohm
FieldDecl = lowerIdentifier colon TypeRef
TypeRef = ListType | RefinementType | upperIdentifier | typeKeyword
RefinementType = typeKeyword TypeBounds
```

**Fixed in PR #49:** Parser now emits RefinementType as child of FieldDecl. Checker traverses nodes instead of using token offsets.

---

### 22. Record Instantiation Syntax

```tinywhale
Point
    x: i32
    y: i32

p = Point
    x = 50
    y = 10
```

Record instantiation uses `=` with type name. Field values use `=`. Nested record construction uses `:` with type name for the field.

```ohm
BindingExpr = identifier TypeAnnotation? equals Expression
FieldInit = lowerIdentifier (colon upperIdentifier | equals Expression)
```

**Updated:** Syntax changed from `p:Point` to `p = Point` in PR #56.

---

### 23. Functions (Basic) ✅

```tinywhale
add = (a: i32, b: i32): i32 -> a + b
result: i32 = add(1, 2)
```

Basic functions with lambdas, type inference, and direct function calls.

```ohm
Lambda = lparen Parameters rparen TypeAnnotation? arrow LambdaBody
FuncCall = PostfixableBase lparen Arguments rparen
FuncDecl = identifier colon FuncType
```

**Implemented in PRs #53-56:**
- Lambda expressions with parameters and return types
- Function declarations for forward references
- Direct function calls with arguments
- Multi-line bodies with expression sequences
- Type inference for parameters when type alias provided

**Not yet implemented (see original plan `2026-01-19-functions-roadmap.md`):**
- Higher-order functions (passing functions as arguments)
- Indirect calls (calling through a variable) — blocked by `codegen/index.ts:697`
- Tuples (multiple return values)
- Closures (capturing outer variables)
- Extern bindings (`extern wasm`, `extern host`)

---

## Discrepancies

### D1. Nested Lists

**Desired:**
```tinywhale
matrix: i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
x: i32 = matrix[0][1]
```
Should create 2D list and access nested elements.

**Actual:**
```tinywhale
matrix: i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
# Error: TWCHECK012 - type mismatch (expected i32, found list literal)
```
Grammar parses nested list types and literals, but checker doesn't support them.

```ohm
ListType = typeKeyword ListTypeSuffix+
ListTypeSuffix = lbracket rbracket TypeBounds
```

**Discrepancy:** Grammar allows `ListTypeSuffix+` (one or more), but checker only handles single level.

---

### D2. Chained Index Access

**Desired:**
```tinywhale
matrix: i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
x: i32 = matrix[0][1]
```
Should access element at row 0, column 1.

**Actual:**
```tinywhale
arr: i32[]<size=3> = [1, 2, 3]
x: i32 = arr[0][0]
# Error: TWCHECK031 - cannot index into i32 result
```
Grammar allows multiple index suffixes, but checker fails because first index returns primitive.

```ohm
IndexAccess = PostfixableBase (lbracket intLiteral rbracket)+
```

**Discrepancy:** Grammar allows `(lbracket intLiteral rbracket)+`, but checker doesn't validate chained index types.

---

### D3. List Destructuring Patterns (Missing)

**Desired:**
```tinywhale
arr: i32[]<size=3> = [1, 2, 3]
result: i32 = match arr
    [head, .., tail] -> head + tail
    _ -> 0
```
Should destructure list with head, rest (`..`), and tail patterns.

**Actual:** No list pattern syntax in grammar. Only `LiteralPattern`, `WildcardPattern`, `BindingPattern`, `OrPattern`.

```ohm
PrimaryPattern = WildcardPattern | LiteralPattern | BindingPattern
```

**Discrepancy:** Designed feature (discussed in previous session) never added to grammar. Includes:
- `[head, tail]` - fixed positions
- `[head, .., tail]` - rest pattern
- `[.., second_last, last]` - rest at start
- `[first, .._, last]` - explicit ignored rest

---

### D4. Record Destructuring Patterns (Missing)

**Desired:**
```tinywhale
Point
    x: i32
    y: i32

p = Point
    x = 10
    y = 20

result: i32 = match p
    {x, y} -> x + y
```
Should destructure record fields in pattern.

**Actual:** No record pattern syntax in grammar.

```ohm
PrimaryPattern = WildcardPattern | LiteralPattern | BindingPattern
```

**Discrepancy:** Designed feature never added. Includes:
- `{x, y}` - extract named fields
- `{x, _}` - partial extraction
- `{x, _y}` - extract with rename
- Nested record patterns

---

### D5. Pattern Guards (Missing)

**Desired:**
```tinywhale
x: i32 = 5
result: i32 = match x
    n on n > 0 -> n
    _ -> 0
```
Should allow `on` guard for additional conditions.

**Also designed:**
```tinywhale
expected: i32 = 5
result: i32 = match x
    _ is expected -> 100
    _ -> 0
```
`is` guard for pinning (like Elixir's `^`).

**Actual:** No guard syntax in grammar.

```ohm
MatchArm = Pattern arrow Expression
```

**Discrepancy:** Designed features (`on` and `is` guards) never added to grammar.

---

### D6. Negative Float Literals

**Desired:**
```tinywhale
x: f32 = -1.5
```
Should parse `-1.5` as single float literal token.

**Actual:**
```tinywhale
x: f32 = -1.5
# Parses as UnaryExpr(minus, 1.5), not as single literal
```
Works but tokenization is suboptimal - creates extra AST nodes.

```ohm
floatLiteral = digit+ "." digit+ (("e" | "E") ("+" | "-")? digit+)?
```

**Discrepancy:** Grammar lacks optional leading minus for float literals. Should be `minus? digit+ ...`.

---

### D7. List Field Initialization in Records

**Desired:**
```tinywhale
Data
    items: i32[]<size=3>

d = Data
    items = [1, 2, 3]
```
Should initialize list field in record.

**Actual:**
```tinywhale
Data
    items: i32[]<size=3>

d = Data
    items = [1, 2, 3]
# Error: WASM validator - local.set's value type must be correct
```
List field declaration works, but initialization produces invalid WASM.

```ohm
FieldInit = lowerIdentifier (colon upperIdentifier | equals Expression)
```

**Discrepancy:** `Expression` in `FieldInit` includes `ListLiteral`, but codegen doesn't handle list field initialization correctly.

---

### D8. Lists of User-Defined Types

**Desired:**
```tinywhale
Point
    x: i32
    y: i32

p1 = Point
    x = 1
    y = 2

p2 = Point
    x = 3
    y = 4

vertices: Point[]<size=2> = [p1, p2]
```
Should allow lists with record element types, initialized via variable references.

**Actual:** Grammar and type resolution work correctly. But records are currently flattened to local fields (`p1_x`, `p1_y`) - no whole-record symbol exists for `p1` itself, so it cannot be used in a list literal.

**Discrepancy:** Records are flattened to individual fields. Need WASM GC structs or similar to support whole-record references in lists.

**Note:** Functions are now implemented (PR #53-56), but this issue remains because records are still flattened at the codegen level.

---

### D9. Float Match Patterns

**Desired:**
```tinywhale
x: f32 = 1.5
result: i32 = match x
    1.5 -> 100
    _ -> 0
```
Should match on float literal patterns.

**Actual:**
```tinywhale
# Parse error - LiteralPattern only allows intLiteral
```

```ohm
LiteralPattern = minus? intLiteral
```

**Discrepancy:** Grammar restricts literal patterns to integers. Float patterns not supported.

---

## Future Enhancements (Not Discrepancies)

These items were discussed and deemed as planned future work, not current discrepancies:

### F1. Nested Lists Implementation
Grammar is correct (`ListTypeSuffix+`). Checker/codegen need implementation. Tracked as D1.

### F2. Variable Index Access
```tinywhale
arr: i32[]<size=3> = [1, 2, 3]
i: i32 = 1
x: i32 = arr[i]
```
Currently only integer literal indices for exhaustiveness checking. Variable indices planned with bounds checking.

```ohm
IndexAccess = PostfixableBase (lbracket intLiteral rbracket)+
```

### F3. Floats (Comprehensive)
Float implementation is incomplete. Includes:
- Float match patterns (D9)
- Negative float literals (D6)
- Numeric formats (hex, binary, octal)
- Float-specific operations

Worth multiple PRs.

### F4. Multi-line Lists / Trailing Commas
```tinywhale
# Undecided syntax - possibly comma-less:
arr: i32[]<size=3> = [
    1
    2
    3
]
# Or with spaces: [1 2 3]
```
Open design question. Not adding trailing comma support until decided.

### F5. Functions (Partial)

**Basic functions implemented in PRs #53-56:**
- Lambda expressions, function declarations, direct calls
- Multi-line bodies, type inference from aliases

**Still pending (per original plan `2026-01-19-functions-roadmap.md`):**
- PR 3: Higher-order functions (indirect calls via `call_indirect`)
- PR 4: Tuples (types, literals, destructuring)
- PR 5: Closures (variable capture)
- PR 6: Extern bindings (`extern wasm`, `extern host`)

### F6. Labeled Parameters for Same-Type Arguments

```tinywhale
# Two or more parameters of the same type require labels at call site:
transfer = (from: i32, to: i32, amount: i32): i32 -> from + to + amount

# Call site must use labels (order can vary):
transfer(from: 1, to: 2, amount: 500)
transfer(amount: 500, from: 1, to: 2)

# Single parameter or different types - no labels required:
sqrt = (n: f64): f64 -> n
sqrt(4.0)

format = (s: i32, width: i64): i32 -> s
format(1, 10)
```

This rule applies to both primitive types and record types:

```tinywhale
fn merge(base: Config, override: Config) -> Config
merge(base: defaults, override: userPrefs)  # labels required, same type
```

**Rationale:**
- Nominal types prevent swapping records of different types, but two `Config` parameters can still be swapped
- Primitives have no nominal protection - `transfer(2, 1, 500)` silently swaps sender/receiver
- Mirrors the `@` prefix philosophy: call sites should be locally readable without chasing definitions
- Labels are non-optional when required - no mixing labeled and positional for same-type params

**Severity:** Low - not foundational, can be added after core features stabilize.

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| Working correctly | 23 | ✅ All verified |
| Discrepancies | 9 | ❌ Open |
| Future enhancements | 5 | ⏳ Planned (F5 partial) |

**Fixes completed (PRs #47-57):**
- Dead VariableBinding grammar rule removed
- Postfix base restricted to identifiers only (no parens, literals, or list literals)
- Integer scientific notation negative exponents rejected at grammar level
- Binding patterns in match now work with lexical scoping
- Refinement types in field declarations now enforced
- Basic functions implemented (lambdas, declarations, direct calls)
- "Everything is expression" design completed
- Deprecated Statement-related code removed

**Remaining discrepancies for fuzzing preparation:**
1. D1-D2 (nested lists, chained index) - need checker/codegen implementation
2. D3-D5 (list/record destructuring, guards) - missing grammar + checker
3. D6 (negative float literals) - grammar change needed
4. D7 (list fields in records) - codegen fix needed
5. D8 (lists of user-defined types) - need WASM GC or alternative approach
6. D9 (float match patterns) - grammar + checker needed
