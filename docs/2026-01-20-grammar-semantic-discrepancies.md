# Grammar vs Semantic Discrepancies Analysis

> **Date:** 2026-01-20
> **Purpose:** Identify discrepancies between grammar (what parses) and semantics (what compiles) to prepare for property-based compiler fuzzing.
> **Design Philosophy:** Strict grammar - grammar should only accept what the compiler can actually compile.

---

## No-Discrepancies (Working Correctly)

### 1. Panic Statement

```tinywhale
panic
```

Unconditional trap that terminates execution. Fully supported from grammar through codegen.

```ohm
PanicStatement = panic
panic = "panic" ~identifierPart
```

---

### 2. Primitive Bindings (i32, i64, f32, f64)

```tinywhale
x:i32 = 42
y:i64 = 123
a:f32 = 1.5
b:f64 = 2.5
```

Variable bindings with primitive types and required expressions. Type checking and codegen work correctly.

```ohm
PrimitiveBinding = identifier colon PrimitiveTypeRef equals Expression
PrimitiveTypeRef = ListType | HintedPrimitive | typeKeyword
typeKeyword = i32 | i64 | f32 | f64
```

---

### 3. Type Hints (min/max constraints)

```tinywhale
x:i32<min=0> = 5
y:i32<max=100> = 50
z:i32<min=0, max=100> = 75
```

Refinement types with constraint validation. Checker emits TWCHECK041 when constraints are violated.

```ohm
HintedPrimitive = typeKeyword TypeHints
TypeHints = lessThan HintList greaterThan
Hint = hintKeyword equals minus? intLiteral
hintKeyword = minKeyword | maxKeyword | sizeKeyword
```

---

### 4. Record Type Declarations

```tinywhale
type Point
    x: i32
    y: i32
```

Nominal record types with field declarations. Type registration and field validation work correctly.

```ohm
TypeDecl = typeKeywordToken upperIdentifier
FieldDecl = lowerIdentifier colon TypeRef
```

---

### 5. Record Initialization

```tinywhale
type Point
    x: i32
    y: i32
p:Point =
    x: 10
    y: 20
```

Record binding without expression (block follows). Field initialization validates types and detects missing/unknown fields.

```ohm
RecordBinding = identifier colon upperIdentifier equals
FieldInit = lowerIdentifier colon FieldValue
FieldValue = NestedRecordInit | Expression
```

---

### 6. Nested Records

```tinywhale
type Inner
    value: i32
type Outer
    inner: Inner
o:Outer =
    inner: Inner
        value: 42
```

Records containing other record types. Nested initialization syntax works correctly.

```ohm
NestedRecordInit = upperIdentifier
```

---

### 7. Single-Level Lists

```tinywhale
arr:i32[]<size=3> = [1, 2, 3]
x:i32 = arr[0]
```

Lists with size hints and index access using integer literals. All primitive element types supported.

```ohm
ListType = ListTypeBase ListTypeSuffix+
ListTypeSuffix = lbracket rbracket TypeHints
ListLiteral = lbracket ListElements rbracket
IndexAccess = PostfixBase (lbracket intLiteral rbracket)+
```

---

### 8. Field Access

```tinywhale
type Point
    x: i32
    y: i32
p:Point =
    x: 10
    y: 20
v:i32 = p.x
```

Accessing record fields, including chained access (`o.inner.value`). Type checking validates field existence.

```ohm
FieldAccess = PrimaryExprBase (dot lowerIdentifier)+
```

---

### 9. Arithmetic Operators

```tinywhale
x:i32 = 1 + 2 * 3
y:i32 = 10 - 5
z:i32 = 10 / 3
m:i32 = 10 % 3
e:i32 = -7 %% 3
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
x:i32 = 1 < 2
y:i32 = 1 <= 2
chain:i32 = 1 < 2 < 3
```

All comparison operators return i32 (0/1). Comparison chaining supported (`a < b < c`).

```ohm
CompareExpr = AddExpr (compareOp AddExpr)*
compareOp = lessEqual | greaterEqual | lessThan | greaterThan | equalEqual | bangEqual
```

---

### 11. Bitwise and Shift Operators

```tinywhale
a:i32 = 5 & 3
b:i32 = 5 | 3
c:i32 = 5 ^ 3
d:i32 = ~5
e:i32 = 1 << 4
f:i32 = 16 >> 2
g:i32 = -1 >>> 1
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
x:i32 = 1 && 0
y:i32 = 0 || 1
```

