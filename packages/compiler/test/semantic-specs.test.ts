import assert from 'node:assert'
import { test } from 'node:test'
import { compile } from '../src/index.ts'

// =============================================================================
// SEMANTIC SPECS - End-to-End Compiler Tests
// =============================================================================
//
// These tests verify that source code compiles through the ENTIRE pipeline:
//   tokenizer → parser → checker → codegen → valid WASM
//
// Companion to grammar-specs.test.ts which only tests syntax acceptance.
// Use these tests to document what actually works vs what's grammar-only.
//
// Expectation types:
//   'valid'       - Compiles to valid WASM binary
//   'check-error' - Parses but fails type checking (TWCHECK* errors)
//   'parse-error' - Fails at parsing stage
//
// =============================================================================

type Expectation = 'valid' | 'check-error' | 'parse-error'

interface TestCase {
	input: string
	expect: Expectation
	description?: string
	errorCode?: string // Expected error code prefix, e.g., 'TWCHECK012'
}

function runSemanticTest(tc: TestCase): { message: string; passed: boolean } {
	const source = tc.input.includes('panic') ? tc.input : `${tc.input}\npanic`

	try {
		const result = compile(source)

		if (tc.expect === 'valid') {
			if (result.valid) {
				return { message: 'Compiled to valid WASM', passed: true }
			}
			return { message: 'Compilation returned but result.valid is false', passed: false }
		}

		return { message: `Expected ${tc.expect} but compilation succeeded`, passed: false }
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error)

		if (tc.expect === 'valid') {
			return { message: `Expected valid but threw: ${errMsg.slice(0, 150)}`, passed: false }
		}

		if (tc.expect === 'check-error') {
			if (!errMsg.includes('TWCHECK')) {
				return { message: `Expected TWCHECK error but got: ${errMsg.slice(0, 100)}`, passed: false }
			}
			if (tc.errorCode && !errMsg.includes(tc.errorCode)) {
				return {
					message: `Expected ${tc.errorCode} but got: ${errMsg.slice(0, 100)}`,
					passed: false,
				}
			}
			return { message: 'Got expected check error', passed: true }
		}

		if (tc.expect === 'parse-error') {
			if (errMsg.includes('TWPARSE') || !errMsg.includes('TWCHECK')) {
				return { message: 'Got expected parse error', passed: true }
			}
			return { message: `Expected parse error but got: ${errMsg.slice(0, 100)}`, passed: false }
		}

		return { message: `Unexpected error: ${errMsg.slice(0, 200)}`, passed: false }
	}
}

function semanticTests(tests: TestCase[]) {
	return async (t: { test: (name: string, fn: () => void) => Promise<void> }) => {
		for (const tc of tests) {
			const testName = tc.description || tc.input.slice(0, 50).replace(/\n/g, '\\n')
			await t.test(`${tc.expect}: ${testName}`, () => {
				const result = runSemanticTest(tc)
				assert.ok(result.passed, result.message)
			})
		}
	}
}

