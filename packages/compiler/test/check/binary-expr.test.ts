import assert from 'node:assert'
import { describe, it } from 'node:test'

import { check } from '../../src/check/checker.ts'
import { InstKind } from '../../src/check/types.ts'
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

describe('check/binary expressions', () => {
	describe('arithmetic operators', () => {
		it('should compile i32 addition', () => {
			const ctx = compileAndCheck('x:i32 = 1 + 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 subtraction', () => {
			const ctx = compileAndCheck('x:i32 = 5 - 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 multiplication', () => {
			const ctx = compileAndCheck('x:i32 = 3 * 4\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 division', () => {
			const ctx = compileAndCheck('x:i32 = 10 / 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 modulo', () => {
			const ctx = compileAndCheck('x:i32 = 10 % 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 euclidean modulo', () => {
			const ctx = compileAndCheck('x:i32 = 10 %% 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i64 arithmetic', () => {
			const ctx = compileAndCheck('a:i64 = 100\nb:i64 = 50\nx:i64 = a + b\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile f32 arithmetic', () => {
			const ctx = compileAndCheck('a:f32 = 1.5\nb:f32 = 2.5\nx:f32 = a + b\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile f64 arithmetic', () => {
			const ctx = compileAndCheck('a:f64 = 1.5\nb:f64 = 2.5\nx:f64 = a * b\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should emit BinaryOp instruction', () => {
			const ctx = compileAndCheck('x:i32 = 1 + 2\n')
			assert.ok(ctx.insts)
			let hasBinaryOp = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.BinaryOp) hasBinaryOp = true
			}
			assert.ok(hasBinaryOp)
		})

		it('should error on modulo with float operand', () => {
			const ctx = compileAndCheck('a:f32 = 1.0\nb:f32 = 2.0\nx:f32 = a % b\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('integer')))
		})

		it('should error on euclidean modulo with float operand', () => {
			const ctx = compileAndCheck('a:f64 = 1.0\nb:f64 = 2.0\nx:f64 = a %% b\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('bitwise operators', () => {
		it('should compile bitwise AND', () => {
			const ctx = compileAndCheck('x:i32 = 5 & 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile bitwise OR', () => {
			const ctx = compileAndCheck('x:i32 = 5 | 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile bitwise XOR', () => {
			const ctx = compileAndCheck('x:i32 = 5 ^ 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile bitwise NOT', () => {
			const ctx = compileAndCheck('x:i32 = ~5\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile left shift', () => {
			const ctx = compileAndCheck('x:i32 = 1 << 4\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile right shift', () => {
			const ctx = compileAndCheck('x:i32 = 16 >> 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile unsigned right shift', () => {
			const ctx = compileAndCheck('x:i32 = 16 >>> 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should emit BitwiseNot instruction', () => {
			const ctx = compileAndCheck('x:i32 = ~5\n')
			assert.ok(ctx.insts)
			let hasBitwiseNot = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.BitwiseNot) hasBitwiseNot = true
			}
			assert.ok(hasBitwiseNot)
		})

		it('should compile i64 bitwise operations', () => {
			const ctx = compileAndCheck('a:i64 = 100\nb:i64 = 50\nx:i64 = a & b\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should error on bitwise AND with float operand', () => {
			const ctx = compileAndCheck('a:f32 = 1.0\nb:f32 = 2.0\nx:f32 = a & b\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should error on bitwise OR with float operand', () => {
			const ctx = compileAndCheck('a:f64 = 1.0\nb:f64 = 2.0\nx:f64 = a | b\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should error on bitwise NOT with float operand', () => {
			const ctx = compileAndCheck('a:f32 = 1.0\nx:f32 = ~a\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should error on shift with float operand', () => {
			const ctx = compileAndCheck('a:f32 = 1.0\nx:f32 = a << 2\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('comparison operators', () => {
		it('should compile less than', () => {
			const ctx = compileAndCheck('x:i32 = 1 < 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile greater than', () => {
			const ctx = compileAndCheck('x:i32 = 2 > 1\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile less equal', () => {
			const ctx = compileAndCheck('x:i32 = 1 <= 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile greater equal', () => {
			const ctx = compileAndCheck('x:i32 = 2 >= 1\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile equal equal', () => {
			const ctx = compileAndCheck('x:i32 = 1 == 1\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile not equal', () => {
			const ctx = compileAndCheck('x:i32 = 1 != 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile float comparison', () => {
			const ctx = compileAndCheck('a:f64 = 1.5\nb:f64 = 2.5\nx:i32 = a < b\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile comparison chain', () => {
			const ctx = compileAndCheck('x:i32 = 1 < 2 < 3\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})
	})

	describe('logical operators', () => {
		it('should compile logical AND', () => {
			const ctx = compileAndCheck('x:i32 = 1 && 2\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile logical OR', () => {
			const ctx = compileAndCheck('x:i32 = 0 || 1\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should emit LogicalAnd instruction', () => {
			const ctx = compileAndCheck('x:i32 = 1 && 2\n')
			assert.ok(ctx.insts)
			let hasLogicalAnd = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.LogicalAnd) hasLogicalAnd = true
			}
			assert.ok(hasLogicalAnd)
		})

		it('should emit LogicalOr instruction', () => {
			const ctx = compileAndCheck('x:i32 = 0 || 1\n')
			assert.ok(ctx.insts)
			let hasLogicalOr = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.LogicalOr) hasLogicalOr = true
			}
			assert.ok(hasLogicalOr)
		})
	})

	describe('type checking', () => {
		it('should error on type mismatch in binary expression', () => {
			const ctx = compileAndCheck('a:i32 = 1\nb:i64 = 2\nx:i32 = a + b\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should error on assigning wrong result type', () => {
			const ctx = compileAndCheck('a:i32 = 1\nb:i32 = 2\nx:i64 = a + b\n')
			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('precedence and associativity', () => {
		it('should respect multiplication over addition', () => {
			const result = compile('x:i32 = 1 + 2 * 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.mul'))
			assert.ok(result.text.includes('i32.add'))
		})

		it('should respect parentheses', () => {
			const result = compile('x:i32 = (1 + 2) * 3\npanic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should be left-associative for subtraction', () => {
			const result = compile('x:i32 = 10 - 3 - 2\npanic\n')
			assert.strictEqual(result.valid, true)
		})
	})
})
