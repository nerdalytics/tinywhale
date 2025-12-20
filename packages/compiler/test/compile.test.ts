import assert from 'node:assert'
import { describe, it } from 'node:test'
import { compile, CompileError } from '../src/index.ts'

describe('compile (unified API)', () => {
	describe('basic compilation', () => {
		it('should compile single panic statement', () => {
			const result = compile('panic\n')

			assert.strictEqual(result.valid, true)
			assert.ok(result.binary instanceof Uint8Array)
			assert.ok(result.binary.length > 0)
			assert.ok(result.text.includes('unreachable'))
		})

		it('should compile multiple statements', () => {
			const result = compile('panic\npanic\n')

			assert.strictEqual(result.valid, true)
			const unreachableCount = (result.text.match(/unreachable/g) || []).length
			assert.strictEqual(unreachableCount, 2)
		})

		it('should compile without trailing newline', () => {
			const result = compile('panic')

			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('unreachable'))
		})
	})

	describe('error handling', () => {
		it('should throw CompileError for empty program', () => {
			assert.throws(
				() => compile(''),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('Empty program'))
					return true
				}
			)
		})

		it('should throw CompileError for comment-only program', () => {
			assert.throws(
				() => compile('# just a comment\n'),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					assert.ok(err.message.includes('Empty program'))
					return true
				}
			)
		})

		it('should throw CompileError for mixed indentation', () => {
			assert.throws(
				() => compile('panic\n\tpanic\n  panic'),
				(err: Error) => {
					assert.ok(err instanceof CompileError)
					return true
				}
			)
		})
	})

	describe('optimization', () => {
		it('should compile without optimization by default', () => {
			const result = compile('panic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should compile with optimization when enabled', () => {
			const result = compile('panic\n', { optimize: true })
			assert.strictEqual(result.valid, true)
		})
	})

	describe('output format', () => {
		it('should have correct WASM magic number', () => {
			const result = compile('panic')

			assert.strictEqual(result.binary[0], 0x00)
			assert.strictEqual(result.binary[1], 0x61)
			assert.strictEqual(result.binary[2], 0x73)
			assert.strictEqual(result.binary[3], 0x6d)
		})

		it('should export _start function', () => {
			const result = compile('panic')
			assert.ok(result.text.includes('(export "_start"'))
		})
	})
})