test('Semantic Specs', async (t) => {
	await t.test(
		'Basic Statements',
		semanticTests([
			{ description: 'panic statement', expect: 'valid', input: 'panic' },
			{ description: 'multiple panic statements', expect: 'valid', input: 'panic\npanic' },
			{ description: 'i32 binding', expect: 'valid', input: 'x:i32 = 1' },
			{ description: 'i64 binding', expect: 'valid', input: 'x:i64 = 123' },
			{ description: 'f32 binding', expect: 'valid', input: 'x:f32 = 1.5' },
			{ description: 'f64 binding', expect: 'valid', input: 'x:f64 = 2.5' },
			{ description: 'arithmetic expression', expect: 'valid', input: 'x:i32 = 1 + 2' },
		])
	)

	await t.test(
		'Type Hints',
		semanticTests([
			{ description: 'min constraint satisfied', expect: 'valid', input: 'x:i32<min=0> = 5' },
			{ description: 'max constraint satisfied', expect: 'valid', input: 'x:i32<max=100> = 50' },
			{
				description: 'both constraints satisfied',
				expect: 'valid',
				input: 'x:i32<min=0, max=100> = 50',
			},
			{
				description: 'min constraint violated',
				errorCode: 'TWCHECK041',
				expect: 'check-error',
				input: 'x:i32<min=0> = -1',
			},
			{
				description: 'max constraint violated',
				errorCode: 'TWCHECK041',
				expect: 'check-error',
				input: 'x:i32<max=100> = 101',
			},
		])
	)

	await t.test(
		'Record Types',
		semanticTests([
			{
				description: 'simple record with fields',
				expect: 'valid',
				input: 'type Point\n\tx: i32\n\ty: i32\np:Point =\n\tx: 1\n\ty: 2',
			},
			{
				description: 'unknown field in initializer',
				expect: 'check-error',
				input: 'type Point\n\tx: i32\np:Point =\n\tx: 1\n\ty: 2',
			},
			{
				description: 'missing field in initializer',
				expect: 'check-error',
				input: 'type Point\n\tx: i32\n\ty: i32\np:Point =\n\tx: 1',
			},
		])
	)

	await t.test(
		'Single-Level Lists',
		semanticTests([
			{ description: 'i32 list literal', expect: 'valid', input: 'arr:i32[]<size=3> = [1, 2, 3]' },
			{ description: 'i64 list literal', expect: 'valid', input: 'arr:i64[]<size=2> = [1, 2]' },
			{ description: 'f32 list literal', expect: 'valid', input: 'arr:f32[]<size=2> = [1.0, 2.0]' },
			{ description: 'f64 list literal', expect: 'valid', input: 'arr:f64[]<size=2> = [1.0, 2.0]' },
			{
				description: 'single index access',
				expect: 'valid',
				input: 'arr:i32[]<size=3> = [1, 2, 3]\nx:i32 = arr[0]',
			},
			{
				description: 'index access last element',
				expect: 'valid',
				input: 'arr:i32[]<size=3> = [1, 2, 3]\nx:i32 = arr[2]',
			},
		])
	)

	// =========================================================================
	// GRAMMAR-ONLY CONSTRUCTS - Document what parses but doesn't compile
	// =========================================================================

	await t.test(
		'Nested Lists (Grammar-Only)',
		semanticTests([
			{
				description: 'nested list literal not supported - expected i32, found list literal',
				errorCode: 'TWCHECK012',
				expect: 'check-error',
				input: 'matrix:i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]',
			},
		])
	)

	await t.test(
		'Chained Index Access (Grammar-Only)',
		semanticTests([
			{
				description: 'chained index on flat list - cannot index into i32 result',
				errorCode: 'TWCHECK031',
				expect: 'check-error',
				input: 'arr:i32[]<size=3> = [1, 2, 3]\nx:i32 = arr[0][0]',
			},
		])
	)

	await t.test(
		'Field Access',
		semanticTests([
			{
				description: 'simple field access',
				expect: 'valid',
				input: 'type Point\n\tx: i32\n\ty: i32\np:Point =\n\tx: 1\n\ty: 2\nv:i32 = p.x',
			},
			{
				description: 'nested field access',
				expect: 'valid',
				input:
					'type Inner\n\tval: i32\ntype Outer\n\tinner: Inner\no:Outer =\n\tinner: Inner\n\t\tval: 42\nv:i32 = o.inner.val',
			},
		])
	)

	await t.test(
		'Match Expressions',
		semanticTests([
			{
				description: 'match with literal and wildcard patterns',
				expect: 'valid',
				input: 'x:i32 = 1\nresult:i32 = match x\n\t0 -> 100\n\t1 -> 200\n\t_ -> 0',
			},
			{
				description: 'match with or-pattern',
				expect: 'valid',
				input: 'x:i32 = 1\nresult:i32 = match x\n\t0 | 1 | 2 -> 100\n\t_ -> 0',
			},
			// [GRAMMAR] Binding patterns parse but pattern variable not bound to scope
			{
				description: 'binding pattern variable not in scope (not implemented)',
				errorCode: 'TWCHECK013',
				expect: 'check-error',
				input: 'x:i32 = 5\nresult:i32 = match x\n\t0 -> 100\n\tother -> other',
			},
		])
	)

	await t.test(
		'Type Mismatches',
		semanticTests([
			{
				description: 'i32 to i64 assignment',
				errorCode: 'TWCHECK012',
				expect: 'check-error',
				input: 'x:i32 = 1\ny:i64 = x',
			},
			{
				description: 'f32 to f64 assignment',
				errorCode: 'TWCHECK012',
				expect: 'check-error',
				input: 'x:f32 = 1.0\ny:f64 = x',
			},
			{
				description: 'float literal to i32',
				errorCode: 'TWCHECK016',
				expect: 'check-error',
				input: 'x:i32 = 1.5',
			},
			{
				description: 'int literal to f32',
				errorCode: 'TWCHECK016',
				expect: 'check-error',
				input: 'x:f32 = 1',
			},
		])
	)

	await t.test(
		'Undefined Variables',
		semanticTests([
			{
				description: 'reference to undefined variable',
				errorCode: 'TWCHECK013',
				expect: 'check-error',
				input: 'x:i32 = y',
			},
			{
				description: 'undefined in expression',
				errorCode: 'TWCHECK013',
				expect: 'check-error',
				input: 'x:i32 = 1 + y',
			},
		])
	)
})