Short-circuit logical AND and OR. Return i32.

```ohm
LogicalOrExpr = LogicalAndExpr (pipePipe LogicalAndExpr)*
LogicalAndExpr = BitwiseOrExpr (ampAmp BitwiseOrExpr)*
```

---

### 13. Match with Literal Patterns

```tinywhale
x:i32 = 5
result:i32 = match x
    0 -> 100
    1 -> 200
    _ -> 0
```

Match expressions with integer literal patterns and wildcard. Exhaustiveness checking requires catch-all.

```ohm
MatchBinding = identifier TypeAnnotation equals MatchExpr
MatchExpr = matchKeyword Expression
MatchArm = Pattern arrow Expression
LiteralPattern = minus? intLiteral
WildcardPattern = underscore
```

---

### 14. Match with Or-Patterns

```tinywhale
x:i32 = 2
result:i32 = match x
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
x:i32 = 1
match x
    0 -> panic
    _ -> panic
```

Match expression without binding result - for branching with side effects.

```ohm
Statement = TypeDecl | MatchBinding | MatchExpr | PrimitiveBinding | RecordBinding | PanicStatement
```

---

### 16. Binding Patterns in Match

```tinywhale
x:i32 = 5
result:i32 = match x
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
x:i32 = 42 # inline comment
```

Hash-delimited or to end-of-line comments. Stripped during tokenization.

```ohm
comment = "#" (~("#" | "\n" | "\r" | anyDedent) any)* ("#" | &"\n" | &"\r" | &anyDedent | end)
```

---

### 18. Underscore-Prefixed Identifiers

```tinywhale
_unused:i32 = 42
```

Allowed for documentation purposes (marking unused variables). Compiler will warn but not error.

```ohm
identifier = ~keyword letter (alnum | "_")*
```

---

### 19. Empty Lists Disallowed

```tinywhale
# This correctly fails to parse:
# arr:i32[]<size=0> = []
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

## Discrepancies

### D1. Nested Lists

**Desired:**
```tinywhale
matrix:i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
x:i32 = matrix[0][1]
```
Should create 2D list and access nested elements.

**Actual:**
```tinywhale
matrix:i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
# Error: TWCHECK012 - type mismatch (expected i32, found list literal)
```
Grammar parses nested list types and literals, but checker doesn't support them.

```ohm
ListType = ListTypeBase ListTypeSuffix+
ListTypeSuffix = lbracket rbracket TypeHints
```

**Discrepancy:** Grammar allows `ListTypeSuffix+` (one or more), but checker only handles single level.

---

### D2. Chained Index Access

**Desired:**
```tinywhale
matrix:i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]
x:i32 = matrix[0][1]
```
Should access element at row 0, column 1.

**Actual:**
```tinywhale
arr:i32[]<size=3> = [1, 2, 3]
x:i32 = arr[0][0]
# Error: TWCHECK031 - cannot index into i32 result
```
Grammar allows multiple index suffixes, but checker fails because first index returns primitive.

```ohm
IndexAccess = PostfixBase (lbracket intLiteral rbracket)+
```

**Discrepancy:** Grammar allows `(lbracket intLiteral rbracket)+`, but checker doesn't validate chained index types.

---

### D3. List Destructuring Patterns (Missing)

**Desired:**
```tinywhale
arr:i32[]<size=3> = [1, 2, 3]
result:i32 = match arr
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
type Point
    x: i32
    y: i32
p:Point =
    x: 10
    y: 20
result:i32 = match p
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
x:i32 = 5
result:i32 = match x
    n on n > 0 -> n
    _ -> 0
```
Should allow `on` guard for additional conditions.

**Also designed:**
```tinywhale
expected:i32 = 5
result:i32 = match x
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
x:f32 = -1.5
```
Should parse `-1.5` as single float literal token.

**Actual:**
```tinywhale
x:f32 = -1.5
# Parses as UnaryExpr(minus, 1.5), not as single literal
```
Works but tokenization is suboptimal.

```ohm
floatLiteral = digit+ "." digit+ (("e" | "E") ("+" | "-")? digit+)?
```

**Discrepancy:** Grammar lacks optional leading minus for float literals. Should be `minus? digit+ ...`.

---

### D7. Refinement Types in Field Declarations

**Desired:**
```tinywhale
type Point
    x: i32<min=0, max=100>
    y: i32<min=0, max=100>
