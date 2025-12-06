import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { ProcessingState } from '../../src/preprocessor/state.ts'
import {
	handleSpaceIndentDelta,
	validateIndent,
	validateIndentJump,
	validateSpaceDedent,
	validateSpaceIndent,
} from '../../src/preprocessor/validation.ts'

function createMockState(overrides: Partial<ProcessingState> = {}): ProcessingState {
	return {
		bufferedLines: [],
		directiveFound: false,
		directiveLine: null,
		expectedIndentType: null,
		indentEstablishedAt: null,
		indentUnit: null,
		isFirstChunk: true,
		lineNumber: 0,
		mode: 'detect',
		previousLevel: 0,
		previousSpaces: 0,
		...overrides,
	}
}

describe('validation', () => {
	describe('validateIndent', () => {
		it('should do nothing for null indent type', () => {
			const state = createMockState()
			validateIndent({ count: 0, type: null }, 1, state)
			assert.strictEqual(state.expectedIndentType, null)
		})

		it('should establish indent type on first indented line', () => {
			const state = createMockState()
			validateIndent({ count: 1, type: 'tab' }, 2, state)
			assert.strictEqual(state.expectedIndentType, 'tab')
			assert.deepStrictEqual(state.indentEstablishedAt, { line: 2, source: 'detected' })
		})

		it('should allow matching indent type', () => {
			const state = createMockState({
				expectedIndentType: 'space',
				indentEstablishedAt: { line: 1, source: 'detected' },
			})
			assert.doesNotThrow(() => {
				validateIndent({ count: 2, type: 'space' }, 2, state)
			})
		})

		it('should throw on mismatched indent type', () => {
			const state = createMockState({
				expectedIndentType: 'tab',
				indentEstablishedAt: { line: 1, source: 'detected' },
			})
			assert.throws(() => validateIndent({ count: 2, type: 'space' }, 3, state), {
				name: 'IndentationError',
			})
		})
	})

	describe('validateSpaceIndent', () => {
		it('should set indent unit on first indent', () => {
			const state = createMockState()
			validateSpaceIndent(2, 1, state)
			assert.strictEqual(state.indentUnit, 2)
		})

		it('should allow matching indent unit', () => {
			const state = createMockState({ indentUnit: 4 })
			assert.doesNotThrow(() => {
				validateSpaceIndent(4, 2, state)
			})
		})

		it('should throw on inconsistent indent unit', () => {
			const state = createMockState({ indentUnit: 2 })
			assert.throws(() => validateSpaceIndent(4, 3, state), { name: 'IndentationError' })
		})
	})

	describe('validateSpaceDedent', () => {
		it('should do nothing when indentUnit is null', () => {
			const state = createMockState()
			assert.doesNotThrow(() => {
				validateSpaceDedent({ count: 3, type: 'space' }, 1, state)
			})
		})

		it('should allow valid dedent (aligned to unit)', () => {
			const state = createMockState({ indentUnit: 2, previousSpaces: 4 })
			assert.doesNotThrow(() => {
				validateSpaceDedent({ count: 2, type: 'space' }, 3, state)
			})
		})

		it('should throw on misaligned dedent', () => {
			const state = createMockState({ indentUnit: 2, previousSpaces: 4 })
			assert.throws(() => validateSpaceDedent({ count: 3, type: 'space' }, 3, state), {
				name: 'IndentationError',
			})
		})
	})

	describe('validateIndentJump', () => {
		it('should allow single level increase', () => {
			assert.doesNotThrow(() => {
				validateIndentJump(1, 0, 2, { count: 1, type: 'tab' })
			})
		})

		it('should allow same level', () => {
			assert.doesNotThrow(() => {
				validateIndentJump(2, 2, 3, { count: 2, type: 'tab' })
			})
		})

		it('should allow decrease', () => {
			assert.doesNotThrow(() => {
				validateIndentJump(0, 3, 4, { count: 0, type: null })
			})
		})

		it('should throw on multi-level jump', () => {
			assert.throws(() => validateIndentJump(3, 1, 5, { count: 3, type: 'tab' }), {
				name: 'IndentationError',
			})
		})
	})

	describe('handleSpaceIndentDelta', () => {
		it('should call validateSpaceIndent for positive delta', () => {
			const state = createMockState({ previousSpaces: 0 })
			handleSpaceIndentDelta({ count: 2, type: 'space' }, 1, state)
			assert.strictEqual(state.indentUnit, 2)
		})

		it('should call validateSpaceDedent for negative delta', () => {
			const state = createMockState({ indentUnit: 2, previousSpaces: 4 })
			assert.doesNotThrow(() => {
				handleSpaceIndentDelta({ count: 2, type: 'space' }, 3, state)
			})
		})

		it('should do nothing for zero delta', () => {
			const state = createMockState({ previousSpaces: 4 })
			assert.doesNotThrow(() => {
				handleSpaceIndentDelta({ count: 4, type: 'space' }, 2, state)
			})
		})
	})
})
