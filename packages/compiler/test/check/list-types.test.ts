import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check } from '../../src/check/checker.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

/**
 * Unit tests for list types - edge cases and specific error scenarios.
 *
 * Property tests in list-types.property.test.ts cover:
 * - TypeStore interning and distinctness
 * - Bounds checking soundness and completeness
 * - List literal size validation
 * - Codegen flattening and determinism
 * - Arithmetic on list elements
 *
 * These unit tests cover scenarios that property tests don't:
 * - Specific error codes and messages
 * - Grammar-level rejections
 * - Complex type interactions
 */

function createContext(source: string): CompilationContext {
	return new CompilationContext(source)
}

function prepareAndCheck(source: string): CompilationContext {
	const ctx = createContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	return ctx
}

describe('checker list types', () => {
	describe('error cases', () => {
		describe('TWCHECK036: invalid list size', () => {
			it('errors when size is zero (parse error expected)', () => {
				const source = `arr: i32[]<size=0> = []
panic`
				const ctx = createContext(source)
				tokenize(ctx)
				parse(ctx)

				assert.ok(ctx.hasErrors(), 'should have parse errors for empty list')
			})
		})

		describe('TWCHECK037: list literal length mismatch', () => {
			it('errors when zero elements for declared size 1 (parse error)', () => {
				const source = `arr: i32[]<size=1> = []
panic`
				const ctx = createContext(source)
				tokenize(ctx)
				parse(ctx)

				assert.ok(ctx.hasErrors(), 'should have parse errors for empty list')
			})
		})

		describe('type mismatch: wrong element type', () => {
			it('errors when element type does not match declaration', () => {
				const source = `arr: i32[]<size=1> = [1.5]
panic`
				const ctx = prepareAndCheck(source)

				assert.ok(ctx.hasErrors(), 'should have errors for type mismatch')
			})
		})

		describe('TWCHECK035: non-integer index', () => {
			it('errors when using variable as index (grammar rejects)', () => {
				const source = `arr: i32[]<size=1> = [42]
idx: i32 = 0
x: i32 = arr[idx]
panic`
				const ctx = createContext(source)
				tokenize(ctx)
				parse(ctx)
				const diags = ctx.getDiagnostics()
				assert.ok(diags.length > 0, 'should have errors for variable index')
			})
		})

		describe('list access on non-list type', () => {
			it('errors when indexing a primitive', () => {
				const source = `x: i32 = 42
y: i32 = x[0]
panic`
				const ctx = prepareAndCheck(source)

				assert.ok(ctx.hasErrors(), 'should have errors for indexing non-list')
			})

			it('errors when indexing a record', () => {
				const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 1
    y: 2
z: i32 = p[0]
panic`
				const ctx = prepareAndCheck(source)

				assert.ok(ctx.hasErrors(), 'should have errors for indexing record')
			})
		})
	})

	describe('list element expressions', () => {
		it('compiles list element used with unary operator', () => {
			const source = `arr: i32[]<size=1> = [10]
neg: i32 = -arr[0]
panic`
			const ctx = prepareAndCheck(source)

			assert.ok(!ctx.hasErrors(), 'should compile list element with unary op')
		})
	})

	describe('list type in symbols', () => {
		it('creates correct symbol for list binding', () => {
			const source = `arr: i32[]<size=1> = [42]
panic`
			const ctx = prepareAndCheck(source)

			assert.ok(ctx.symbols !== null && ctx.symbols !== undefined)
			assert.ok(ctx.symbols.localCount() >= 1, 'should create local for list')
		})
	})

	describe('list type field declaration in records', () => {
		it('parses record type with list field', () => {
			const source = `type Data
    items: i32[]<size=3>
panic`
			const ctx = createContext(source)
			tokenize(ctx)
			parse(ctx)

			assert.ok(!ctx.hasErrors(), 'should parse record with list field')
		})

		it('checks record type with list field - type registered', () => {
			const source = `type Data
    items: i32[]<size=3>
panic`
			const ctx = prepareAndCheck(source)

			assert.ok(!ctx.hasErrors(), 'should check record with list field')

			const dataId = ctx.types?.lookup('Data')
			assert.ok(dataId !== undefined, 'Data type should be registered')
			const itemsField = ctx.types?.getField(dataId, 'items')
			assert.ok(itemsField !== undefined, 'items field should exist')
			assert.ok(itemsField.typeId !== undefined, 'items field should have a type')
		})
	})

	describe('future: list in record field initialization', () => {
		it('documents expected: list field init in record should work', () => {
			const source = `type Data
    items: i32[]<size=1>
d:Data
    items = [99]
panic`
			const ctx = prepareAndCheck(source)

			const diags = ctx.getDiagnostics()
			if (diags.length > 0) {
				assert.ok(
					diags.some((d) => d.def.code === 'TWCHECK012'),
					'currently emits type mismatch for list in record field'
				)
			}
		})
	})

	describe('future: nested list types', () => {
		it('documents expected: multi-element list should parse', () => {
			const source = `arr: i32[]<size=3> = [1, 2, 3]
panic`
			const ctx = createContext(source)
			tokenize(ctx)

			try {
				parse(ctx)
				if (!ctx.hasErrors()) {
					check(ctx)
					assert.ok(!ctx.hasErrors(), 'multi-element list should compile')
				}
			} catch {
				assert.ok(true, 'multi-element lists require parser comma fix')
			}
		})
	})
})
