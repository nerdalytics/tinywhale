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
})
