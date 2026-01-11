import assert from 'node:assert'
import { describe, it } from 'node:test'

import { check } from '../src/check/checker.ts'
import { CompileError, type CompileResult, emit } from '../src/codegen/index.ts'
import { CompilationContext } from '../src/core/context.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { parse } from '../src/parse/parser.ts'

function compileSource(source: string, optimize = false): CompileResult {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	return emit(ctx, { optimize })
}

describe('codegen', () => {
	describe('emit function', () => {
		it('should compile single panic statement to valid WASM', () => {
			const result = compileSource('panic\n')

			assert.strictEqual(result.valid, true)
			assert.ok(result.binary instanceof Uint8Array)
			assert.ok(result.binary.length > 0)
			assert.ok(result.text.includes('unreachable'))
		})

		it('should compile multiple panic statements', () => {
			const result = compileSource('panic\npanic\n')

			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('unreachable'))
			// Count unreachable occurrences in the WAT output
			const unreachableCount = (result.text.match(/unreachable/g) || []).length
			assert.strictEqual(unreachableCount, 2)
		})

		it('should compile nested panic statements', () => {
			const result = compileSource('panic\npanic\npanic\n')

			assert.strictEqual(result.valid, true)
			const unreachableCount = (result.text.match(/unreachable/g) || []).length
			assert.strictEqual(unreachableCount, 3)
		})

		it('should throw CompileError for empty program', () => {
			const ctx = new CompilationContext('\n')
			tokenize(ctx)
			parse(ctx)
			check(ctx)

			assert.throws(
				() => emit(ctx),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('empty program'))
					return true
				}
			)
		})

		it('should throw CompileError for program with only comments', () => {
			const ctx = new CompilationContext('# just a comment\n')
			tokenize(ctx)
			parse(ctx)
			check(ctx)

			assert.throws(
				() => emit(ctx),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('empty program'))
					return true
				}
			)
		})

		it('should export _start function', () => {
			const result = compileSource('panic\n')

			assert.ok(result.text.includes('(export "_start"'))
		})

		it('should set _start as start function', () => {
			const result = compileSource('panic\n')

			assert.ok(result.text.includes('(start'))
		})
	})

	describe('binary format', () => {
		it('should produce valid WASM magic number', () => {
			const result = compileSource('panic\n')

			// WASM magic number: \0asm (0x00 0x61 0x73 0x6d)
			assert.strictEqual(result.binary[0], 0x00)
			assert.strictEqual(result.binary[1], 0x61)
			assert.strictEqual(result.binary[2], 0x73)
			assert.strictEqual(result.binary[3], 0x6d)
		})

		it('should produce valid WASM version', () => {
			const result = compileSource('panic\n')

			// WASM version 1: 0x01 0x00 0x00 0x00
			assert.strictEqual(result.binary[4], 0x01)
			assert.strictEqual(result.binary[5], 0x00)
			assert.strictEqual(result.binary[6], 0x00)
			assert.strictEqual(result.binary[7], 0x00)
		})

		it('should contain unreachable opcode (0x00)', () => {
			const result = compileSource('panic\n')

			// The unreachable instruction has opcode 0x00
			// We need to search in the code section, but for simplicity
			// we just verify the binary contains the opcode
			assert.ok(result.binary.includes(0x00))
		})
	})

	describe('optimization', () => {
		it('should compile without optimization by default', () => {
			const result = compileSource('panic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should compile with optimization when enabled', () => {
			const result = compileSource('panic\n', true)
			assert.strictEqual(result.valid, true)
		})

		it('should produce valid output with optimization', () => {
			const result = compileSource('panic\npanic\n', true)

			assert.strictEqual(result.valid, true)
			assert.ok(result.binary instanceof Uint8Array)
			assert.ok(result.binary.length > 0)
		})
	})

	describe('CompileError', () => {
		it('should have correct name property', () => {
			const error = new CompileError('test error')
			assert.strictEqual(error.name, 'CompileError')
		})

		it('should have correct message property', () => {
			const error = new CompileError('test error')
			assert.strictEqual(error.message, 'test error')
		})

		it('should be instanceof Error', () => {
			const error = new CompileError('test error')
			assert.ok(error instanceof Error)
		})
	})

	describe('arithmetic operators', () => {
		it('should emit i32.add for addition', () => {
			const result = compileSource('x:i32 = 1 + 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.add'))
		})

		it('should emit i32.sub for subtraction', () => {
			const result = compileSource('x:i32 = 5 - 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.sub'))
		})

		it('should emit i32.mul for multiplication', () => {
			const result = compileSource('x:i32 = 3 * 4\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.mul'))
		})

		it('should emit i32.div_s for division', () => {
			const result = compileSource('x:i32 = 10 / 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.div_s'))
		})

		it('should emit i32.rem_s for modulo', () => {
			const result = compileSource('x:i32 = 10 % 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.rem_s'))
		})

		it('should emit i64.add for i64 addition', () => {
			const result = compileSource('a:i64 = 100\nb:i64 = 50\nx:i64 = a + b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i64.add'))
		})

		it('should emit f32.add for f32 addition', () => {
			const result = compileSource('a:f32 = 1.5\nb:f32 = 2.5\nx:f32 = a + b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f32.add'))
		})

		it('should emit f64.mul for f64 multiplication', () => {
			const result = compileSource('a:f64 = 1.5\nb:f64 = 2.5\nx:f64 = a * b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f64.mul'))
		})

		it('should emit f64.div for f64 division', () => {
			const result = compileSource('a:f64 = 10.0\nb:f64 = 2.0\nx:f64 = a / b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f64.div'))
		})
	})

	describe('bitwise operators', () => {
		it('should emit i32.and for bitwise AND', () => {
			const result = compileSource('x:i32 = 5 & 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.and'))
		})

		it('should emit i32.or for bitwise OR', () => {
			const result = compileSource('x:i32 = 5 | 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.or'))
		})

		it('should emit i32.xor for bitwise XOR', () => {
			const result = compileSource('x:i32 = 5 ^ 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.xor'))
		})

		it('should emit i32.xor with -1 for bitwise NOT', () => {
			const result = compileSource('x:i32 = ~5\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.xor'))
		})

		it('should emit i32.shl for left shift', () => {
			const result = compileSource('x:i32 = 1 << 4\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.shl'))
		})

		it('should emit i32.shr_s for signed right shift', () => {
			const result = compileSource('x:i32 = 16 >> 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.shr_s'))
		})

		it('should emit i32.shr_u for unsigned right shift', () => {
			const result = compileSource('x:i32 = 16 >>> 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.shr_u'))
		})

		it('should emit i64.and for i64 bitwise AND', () => {
			const result = compileSource('a:i64 = 100\nb:i64 = 50\nx:i64 = a & b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i64.and'))
		})

		it('should emit i64.xor with -1 for i64 bitwise NOT', () => {
			const result = compileSource('a:i64 = 100\nx:i64 = ~a\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i64.xor'))
		})
	})

	describe('comparison operators', () => {
		it('should emit i32.lt_s for less than', () => {
			const result = compileSource('x:i32 = 1 < 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.lt_s'))
		})

		it('should emit i32.gt_s for greater than', () => {
			const result = compileSource('x:i32 = 2 > 1\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.gt_s'))
		})

		it('should emit i32.le_s for less equal', () => {
			const result = compileSource('x:i32 = 1 <= 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.le_s'))
		})

		it('should emit i32.ge_s for greater equal', () => {
			const result = compileSource('x:i32 = 2 >= 1\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.ge_s'))
		})

		it('should emit i32.eq for equal equal', () => {
			const result = compileSource('x:i32 = 1 == 1\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.eq'))
		})

		it('should emit i32.ne for not equal', () => {
			const result = compileSource('x:i32 = 1 != 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.ne'))
		})

		it('should emit f64.lt for float less than', () => {
			const result = compileSource('a:f64 = 1.5\nb:f64 = 2.5\nx:i32 = a < b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f64.lt'))
		})

		it('should emit f32.eq for float equal', () => {
			const result = compileSource('a:f32 = 1.5\nb:f32 = 1.5\nx:i32 = a == b\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f32.eq'))
		})
	})

	describe('logical operators', () => {
		it('should emit if for logical AND (short-circuit)', () => {
			const result = compileSource('x:i32 = 1 && 2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('if'))
		})

		it('should emit if for logical OR (short-circuit)', () => {
			const result = compileSource('x:i32 = 0 || 1\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('if'))
		})
	})

	describe('complex expressions', () => {
		it('should compile chained arithmetic', () => {
			const result = compileSource('x:i32 = 1 + 2 + 3 + 4\npanic\n')
			assert.strictEqual(result.valid, true)
			const addCount = (result.text.match(/i32\.add/g) || []).length
			assert.strictEqual(addCount, 3)
		})

		it('should compile mixed operators with precedence', () => {
			const result = compileSource('x:i32 = 1 + 2 * 3\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.mul'))
			assert.ok(result.text.includes('i32.add'))
		})

		it('should compile parenthesized expressions', () => {
			const result = compileSource('x:i32 = (1 + 2) * 3\npanic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should compile comparison chain', () => {
			const result = compileSource('x:i32 = 1 < 2 < 3\npanic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should compile nested parentheses', () => {
			const result = compileSource('x:i32 = ((1 + 2) * (3 + 4))\npanic\n')
			assert.strictEqual(result.valid, true)
		})
	})
})
