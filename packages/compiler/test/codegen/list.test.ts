import assert from 'node:assert'
import { describe, it } from 'node:test'
import { check } from '../../src/check/checker.ts'
import { emit } from '../../src/codegen/index.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

/**
 * Unit tests for list codegen - complex expressions and edge cases.
 *
 * Property tests in list-types.property.test.ts cover:
 * - Flattened local counts (N elements → N locals)
 * - Literal values appearing in WAT
 * - local.set and local.get emission
 * - Type-specific arithmetic operations
 * - WASM validity and determinism
 *
 * These unit tests cover:
 * - Unary operators on list elements
 * - Complex multi-operator expressions
 * - Specific WASM instruction verification
 * - Short-circuit logical operations
 */

function compileToWat(source: string): string {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	const result = emit(ctx)
	return result.text
}

describe('codegen/list', () => {
	describe('list element with unary operators', () => {
		it('should emit negation of list element', () => {
			const source = `arr: i32[]<size=1> = [42]
neg: i32 = -arr[0]
panic`
			const wat = compileToWat(source)

			assert.ok(wat.includes('i32.sub'), 'should emit i32.sub for negation')
		})

		it('should emit bitwise NOT of list element', () => {
			const source = `arr: i32[]<size=1> = [255]
inv: i32 = ~arr[0]
panic`
			const wat = compileToWat(source)

			assert.ok(wat.includes('i32.xor'), 'should emit i32.xor for bitwise NOT')
		})
	})

	describe('list element in complex expressions', () => {
		it('should emit chained arithmetic with list elements', () => {
			const source = `arr: i32[]<size=1> = [10]
result: i32 = arr[0] + 5 - 3
panic`
			const wat = compileToWat(source)

			assert.ok(wat.includes('i32.add'), 'should emit i32.add')
			assert.ok(wat.includes('i32.sub'), 'should emit i32.sub')
		})

		it('should emit comparison with list element', () => {
			const source = `arr: i32[]<size=1> = [10]
isLess: i32 = arr[0] < 20
panic`
			const wat = compileToWat(source)

			assert.ok(wat.includes('i32.lt_s'), 'should emit i32.lt_s for comparison')
		})

		it('should emit logical operation with list element', () => {
			const source = `arr: i32[]<size=1> = [1]
result: i32 = arr[0] && 1
panic`
			const wat = compileToWat(source)

			assert.ok(wat.includes('if'), 'should emit if for short-circuit AND')
		})
	})
})
