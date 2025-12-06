import assert from 'node:assert'
import { describe, it } from 'node:test'
import { analyzeLineIndent, parseDirective } from '../../src/preprocessor/analysis.ts'

describe('analysis', () => {
	describe('analyzeLineIndent', () => {
		it('should return count 0 for empty line', () => {
			const result = analyzeLineIndent('', 1)
			assert.deepStrictEqual(result, { count: 0, type: null })
		})

		it('should return count 0 for line with no indentation', () => {
			const result = analyzeLineIndent('hello', 1)
			assert.deepStrictEqual(result, { count: 0, type: null })
		})

		it('should count leading tabs', () => {
			const result = analyzeLineIndent('\t\tfoo', 1)
			assert.deepStrictEqual(result, { count: 2, type: 'tab' })
		})

		it('should count leading spaces', () => {
			const result = analyzeLineIndent('    bar', 1)
			assert.deepStrictEqual(result, { count: 4, type: 'space' })
		})

		it('should handle tab-only line', () => {
			const result = analyzeLineIndent('\t', 1)
			assert.deepStrictEqual(result, { count: 1, type: 'tab' })
		})

		it('should handle space-only line', () => {
			const result = analyzeLineIndent('  ', 1)
			assert.deepStrictEqual(result, { count: 2, type: 'space' })
		})

		it('should throw on mixed indentation (tab then space)', () => {
			assert.throws(() => analyzeLineIndent('\t foo', 1), { name: 'IndentationError' })
		})

		it('should throw on mixed indentation (space then tab)', () => {
			assert.throws(() => analyzeLineIndent(' \tfoo', 1), { name: 'IndentationError' })
		})

		it('should include line number in error', () => {
			try {
				analyzeLineIndent('\t foo', 42)
				assert.fail('Should have thrown')
			} catch (error) {
				assert.strictEqual((error as { line: number }).line, 42)
			}
		})
	})

	describe('parseDirective', () => {
		it('should parse double-quoted use spaces', () => {
			assert.strictEqual(parseDirective('"use spaces"'), 'space')
		})

		it('should parse single-quoted use spaces', () => {
			assert.strictEqual(parseDirective("'use spaces'"), 'space')
		})

		it('should handle leading/trailing whitespace', () => {
			assert.strictEqual(parseDirective('  "use spaces"  '), 'space')
		})

		it('should return null for non-directive', () => {
			assert.strictEqual(parseDirective('hello'), null)
		})

		it('should return null for partial match', () => {
			assert.strictEqual(parseDirective('"use tabs"'), null)
		})

		it('should return null for empty string', () => {
			assert.strictEqual(parseDirective(''), null)
		})
	})
})
