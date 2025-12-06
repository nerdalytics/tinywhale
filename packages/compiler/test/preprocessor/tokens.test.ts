import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
	createDedentToken,
	createIndentToken,
	formatPosition,
} from '../../src/preprocessor/tokens.ts'

describe('tokens', () => {
	describe('formatPosition', () => {
		it('should format position as ⟨line,level⟩', () => {
			assert.strictEqual(formatPosition({ level: 0, line: 1 }), '⟨1,0⟩')
		})

		it('should handle large numbers', () => {
			assert.strictEqual(formatPosition({ level: 42, line: 999 }), '⟨999,42⟩')
		})
	})

	describe('createIndentToken', () => {
		it('should create INDENT token with position', () => {
			assert.strictEqual(createIndentToken({ level: 1, line: 2 }), '⟨2,1⟩⇥')
		})

		it('should include arrow character', () => {
			const token = createIndentToken({ level: 0, line: 1 })
			assert.ok(token.includes('⇥'))
		})
	})

	describe('createDedentToken', () => {
		it('should create DEDENT token with position', () => {
			assert.strictEqual(createDedentToken({ level: 0, line: 4 }), '⟨4,0⟩⇤')
		})

		it('should include arrow character', () => {
			const token = createDedentToken({ level: 0, line: 1 })
			assert.ok(token.includes('⇤'))
		})
	})
})
