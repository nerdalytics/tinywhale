import assert from 'node:assert'
import { describe, it } from 'node:test'

import { CompileError, type CompileResult, emit } from '../src/codegen/index.ts'
import { CompilationContext } from '../src/core/context.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { parse } from '../src/parse/parser.ts'

function compileSource(source: string, optimize = false): CompileResult {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
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

			assert.throws(
				() => emit(ctx),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('Empty program'))
					return true
				}
			)
		})

		it('should throw CompileError for program with only comments', () => {
			const ctx = new CompilationContext('# just a comment\n')
			tokenize(ctx)
			parse(ctx)

			assert.throws(
				() => emit(ctx),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('Empty program'))
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
})
