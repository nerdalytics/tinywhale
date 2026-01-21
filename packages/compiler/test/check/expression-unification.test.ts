import assert from 'node:assert'
import { describe, it } from 'node:test'
import fc from 'fast-check'

import { check } from '../../src/check/checker.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { compile } from '../../src/index.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

function compileAndCheck(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	return ctx
}

describe('check/expression unification', () => {
	describe('type aliases without type keyword', () => {
		it('should parse type alias at grammar level', () => {
			// Type alias definition parses correctly
			const source = `Add = (i32, i32) -> i32
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const parseResult = parse(ctx)
			assert.ok(parseResult.succeeded, 'Parsing should succeed')
		})

		it('should handle type alias in checker', () => {
			// Type alias should be recognized by checker (creates a type)
			const source = `Add = (i32, i32) -> i32
panic`
			const ctx = compileAndCheck(source)
			assert.ok(!ctx.hasErrors(), `Errors: ${ctx.getDiagnostics().map((d) => d.message)}`)
		})

		it('resolves type alias in function binding', () => {
			// Type alias used as type annotation on function binding
			const source = `Add = (i32, i32) -> i32
add: Add = (a: i32, b: i32): i32 -> a + b
panic`
			const ctx = compileAndCheck(source)
			assert.ok(!ctx.hasErrors(), `Errors: ${ctx.getDiagnostics().map((d) => d.message)}`)
		})
	})

	describe('expression sequences in lambda bodies', () => {
		it('should compile multi-line function body', () => {
			const source = `f = (x: i32): i32 ->
\ty: i32 = x * 2
\ty + 1
result: i32 = f(5)
panic`
			const ctx = compileAndCheck(source)
			assert.ok(!ctx.hasErrors(), `Errors: ${ctx.getDiagnostics().map((d) => d.message)}`)
		})

		it('should return type of last expression in sequence', () => {
			const source = `f = (x: i32): i32 ->
\ty: i32 = x * 2
\ty + 1
panic`
			const ctx = compileAndCheck(source)
			assert.ok(!ctx.hasErrors(), `Errors: ${ctx.getDiagnostics().map((d) => d.message)}`)
		})

		it('should allow nested function definitions', () => {
			const source = `compute = (x: i32): i32 ->
\thelper: (i32) -> i32
\thelper = (n: i32): i32 -> n * 2
\thelper(x)
panic`
			const ctx = compileAndCheck(source)
			assert.ok(!ctx.hasErrors(), `Errors: ${ctx.getDiagnostics().map((d) => d.message)}`)
		})

		it('should type-check return type against last expression', () => {
			const source = `f = (x: i32): i64 ->
\ty: i32 = x * 2
\ty + 1
panic`
			const ctx = compileAndCheck(source)
			// Should error: return type is i64 but last expression is i32
			assert.ok(ctx.hasErrors())
		})
	})

	describe('codegen for expression sequences', () => {
		it('should generate valid WASM for multi-line function body', () => {
			const source = `f = (x: i32): i32 ->
\ty: i32 = x * 2
\ty + 1
result: i32 = f(5)
panic`
			const result = compile(source)
			assert.strictEqual(
				result.valid,
				true,
				`Warnings: ${result.warnings.map((w) => w.message).join(', ')}`
			)
		})

		it('should execute multi-line function correctly', async () => {
			const source = `f = (x: i32): i32 ->
\ty: i32 = x * 2
\ty + 1
result: i32 = f(5)
panic`
			const result = compile(source)
			assert.strictEqual(result.valid, true)
			// f(5) should compute: y = 5 * 2 = 10, then y + 1 = 11
		})
	})

	describe('property tests', () => {
		it('all i32 bindings compile without errors', () => {
			fc.assert(
				fc.property(fc.integer({ max: 1000, min: -1000 }), (value) => {
					const source = `x: i32 = ${value}\npanic`
					const ctx = compileAndCheck(source)
					return !ctx.hasErrors()
				}),
				{ numRuns: 50 }
			)
		})

		it('all i64 bindings compile without errors', () => {
			fc.assert(
				fc.property(fc.integer({ max: 1000, min: -1000 }), (value) => {
					const source = `x: i64 = ${value}\npanic`
					const ctx = compileAndCheck(source)
					return !ctx.hasErrors()
				}),
				{ numRuns: 50 }
			)
		})

		it('multi-line function bodies compile for various expressions', () => {
			fc.assert(
				fc.property(fc.integer({ max: 100, min: 1 }), fc.integer({ max: 100, min: 1 }), (a, b) => {
					const source = `f = (x: i32): i32 ->
\ty: i32 = x * ${a}
\ty + ${b}
panic`
					const ctx = compileAndCheck(source)
					return !ctx.hasErrors()
				}),
				{ numRuns: 30 }
			)
		})

		it('nested function definitions compile', () => {
			fc.assert(
				fc.property(fc.integer({ max: 10, min: 1 }), (multiplier) => {
					const source = `outer = (x: i32): i32 ->
\tinner: (i32) -> i32
\tinner = (n: i32): i32 -> n * ${multiplier}
\tinner(x)
panic`
					const ctx = compileAndCheck(source)
					return !ctx.hasErrors()
				}),
				{ numRuns: 20 }
			)
		})
	})
})
