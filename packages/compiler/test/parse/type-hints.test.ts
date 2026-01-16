import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

describe('parse/type-hints', () => {
	describe('grammar recognition', () => {
		it('parses i32<min=0>', () => {
			const source = 'x: i32<min=0> = 5\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = parse(ctx)
			assert.ok(result.succeeded, 'should parse successfully')
		})

		it('parses i32<max=100>', () => {
			const source = 'x: i32<max=100> = 5\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = parse(ctx)
			assert.ok(result.succeeded, 'should parse successfully')
		})

		it('parses i32<min=0, max=100>', () => {
			const source = 'x: i32<min=0, max=100> = 50\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = parse(ctx)
			assert.ok(result.succeeded, 'should parse successfully')
		})

		it('parses i64<min=-1000>', () => {
			const source = 'x: i64<min=-1000> = 0\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = parse(ctx)
			assert.ok(result.succeeded, 'should parse successfully')
		})
	})
})
