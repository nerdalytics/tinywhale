# Adding a New Keyword to TinyWhale

This guide documents the 6 touchpoints required to add a new keyword to the compiler.

## Verification

The `panic` keyword follows this pattern exactly:

| Step | Guide Pattern | `panic` Implementation |
|------|---------------|------------------------|
| 1. TokenKind | `Todo: 11` | `tokens.ts:25` - `Panic: 10` |
| 2a. Detection | `findTodoKeyword()` | `tokenizer.ts:165` - `findPanicKeyword()` |
| 2b. Emit | `tokens.add()` in `processLine()` | `tokenizer.ts:261` |
| 2c. Bridge | `tokensToOhmInput()` case | `parser.ts:80` |
| 3. NodeKind | `TodoStatement: 11` | `nodes.ts:19` - `PanicStatement: 10` |
| 4a. Grammar | `Statement = ... \| TodoStatement` | `parser.ts:34` |
| 4b. Semantic | `emitStatement` action | `parser.ts:169` |
| 5. Codegen | `collectExpressions()` case | `codegen/index.ts:50` |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/core/tokens.ts` | Add `TokenKind.Xyz` |
| `src/lex/tokenizer.ts` | Add keyword detection |
| `src/core/nodes.ts` | Add `NodeKind.XyzStatement` |
| `src/parse/parser.ts` | Add grammar rule + semantic action |
| `src/codegen/index.ts` | Add WASM emission |
| `test/` | Add tests for each phase |

---

## Step 1: TokenKind (core/tokens.ts)

Add to keyword category (10-99):

```typescript
export const TokenKind = {
  // ... structural tokens (0-9)
  Panic: 10,
  Todo: 11,  // ← ADD new keyword here
  // ...
} as const
```

---

## Step 2: Tokenizer (lex/tokenizer.ts)

### 2a. Add detection function

```typescript
function findTodoKeyword(content: string): number {
  let pos = 0
  while (pos < content.length && (content[pos] === ' ' || content[pos] === '\t')) {
    pos++
  }
  if (content[pos] === '#') return 0  // Skip comments
  if (content.startsWith('todo', pos)) {
    const afterKeyword = pos + 4
    // Word boundary check
    if (afterKeyword >= content.length || !/[a-zA-Z0-9_]/.test(content[afterKeyword]!)) {
      return pos + 1  // 1-indexed column
    }
  }
  return 0
}
```

### 2b. Emit token in processLine()

```typescript
const todoCol = findTodoKeyword(strippedContent)
if (todoCol > 0) {
  context.tokens.add({
    column: indentCount + todoCol,
    kind: TokenKind.Todo,
    line: lineNumber,
    payload: 0,
  })
}
```

### 2c. Update tokensToOhmInput() in parser.ts

```typescript
case TokenKind.Todo:
  parts.push('todo')
  break
```

---

## Step 3: NodeKind (core/nodes.ts)

Add to statement category (10-99):

```typescript
export const NodeKind = {
  // ... line types (0-9)
  PanicStatement: 10,
  TodoStatement: 11,  // ← ADD new statement here
  // ...
} as const
```

---

## Step 4: Grammar & Semantics (parse/parser.ts)

### 4a. Update grammar

```diff
  // Statements
- Statement = PanicStatement
+ Statement = PanicStatement | TodoStatement
  PanicStatement = panic
+ TodoStatement = todo

  // Keywords
- keyword = panic
+ keyword = panic | todo
  panic = "panic" ~identifierPart
+ todo = "todo" ~identifierPart
```

### 4b. Add semantic action

```typescript
semantics.addOperation<NodeId>('emitStatement', {
  // ... existing actions
  TodoStatement(_keyword: Node): NodeId {
    const lineNumber = getLineNumber(this)
    const tid = getTokenIdForLine(lineNumber)
    return context.nodes.add({
      kind: NodeKind.TodoStatement,
      subtreeSize: 1,
      tokenId: tid,
    })
  },
})
```

---

## Step 5: Code Generation (codegen/index.ts)

Add case in `collectExpressions()`:

```typescript
case NodeKind.TodoStatement:
  expressions.push(mod.unreachable())
  break
```

---

## Step 6: Tests

### Tokenizer (test/lex/tokenizer.test.ts)

```typescript
it('should tokenize todo keyword', () => {
  const ctx = new CompilationContext('todo')
  tokenize(ctx)
  const tokens = [...ctx.tokens]
  assert.strictEqual(tokens[0]![1].kind, TokenKind.Todo)
})

it('should not tokenize todoList as todo', () => {
  const ctx = new CompilationContext('todoList')
  tokenize(ctx)
  for (const [, token] of ctx.tokens) {
    assert.notStrictEqual(token.kind, TokenKind.Todo)
  }
})
```

### Parser (test/parse/parser.test.ts)

```typescript
it('should parse todo statement', () => {
  const ctx = new CompilationContext('todo')
  tokenize(ctx)
  parse(ctx)
  let found = false
  for (const [, node] of ctx.nodes) {
    if (node.kind === NodeKind.TodoStatement) found = true
  }
  assert.strictEqual(found, true)
})
```

### Codegen (test/codegen.test.ts)

```typescript
it('should compile todo to unreachable', () => {
  const result = compileSource('todo\n')
  assert.strictEqual(result.valid, true)
  assert.ok(result.text.includes('unreachable'))
})
```

### Integration (test/compile.test.ts)

```typescript
it('should compile todo keyword', () => {
  const result = compile('todo')
  assert.strictEqual(result.valid, true)
})
```

---

## Architecture Notes

**Why 6 touchpoints?**

1. **TokenKind** - Lexical identity (what token is this?)
2. **Tokenizer** - Recognition (find it in source text)
3. **NodeKind** - AST identity (what statement is this?)
4. **Grammar** - Syntactic structure (how does it parse?)
5. **Semantic action** - AST construction (create the node)
6. **Codegen** - Semantics (what does it mean in WASM?)

**Postorder invariant:** Semantic actions emit child nodes before parents. For simple statements, `subtreeSize` is 1 (leaf node).

**Word boundary:** All keywords use `~identifierPart` in grammar and `/[a-zA-Z0-9_]/` check in tokenizer to prevent `todoList` matching as `todo`.
