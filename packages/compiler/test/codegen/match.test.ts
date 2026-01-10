import assert from 'node:assert'
import { describe, it } from 'node:test'
import { check } from '../../src/check/checker.ts'
import { emit } from '../../src/codegen/index.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

function compileToWat(source: string): string {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	const result = emit(ctx)
	return result.text
}

describe('codegen/match', () => {
	describe('basic match expression', () => {
		it('should generate if/else for literal patterns', () => {
			const source = `x: i32 = 1
result: i32 = match x
	0 -> 100
	1 -> 200
	_ -> 0
`
			const wat = compileToWat(source)

			// Should contain if expressions
			assert.ok(wat.includes('if'), 'should generate if expression')
			// Should contain comparisons to 0 and 1
			assert.ok(wat.includes('i32.eq'), 'should generate equality comparisons')
		})

		it('should generate simple return for wildcard-only match', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
`
			const wat = compileToWat(source)

			// Should just set the local without if/else
			assert.ok(!wat.includes('if'), 'should not generate if for wildcard-only match')
		})

		it('should generate or-pattern as multiple comparisons', () => {
			const source = `x: i32 = 2
result: i32 = match x
	0 | 1 -> 10
	2 | 3 -> 20
	_ -> 0
`
			const wat = compileToWat(source)

			// Should contain if expressions
			assert.ok(wat.includes('if'), 'should generate if expression')
			// Should contain i32.or for the or-pattern
			assert.ok(wat.includes('i32.or'), 'should generate or for or-patterns')
		})

		it('should generate negative literal comparisons', () => {
			const source = `x: i32 = -1
result: i32 = match x
	-1 -> 100
	0 -> 200
	_ -> 0
`
			const wat = compileToWat(source)

			// Should contain if expressions
			assert.ok(wat.includes('if'), 'should generate if expression')
			// Should contain comparison to -1
			assert.ok(wat.includes('i32.const -1'), 'should generate negative constant')
		})
	})
})