```
Should allow refinement types on record fields, with constraints enforced during initialization.

**Actual:**
```tinywhale
type Point
    x: i32<min=0>
    y: i32
p:Point =
    x: -5   # Should fail min=0, but passes
    y: 10
```
Parses correctly but constraints are silently ignored.

**Root cause:** `processFieldDecl` (`declarations.ts:196`) uses hardcoded `+2` token offset assuming `Identifier, Colon, TypeKeyword`. For refinement types like `i32<min=0>`, the type token is not at offset +2.

```ohm
FieldDecl = lowerIdentifier colon TypeRef
TypeRef = ListType | RefinementType | upperIdentifier | typeKeyword
```

**Fix required:** Parse the TypeAnnotation node properly instead of using token offset arithmetic. Should traverse child nodes to find the type information.

---

### D8. List Field Initialization in Records

**Desired:**
```tinywhale
type Data
    items: i32[]<size=3>
d:Data =
    items: [1, 2, 3]
```
Should initialize list field in record.

**Actual:**
```tinywhale
type Data
    items: i32[]<size=3>
d:Data =
    items: [1, 2, 3]
# Error: TWCHECK012 - type mismatch
```
List field declaration works, but initialization fails.

```ohm
FieldInit = lowerIdentifier colon FieldValue
FieldValue = NestedRecordInit | Expression
```

**Discrepancy:** `Expression` in `FieldValue` includes `ListLiteral`, but checker doesn't handle list field initialization.

---

### D9. Lists of User-Defined Types (Blocked on Functions)

**Desired:**
```tinywhale
type Point
    x: i32
    y: i32
p1:Point =
    x: 1
    y: 2
p2:Point =
    x: 3
    y: 4
vertices:Point[]<size=2> = [p1, p2]
```
Should allow lists with record element types, initialized via variable references.

**Actual:** Grammar and type resolution work correctly. But records are currently flattened to local fields (`p1_x`, `p1_y`) - no symbol exists for `p1` itself.

**Not a bug - architectural decision:** Records are flattened unless passed around. When functions are implemented, records passed to functions will use WASM structs, and whole-record references will work.

**Status:** Deferred until functions feature (F5).

---

### D10. Float Match Patterns

**Desired:**
```tinywhale
x:f32 = 1.5
result:i32 = match x
    1.5 -> 100
    _ -> 0
```
Should match on float literal patterns.

**Actual:**
```tinywhale
# LiteralPattern only allows intLiteral
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
arr:i32[]<size=3> = [1, 2, 3]
i:i32 = 1
x:i32 = arr[i]
```
Currently only integer literal indices for exhaustiveness checking. Variable indices planned with functions and bounds checking.

```ohm
IndexAccess = PostfixBase (lbracket intLiteral rbracket)+
```

### F3. Floats (Comprehensive)
Float implementation is incomplete. Includes:
- Float match patterns
- Negative float literals
- Numeric formats (hex, binary, octal)
- Float-specific operations

Worth multiple PRs.

### F4. Multi-line Lists / Trailing Commas
```tinywhale
# Undecided syntax - possibly comma-less:
arr:i32[]<size=3> = [
    1
    2
    3
]
# Or with spaces: [1 2 3]
```
Open design question. Not adding trailing comma support until decided.

### F5. Functions
Not yet implemented. Will unlock:
- Variable index access with bounds checking
- Side-effect operations in match arms
- General-purpose computation

---

## Summary

| Category | Count |
|----------|-------|
| Working correctly | 20 |
| Discrepancies | 10 |
| Future enhancements | 5 |

**Fixes completed (PRs #47 and #48):**
- Dead VariableBinding grammar rule removed
- Postfix base restricted to identifiers only (no parens, literals, or list literals)
- Integer scientific notation negative exponents rejected at grammar level
- Binding patterns in match now work with lexical scoping

**Remaining discrepancies for fuzzing preparation:**
1. D1-D2 (nested lists, chained index) - need checker implementation
2. D3-D5 (list/record destructuring, guards) - missing grammar + checker
3. D6 (negative float literals) - grammar addition
4. D7 (refinement types in fields) - checker fix for type resolution
5. D8 (list fields in records) - checker fix
6. D9 (lists of user-defined types) - deferred until functions
7. D10 (float match patterns) - grammar + checker

**Terminology:** "Hinted Primitives" → "Refinement Types" (D7 fix includes rename)
