import assert from 'node:assert'
import { describe, it } from 'node:test'
import { classifyWhitespace, updateIndentType } from '../../src/preprocessor/whitespace.ts'

describe('whitespace', () => {
	describe('classifyWhitespace', () => {
		it('should return tab for tab character', () => {
			assert.strictEqual(classifyWhitespace('\t'), 'tab')
		})

		it('should return space for space character', () => {
			assert.strictEqual(classifyWhitespace(' '), 'space')
		})

		it('should return null for non-whitespace', () => {
			assert.strictEqual(classifyWhitespace('a'), null)
		})

		it('should return null for empty string', () => {
			assert.strictEqual(classifyWhitespace(''), null)
		})

		it('should return null for newline', () => {
			assert.strictEqual(classifyWhitespace('\n'), null)
		})
	})

	describe('updateIndentType', () => {
		it('should return found type when current is null', () => {
			assert.strictEqual(updateIndentType(null, 'tab', 1, 1), 'tab')
			assert.strictEqual(updateIndentType(null, 'space', 1, 1), 'space')
		})

		it('should return current when types match', () => {
			assert.strictEqual(updateIndentType('tab', 'tab', 1, 1), 'tab')
			assert.strictEqual(updateIndentType('space', 'space', 1, 1), 'space')
		})

		it('should throw on mixed indentation', () => {
			assert.throws(() => updateIndentType('tab', 'space', 1, 2), { name: 'IndentationError' })
			assert.throws(() => updateIndentType('space', 'tab', 1, 3), { name: 'IndentationError' })
		})
	})
})
