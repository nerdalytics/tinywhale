import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createTester } from '@tinywhale/grammar-test'
import * as ohm from 'ohm-js'
import { CompilationContext } from '../src/core/context.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { tokensToOhmInput } from '../src/parse/parser.ts'

// Resolve path relative to this test file
const DIRNAME = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname)
const GRAMMAR_PATH = path.resolve(DIRNAME, '../src/parse/tinywhale.ohm')

function prepare(input: string): string {
	const ctx = new CompilationContext(input)
	tokenize(ctx)
	// If tokenization failed, the grammar test should probably fail or we rely on what tokens were produced.
	// But usually we want to test valid token streams against the grammar.
	// If the tokenizer fails, the output might be incomplete, but let's pass it through.
	const output = tokensToOhmInput(ctx)
	return output
}

function prepareList(inputs: string[]): string[] {
	return inputs.map(prepare)
}

test('Grammar Specs', async (t) => {
	// 1. Ensure grammar file exists and load it
	assert.ok(fs.existsSync(GRAMMAR_PATH), `Grammar file not found at ${GRAMMAR_PATH}`)
	const source = fs.readFileSync(GRAMMAR_PATH, 'utf-8')
	const grammar = ohm.grammar(source)

	// 2. Define Tests
	await t.test('Basic Statements', (t) => {
		const tester = createTester(grammar, 'Basic Statements', 'Program')

		tester.match(
			prepareList([
				'panic',
				'panic\n',
				'panic\npanic',
				'# comment',
				'panic # comment',
				'x:i32 = 1',
				'x:i32 = 1 + 2',
				'type Point\n\tx: i32', // Single field
				'type Point\n\tx: i32\n\ty: i32',
			])
		)

		tester.reject(
			prepareList([
				'panic panic', // Multiple statements on same line forbidden
				'panic : i32', // Panic doesn't take type annotation
				'type : i32', // Keyword as identifier
			])
		)

		const result = tester.run()

		// Report results
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					if (r.trace) t.diagnostic(r.trace)
					// Show what the prepared input looked like
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		} else {
			assert.strictEqual(result.failed, 0)
		}
	})

	await t.test('Primitive vs Record Bindings', (t) => {
		const tester = createTester(grammar, 'Primitive vs Record Bindings', 'Program')

		tester.match(
			prepareList([
				'x:i32 = 5',
				'x:i64 = 123',
				'x:f32 = 1.5',
				'x:f64 = 2.5',
				'x:i32<min=0> = 5',
				'x:i32<min=0, max=100> = 50',
				'arr:i32[]<size=3> = [1, 2, 3]',
				'p:Point =', // Record binding - no expression, block follows
			])
		)

		tester.reject(
			prepareList([
				'x:i32 =', // Missing expression for primitive
				'x:i64 =', // Missing expression for primitive
				'x:f32 =', // Missing expression for primitive
				'x:f64 =', // Missing expression for primitive
				'x:i32<min=0> =', // Missing expression for hinted primitive
				'arr:i32[]<size=3> =', // Missing expression for list type
				'p:Point = 5', // Expression not allowed for record
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Variable Bindings', (t) => {
		const tester = createTester(grammar, 'Variable Bindings', 'VariableBinding')

		// For rule-specific tests (startRule != Program), we need to be careful.
		// VariableBinding = identifier TypeAnnotation equals Expression?
		// Note: 'Expression?' includes the equals? No.
		// VariableBinding = identifier TypeAnnotation equals Expression?
		// Wait, look at grammar:
		// VariableBinding = identifier TypeAnnotation equals Expression?
		// So 'x:i32 =' is valid? Expression is optional?
		// Grammar says: VariableBinding = identifier TypeAnnotation equals Expression?
		// So 'x:i32 =' matches if Expression is optional.
		// Check grammar:
		// VariableBinding = identifier TypeAnnotation equals Expression?

		tester.match(prepareList(['x:i32 = 1', 'x: i32 = 1', 'veryLongVariableName: i64 = 1234567890']))

		tester.reject(
			prepareList([
				'x = 1', // Missing type annotation
				// 'x:i32 =' might actually be valid if Expression is optional!
				// Let's check if Expression? allows empty.
				// If it's valid, I should move it to match.
				':i32 = 1', // Missing identifier
				'x:i32 1', // Missing equals
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Type Declarations', (t) => {
		const tester = createTester(grammar, 'Type Declarations', 'TypeDecl')

		tester.match(prepareList(['type Point', 'type MyType']))

		tester.reject(
			prepareList([
				'type lowerCase', // Must be upper
				'type', // Missing name
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Match Expressions', (t) => {
		const tester = createTester(grammar, 'Match Expressions', 'Program')

		tester.match(
			prepareList([
				// Basic match with literal patterns
				'result: i32 = match x\n\t0 -> 100\n\t1 -> 200',
				// Match with wildcard pattern
				'result: i32 = match x\n\t0 -> 100\n\t_ -> 0',
				// Match with binding pattern
				'result: i32 = match x\n\t0 -> 100\n\tother -> other',
				// Match with negative literal
				'result: i32 = match x\n\t-1 -> 100\n\t0 -> 0',
				// Match with or-pattern
				'result: i32 = match x\n\t0 | 1 | 2 -> 100\n\t_ -> 0',
				// Match with expression body
				'result: i32 = match x\n\t0 -> 1 + 2\n\t_ -> 0',
				// Standalone match (discarded result)
				'match x\n\t0 -> 100\n\t_ -> 0',
				// Multiple match expressions
				'a: i32 = match x\n\t0 -> 1\n\t_ -> 0\nb: i32 = match y\n\t1 -> 2\n\t_ -> 0',
			])
		)

		tester.reject(
			prepareList([
				'match', // Missing scrutinee
				'result: i32 = match', // Missing scrutinee in binding
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Expressions', (t) => {
		const tester = createTester(grammar, 'Expressions', 'Program')

		tester.match(
			prepareList([
				// Arithmetic
				'x:i32 = 1 + 2',
				'x:i32 = 1 - 2',
				'x:i32 = 1 * 2',
				'x:i32 = 1 / 2',
				'x:i32 = 10 % 3',
				'x:i32 = 10 %% 3', // Euclidean modulo
				// Unary
				'x:i32 = -1',
				'x:i32 = ~1', // Bitwise NOT
				'x:i32 = --1', // Double negative
				'x:i32 = ~~1', // Double bitwise NOT
				// Comparison
				'x:i32 = 1 < 2',
				'x:i32 = 1 > 2',
				'x:i32 = 1 <= 2',
				'x:i32 = 1 >= 2',
				'x:i32 = 1 == 2',
				'x:i32 = 1 != 2',
				// Comparison chaining
				'x:i32 = 1 < 2 < 3',
				'x:i32 = 1 <= 2 < 3 <= 4',
				// Bitwise
				'x:i32 = 1 & 2',
				'x:i32 = 1 | 2',
				'x:i32 = 1 ^ 2',
				// Shift
				'x:i32 = 1 << 2',
				'x:i32 = 8 >> 2',
				'x:i32 = 8 >>> 2', // Unsigned right shift
				// Logical
				'x:i32 = 1 && 2',
				'x:i32 = 1 || 2',
				// Parentheses
				'x:i32 = (1 + 2)',
				'x:i32 = (1 + 2) * 3',
				'x:i32 = ((1 + 2) * (3 + 4))',
				// Complex precedence
				'x:i32 = 1 + 2 * 3', // mul before add
				'x:i32 = 1 | 2 & 3', // and before or
				'x:i32 = 1 || 2 && 3', // and before or
				'x:i32 = -1 * 2', // unary before mul
				// Variables in expressions
				'x:i32 = 1\ny:i32 = x + 1',
				'x:i32 = 1\ny:i32 = x * x',
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('List Types and Literals', (t) => {
		const tester = createTester(grammar, 'List Types and Literals', 'Program')

		tester.match(
			prepareList([
				// List type with size hint
				'arr:i32[]<size=4> = [1, 2, 3, 4]',
				'arr:i64[]<size=2> = [1, 2]',
				'arr:f32[]<size=2> = [1.0, 2.0]',
				'arr:f64[]<size=2> = [1.0, 2.0]',
				// Nested list type
				'matrix:i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]',
				// Single element list
				'arr:i32[]<size=1> = [42]',
				// List with expression elements
				'arr:i32[]<size=2> = [1 + 2, 3 * 4]',
			])
		)

		tester.reject(
			prepareList([
				'arr:i32[] = [1, 2]', // Missing size hint
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Field and Index Access', (t) => {
		const tester = createTester(grammar, 'Field and Index Access', 'Program')

		tester.match(
			prepareList([
				// Field access
				'x:i32 = point.x',
				'x:i32 = point.x + point.y',
				// Chained field access
				'x:i32 = outer.inner.value',
				// Index access
				'x:i32 = arr[0]',
				'x:i32 = arr[99]',
				// Chained index access
				'x:i32 = matrix[0][1]',
				'x:i32 = cube[0][1][2]',
				// Field then index (FieldAccess is in PostfixBase for IndexAccess)
				'x:i32 = data.items[0]',
				// Note: arr[0].field is NOT supported - IndexAccess cannot be followed by FieldAccess
				// This is a grammar limitation: IndexAccess = PostfixBase (lbracket...), FieldAccess = PrimaryExprBase (dot...)
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Record Initialization', (t) => {
		const tester = createTester(grammar, 'Record Initialization', 'Program')

		tester.match(
			prepareList([
				// Simple record with fields
				'type Point\n\tx: i32\n\ty: i32\np:Point =\n\tx: 1\n\ty: 2',
				// Record with list field
				'type Foo\n\titems: i32[]<size=3>\nf:Foo =\n\titems: [1, 2, 3]',
				// Nested record initialization
				'type Inner\n\tvalue: i32\ntype Outer\n\tinner: Inner\no:Outer =\n\tinner: Inner\n\t\tvalue: 42',
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Comments', (t) => {
		const tester = createTester(grammar, 'Comments', 'Program')

		// Note: Comments are stripped during tokenization, so comment-only lines
		// become empty lines. The grammar accepts empty programs and inline comments.
		tester.match(
			prepareList([
				'# single line comment', // Becomes empty, valid empty program
				'panic # inline comment', // Inline comment stripped, panic remains
				'x:i32 = 1 # inline after expression', // Comment stripped, binding remains
				'#no space after hash#', // Valid comment syntax
				'# comment with special chars: @$%^&*()', // Valid (note: # inside comment ends it)
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})

	await t.test('Identifiers', (t) => {
		const tester = createTester(grammar, 'Identifiers', 'Program')

		tester.match(
			prepareList([
				// Keyword prefixes (should be valid identifiers)
				'panicMode:i32 = 1',
				'i32value:i32 = 42',
				'matchmaking:i32 = 1',
				'f64data:f64 = 1.0',
				'typeOf:i32 = 1',
				// Keyword suffixes
				'mypanic:i32 = 0',
				'notype:i32 = 1',
				// Containing keywords
				'dontpanicky:i32 = 1',
				// Case variations
				'CONSTANT:i32 = 42',
				'myVariable:i32 = 1',
				'Panic:i32 = 1', // Capital P - not keyword
				'I32:i32 = 1', // Capital I - not keyword
				'MATCH:i32 = 1',
				// With underscores
				'foo_bar_baz:i32 = 1',
				'x1y2z3:i32 = 1',
				// Single letter
				'x:i32 = 1',
				'a:i32 = 1',
			])
		)

		tester.reject(
			prepareList([
				'_private:i32 = 1', // Underscore prefix not allowed
				'__init__:i32 = 1', // Dunder not allowed
			])
		)

		const result = tester.run()
		if (result.failed > 0) {
			for (const r of result.results) {
				if (!r.passed) {
					t.diagnostic(`[FAILED] ${r.expected} '${r.input}': ${r.errorMessage}`)
					t.diagnostic(`Prepared Input: ${JSON.stringify(r.input)}`)
				}
			}
			assert.fail(`Failed ${result.failed} grammar tests`)
		}
	})
})
