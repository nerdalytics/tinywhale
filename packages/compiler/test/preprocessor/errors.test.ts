import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
	buildIndentContextMessage,
	IndentationError,
	throwIndentMismatchError,
	throwMixedIndentError,
} from '../../src/preprocessor/errors.ts'
import type { ProcessingState } from '../../src/preprocessor/state.ts'

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

describe('errors', () => {
	describe('IndentationError', () => {
		it('should create error with all properties', () => {
			const error = new IndentationError('test message', 5, 3, 'tab', 'space')
			assert.strictEqual(error.message, 'test message')
			assert.strictEqual(error.name, 'IndentationError')
			assert.strictEqual(error.line, 5)
			assert.strictEqual(error.column, 3)
			assert.strictEqual(error.expected, 'tab')
			assert.strictEqual(error.found, 'space')
		})

		it('should be instance of Error', () => {
			const error = new IndentationError('test', 1, 1, 'tab', 'space')
			assert.ok(error instanceof Error)
		})
	})

	describe('throwMixedIndentError', () => {
		it('should throw IndentationError', () => {
			assert.throws(() => throwMixedIndentError(1, 2, 'tab', 'space'), { name: 'IndentationError' })
		})

		it('should include line and column in error', () => {
			try {
				throwMixedIndentError(10, 5, 'tab', 'space')
			} catch (error) {
				const e = error as IndentationError
				assert.strictEqual(e.line, 10)
				assert.strictEqual(e.column, 5)
			}
		})

		it('should include expected and found types', () => {
			try {
				throwMixedIndentError(1, 1, 'space', 'tab')
			} catch (error) {
				const e = error as IndentationError
				assert.strictEqual(e.expected, 'space')
				assert.strictEqual(e.found, 'tab')
			}
		})
	})

	describe('buildIndentContextMessage', () => {
		it('should build message for default directive mode', () => {
			const state = createMockState({
				indentEstablishedAt: { line: 0, source: 'directive' },
			})
			const message = buildIndentContextMessage('tabs', state)
			assert.ok(message.includes('by default'))
		})

		it('should build message for explicit directive', () => {
			const state = createMockState({
				indentEstablishedAt: { line: 5, source: 'directive' },
			})
			const message = buildIndentContextMessage('spaces', state)
			assert.ok(message.includes('directive on line 5'))
		})

		it('should build message for detected indent', () => {
			const state = createMockState({
				indentEstablishedAt: { line: 3, source: 'detected' },
			})
			const message = buildIndentContextMessage('tabs', state)
			assert.ok(message.includes('first indented line: 3'))
		})
	})

	describe('throwIndentMismatchError', () => {
		it('should throw IndentationError', () => {
			const state = createMockState({
				indentEstablishedAt: { line: 1, source: 'detected' },
			})
			assert.throws(() => throwIndentMismatchError(5, 'tab', 'space', state), {
				name: 'IndentationError',
			})
		})

		it('should include context in message', () => {
			const state = createMockState({
				indentEstablishedAt: { line: 2, source: 'detected' },
			})
			try {
				throwIndentMismatchError(5, 'tab', 'space', state)
			} catch (error) {
				const e = error as IndentationError
				assert.ok(e.message.includes('first indented line'))
			}
		})
	})
})
