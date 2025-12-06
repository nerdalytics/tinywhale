import assert from 'node:assert'
import { describe, it } from 'node:test'
import { createProcessingState } from '../../src/preprocessor/state.ts'

describe('state', () => {
	describe('createProcessingState', () => {
		it('should create detect mode state with null indent type', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.mode, 'detect')
			assert.strictEqual(state.expectedIndentType, null)
			assert.strictEqual(state.indentEstablishedAt, null)
		})

		it('should create directive mode state with tab default', () => {
			const state = createProcessingState('directive')
			assert.strictEqual(state.mode, 'directive')
			assert.strictEqual(state.expectedIndentType, 'tab')
			assert.deepStrictEqual(state.indentEstablishedAt, { line: 0, source: 'directive' })
		})

		it('should initialize line number to 0', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.lineNumber, 0)
		})

		it('should initialize empty buffered lines', () => {
			const state = createProcessingState('detect')
			assert.deepStrictEqual(state.bufferedLines, [])
		})

		it('should initialize isFirstChunk to true', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.isFirstChunk, true)
		})

		it('should initialize previousLevel to 0', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.previousLevel, 0)
		})

		it('should initialize previousSpaces to 0', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.previousSpaces, 0)
		})

		it('should initialize indentUnit to null', () => {
			const state = createProcessingState('detect')
			assert.strictEqual(state.indentUnit, null)
		})
	})
})
